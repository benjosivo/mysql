import { randomUUID } from 'crypto';
import * as parserModule from 'node-sql-parser';
import mysql from 'mysql2/promise';

export interface MySQLClientConfig {
    host: string;
    user: string;
    password: string;
    database: string;
    waitForConnections?: boolean;
    connectionLimit?: number;
    queueLimit?: number;
    multipleStatements?: boolean;
    /** How long an open transaction can sit idle before it's automatically rolled back. Default: 5 minutes. */
    staleTransactionMs?: number;
    /**
     * Default per-statement timeout, in ms. Applied to every query that doesn't pass its own
     * `timeoutMs`. Off by default — a statement waits as long as MySQL lets it.
     */
    defaultQueryTimeoutMs?: number;
    /** Called whenever this client encounters an error it can't throw directly (e.g. inside retry loops). Defaults to console.error. */
    onError?: (error: unknown, context: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Result types                                                               */
/* -------------------------------------------------------------------------- */

export interface MySQLFieldType {
    fieldName: string;
    fieldType: string;
}

export interface MySQLQueryOptions {
    query: string;
    values?: any[];
    /** `true` opens a new transaction, a string runs inside the transaction with that key. */
    connKey?: boolean | string;
    returnFieldTypes?: boolean;
    returnListTables?: boolean | string;
    /** Per-statement timeout in ms. Falls back to `defaultQueryTimeoutMs`; 0/undefined disables it. */
    timeoutMs?: number;
}

/** Where a failure happened, so callers can tell a dead transaction from a rejected statement. */
export type MySQLFailureStage = 'not-initialized' | 'invalid-input' | 'transaction-create' | 'transaction-lookup' | 'execute' | 'procedure';

export interface MySQLQuerySuccess<T> {
    ok: true;
    rows: T;
    /** Populated when `returnFieldTypes` was requested, `[]` otherwise. */
    fieldsType: MySQLFieldType[];
    /** Populated when `returnListTables` was requested, `[]` otherwise. */
    tables: string[];
    /** The transaction this ran in, `null` when it ran straight on the pool. */
    connKey: string | null;
}

export interface MySQLQueryFailure {
    ok: false;
    /** Always a non-empty message — never undefined, never an empty string. */
    error: string;
    stage: MySQLFailureStage;
    /** MySQL / driver error code, e.g. `ER_DUP_ENTRY`, `ECONNRESET`, `ETIMEDOUT`. */
    code?: string;
    errno?: number;
    sqlState?: string;
    values: any[];
    connKey: string | null;
    /** The original error, untouched, for logging. */
    cause?: unknown;
}

export type MySQLQueryResult<T = any> = MySQLQuerySuccess<T> | MySQLQueryFailure;

/* -------------------------------------------------------------------------- */
/* Client state                                                               */
/* -------------------------------------------------------------------------- */

const DEADLOCK_RETRY_DELAY_MS = 100;
const LOCK_TIMEOUT_RETRY_DELAY_MS = 500;
const TRANSIENT_RETRY_DELAY_MS = 100;
const MAX_EXECUTE_ATTEMPTS = 5;
const POOL_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STALE_TRANSACTION_MS = 5 * 60_000;

let config: MySQLClientConfig | undefined;
let pool: mysql.Pool | undefined;
let lastConnectionCheck = 0;

function defaultOnError(error: unknown, context: string) {
    console.error(`[mysql-client] ${context}`, error);
}

function handleError(error: unknown, context: string) {
    try {
        (config?.onError ?? defaultOnError)(error, context);
    } catch {
        // A broken onError hook must never take down the query that reported through it.
    }
}

function requireConfig(): MySQLClientConfig {
    if (!config) throw new Error('MySQL client not initialized. Call init(config) before using this package.');
    return config;
}

function requirePool(): mysql.Pool {
    if (!pool) throw new Error('MySQL client not initialized. Call init(config) before using this package.');
    return pool;
}

function createPool() {
    const cfg = requireConfig();
    pool = mysql.createPool({
        host: cfg.host,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        waitForConnections: cfg.waitForConnections ?? true,
        connectionLimit: cfg.connectionLimit ?? 50,
        queueLimit: cfg.queueLimit ?? 0,
        multipleStatements: cfg.multipleStatements ?? true,
    });
}

export async function init(clientConfig: MySQLClientConfig): Promise<void> {
    if (pool) await closeMySQLConnection();
    config = clientConfig;
    createPool();
    loopKillOpenTRX();
}

export async function closeMySQLConnection() {
    stopLoopKillOpenTRX();

    if (!pool) return;

    const rollbackPromises = [...listTransaction.keys()].map(connectionRollback);
    await Promise.all(rollbackPromises);
    listTransaction.clear();

    try {
        await pool.end();
    } catch {}

    pool = undefined;
    config = undefined;
    lastConnectionCheck = 0;
    ensurePoolPromise = null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Errors worth retrying: the statement was rejected by something temporary
 * (a lock, a saturated server, a dropped socket) rather than by its own content.
 * Deterministic failures — bad syntax, duplicate keys, constraint violations,
 * missing columns, denied access — are returned on the first attempt, because
 * re-sending them can only ever produce the same error.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
    // MySQL-side contention / resource pressure
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT',
    'ER_LOCK_TABLE_FULL',
    'ER_TOO_MANY_USER_CONNECTIONS',
    'ER_CON_COUNT_ERROR',
    'ER_OUT_OF_RESOURCES',
    // driver / socket level
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'PROTOCOL_SEQUENCE_TIMEOUT',
    'PROTOCOL_PACKETS_OUT_OF_ORDER',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
]);

function isTransientError(error: any): boolean {
    // Our own timeout: the statement was killed on purpose, so re-running it would
    // just burn another full timeout (and could double-apply a write).
    if (error?.isQueryTimeout === true) return false;
    if (typeof error?.code === 'string' && TRANSIENT_ERROR_CODES.has(error.code)) return true;
    return error?.fatal === true;
}

function isConnectionLost(error: any): boolean {
    return (
        error?.code === 'PROTOCOL_CONNECTION_LOST' ||
        error?.code === 'ECONNRESET' ||
        error?.code === 'ECONNREFUSED' ||
        error?.code === 'EPIPE' ||
        error?.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
        error?.fatal === true
    );
}

/** Always returns a usable, non-empty message — that's what `MySQLQueryFailure.error` promises. */
function describeError(error: unknown): string {
    if (typeof error === 'string' && error.length > 0) return error;
    const message = (error as any)?.message;
    if (typeof message === 'string' && message.length > 0) return message;
    const code = (error as any)?.code;
    if (typeof code === 'string' && code.length > 0) return code;
    try {
        const text = String(error);
        if (text && text !== '[object Object]' && text !== 'undefined' && text !== 'null') return text;
    } catch {}
    return 'Unknown MySQL error';
}

function errorDetails(error: any): { code?: string; errno?: number; sqlState?: string } {
    const details: { code?: string; errno?: number; sqlState?: string } = {};
    if (typeof error?.code === 'string') details.code = error.code;
    if (typeof error?.errno === 'number') details.errno = error.errno;
    if (typeof error?.sqlState === 'string') details.sqlState = error.sqlState;
    return details;
}

function fail(stage: MySQLFailureStage, error: unknown, values: any[], connKey: string | null): MySQLQueryFailure {
    return { ok: false, stage, error: describeError(error), ...errorDetails(error), values, connKey, cause: error };
}

function timeoutError(message: string): Error & { code: string; isQueryTimeout: true } {
    const error = new Error(message) as Error & { code: string; isQueryTimeout: true };
    error.code = 'ETIMEDOUT';
    error.isQueryTimeout = true;
    return error;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rejects with a timeout error if `promise` hasn't settled within `ms`.
 * A late *success* is handed to `onAbandon` so whatever it holds (a pooled
 * connection, say) still gets cleaned up; a late failure is swallowed, which
 * also keeps it from surfacing as an unhandled rejection.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onAbandon?: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(timeoutError(message));
        }, ms);
        if (typeof timer.unref === 'function') timer.unref();

        promise.then(
            (value) => {
                clearTimeout(timer);
                if (settled) {
                    onAbandon?.(value);
                    return;
                }
                settled = true;
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                reject(error);
            },
        );
    });
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

interface TransactionEntry {
    conn: mysql.PoolConnection;
    createdAt: number;
    /** Bumped whenever a statement starts or finishes — this is what "idle" is measured from. */
    lastUpdate: number;
    /** Statements currently running on this connection; a busy transaction is never idle. */
    inFlight: number;
    /**
     * Set once the transaction can no longer be used (connection lost, deadlock rollback,
     * idle sweep). The connection is already released at that point; the entry is kept
     * around so commit/rollback can report *why* instead of "key not found".
     */
    dead?: string;
}
const listTransaction = new Map<string, TransactionEntry>();

function safeRelease(conn: mysql.PoolConnection) {
    try {
        conn.release();
    } catch {}
}

function safeDestroy(conn: mysql.PoolConnection) {
    try {
        conn.destroy();
    } catch {}
}

/**
 * Retires a transaction: optionally rolls it back, always frees its connection, and marks
 * the entry dead. Never throws — this runs on cleanup paths where the caller is already
 * handling another error.
 */
async function killTransaction(keyConn: string, reason: string, rollback: boolean): Promise<void> {
    const tr = listTransaction.get(keyConn);
    if (!tr || tr.dead) return;

    tr.dead = reason;
    tr.lastUpdate = Date.now();

    try {
        if (rollback) await tr.conn.rollback();
        safeRelease(tr.conn);
    } catch (error) {
        handleError(error, `MySQL: could not roll back transaction ${keyConn} (${reason})`);
        safeDestroy(tr.conn);
    }
}

let killOpenTRXInterval: ReturnType<typeof setInterval> | null = null;
async function killOpenTRX() {
    const staleTransactionMs = config?.staleTransactionMs ?? DEFAULT_STALE_TRANSACTION_MS;
    const now = Date.now();
    const pending: Promise<unknown>[] = [];

    for (const [key, entry] of listTransaction) {
        if (entry.inFlight > 0) continue; // a statement is running: busy, not idle
        if (entry.lastUpdate + staleTransactionMs > now) continue;
        if (entry.dead) {
            // Already retired and its connection freed — drop the bookkeeping entry.
            listTransaction.delete(key);
            continue;
        }
        pending.push(killTransaction(key, `it sat idle for more than ${staleTransactionMs}ms`, true));
    }

    await Promise.all(pending);
}
export function loopKillOpenTRX(): void {
    if (killOpenTRXInterval) return;
    killOpenTRXInterval = setInterval(() => {
        killOpenTRX().catch((error) => handleError(error, 'MySQL: killOpenTRX'));
    }, 1000);
}
export function stopLoopKillOpenTRX(): void {
    if (!killOpenTRXInterval) return;
    clearInterval(killOpenTRXInterval);
    killOpenTRXInterval = null;
}

async function createTransaction(): Promise<{ conn: mysql.PoolConnection; connKey: string } | { error: unknown }> {
    const keyConn = randomUUID();
    try {
        await ensurePool();
        const conn = await requirePool().getConnection();
        try {
            await conn.beginTransaction();
        } catch (error) {
            safeRelease(conn);
            throw error;
        }
        listTransaction.set(keyConn, { conn, createdAt: Date.now(), lastUpdate: Date.now(), inFlight: 0 });
        return { conn, connKey: keyConn };
    } catch (error) {
        handleError(error, 'MySQL: createTransaction');
        listTransaction.delete(keyConn);
        return { error };
    }
}

export async function connectionCommit(keyConn: string): Promise<{ error?: unknown }> {
    const tr = listTransaction.get(keyConn);
    if (!tr) {
        const msg = `Transaction key not found: ${keyConn}`;
        handleError(msg, 'MySQL: connectionCommit');
        return { error: msg };
    }

    // Claim the entry first: whatever happens below, this key is finished and the
    // background sweep must not touch it.
    listTransaction.delete(keyConn);

    if (tr.dead) {
        const msg = `Transaction ${keyConn} was already rolled back: ${tr.dead}`;
        handleError(msg, 'MySQL: connectionCommit');
        return { error: msg };
    }

    try {
        await tr.conn.commit();
        safeRelease(tr.conn);
        return {};
    } catch (error) {
        handleError(error, 'MySQL: connectionCommit');
        try {
            await tr.conn.rollback();
            safeRelease(tr.conn);
        } catch {
            safeDestroy(tr.conn);
        }
        return { error };
    }
}

export async function connectionRollback(keyConn: string): Promise<{ error?: unknown }> {
    const tr = listTransaction.get(keyConn);
    if (!tr) {
        const msg = `Transaction key not found: ${keyConn}`;
        handleError(msg, 'MySQL: connectionRollback');
        return { error: msg };
    }

    listTransaction.delete(keyConn);

    // Already rolled back and released elsewhere — nothing left to undo.
    if (tr.dead) return {};

    try {
        await tr.conn.rollback();
        safeRelease(tr.conn);
        return {};
    } catch (error) {
        handleError(error, 'MySQL: connectionRollback');
        // The connection is in an unknown state — never hand it back to the pool.
        safeDestroy(tr.conn);
        return { error };
    }
}

/* -------------------------------------------------------------------------- */
/* Pool health                                                                */
/* -------------------------------------------------------------------------- */

let ensurePoolPromise: Promise<void> | null = null;

/**
 * Verifies the pool can still hand out connections and rebuilds it if it can't.
 * Concurrent callers share one check, so a burst of queries hitting a dead pool
 * can't tear it down and recreate it several times over.
 */
async function ensurePool(): Promise<void> {
    if (ensurePoolPromise) return ensurePoolPromise;

    const run = (async () => {
        try {
            const conn = await requirePool().getConnection();
            conn.release();
            lastConnectionCheck = Date.now();
        } catch {
            lastConnectionCheck = 0;
            try {
                await requirePool().end();
            } catch {}
            try {
                createPool();
            } catch (err) {
                handleError(err, 'MySQL: ensurePool — could not recreate pool');
            }
        }
    })();

    ensurePoolPromise = run.finally(() => {
        ensurePoolPromise = null;
    });
    return ensurePoolPromise;
}

/* -------------------------------------------------------------------------- */
/* Statement execution                                                        */
/* -------------------------------------------------------------------------- */

function threadIdOf(conn: mysql.PoolConnection): number | undefined {
    const id = (conn as any)?.threadId ?? (conn as any)?.connection?.threadId;
    return typeof id === 'number' ? id : undefined;
}

/**
 * Aborts the statement running on `conn` from a *different* connection.
 * `KILL QUERY` leaves the connection (and any transaction on it) alive, unlike
 * closing the socket. Returns false if the statement could not be interrupted.
 */
async function killQuery(conn: mysql.PoolConnection): Promise<boolean> {
    const threadId = threadIdOf(conn);
    if (threadId === undefined) return false;
    try {
        // KILL isn't supported by the prepared-statement protocol and takes no placeholders,
        // hence query() with the (already numeric) id interpolated.
        await requirePool().query(`KILL QUERY ${threadId}`);
        return true;
    } catch (error) {
        handleError(error, `MySQL: could not KILL QUERY ${threadId} after a timeout`);
        return false;
    }
}

/**
 * Runs one statement, optionally under a timeout that covers both waiting for a
 * pooled connection and the query itself. On timeout the statement is killed
 * server-side so it stops consuming resources, and the connection is never
 * returned to the pool with work still running on it.
 */
async function runStatement(
    conn: mysql.PoolConnection | undefined,
    connKey: string | undefined,
    query: string,
    values: any[],
    timeoutMs: number | undefined,
    mode: 'execute' | 'query' = 'execute',
): Promise<{ rows: any; fields: mysql.FieldPacket[] }> {
    const entry = connKey ? listTransaction.get(connKey) : undefined;
    if (entry) {
        entry.inFlight++;
        entry.lastUpdate = Date.now();
    }

    const run = async (target: mysql.Pool | mysql.PoolConnection): Promise<{ rows: any; fields: mysql.FieldPacket[] }> => {
        const result: any = mode === 'query' ? await (target as mysql.Pool).query(query, values) : await (target as mysql.Pool).execute(query, values);
        return { rows: result?.[0], fields: (result?.[1] ?? []) as mysql.FieldPacket[] };
    };

    try {
        if (!timeoutMs || timeoutMs <= 0) {
            return await run(conn ?? requirePool());
        }

        const deadline = Date.now() + timeoutMs;
        let borrowed: mysql.PoolConnection | undefined;
        let target = conn;

        if (!target) {
            // Acquire explicitly: without a connection handle there is no way to
            // interrupt the statement later, and a saturated pool can block forever.
            target = borrowed = await withTimeout(requirePool().getConnection(), timeoutMs, `Timed out after ${timeoutMs}ms waiting for a connection from the pool`, safeRelease);
        }

        const exec = run(target);
        try {
            const result = await withTimeout(exec, Math.max(1, deadline - Date.now()), `Query timed out after ${timeoutMs}ms`);
            if (borrowed) safeRelease(borrowed);
            return result;
        } catch (error: any) {
            if (error?.isQueryTimeout !== true) {
                if (borrowed) safeRelease(borrowed);
                throw error;
            }

            const killed = await killQuery(target);
            if (borrowed) {
                // The statement may still be settling; this connection must not be reused.
                safeDestroy(borrowed);
            } else if (!killed && connKey) {
                await killTransaction(connKey, `a statement timed out after ${timeoutMs}ms and could not be interrupted`, false);
            }
            throw error;
        }
    } finally {
        if (entry) {
            entry.inFlight--;
            entry.lastUpdate = Date.now();
        }
    }
}

function checkStoredProcedureResult(rows: any, query: string): string | null {
    const message: string = rows?.[0]?.[0]?.['@message'] ?? '';
    if (!message.toLowerCase().startsWith('ok')) {
        return message || `No message returned from procedure: ${query}`;
    }
    return null;
}

function resolveFieldTypes(fields: mysql.FieldPacket[]): MySQLFieldType[] {
    if (!mysql.Types) throw new Error('mysql.Types is not available');
    return fields.map((field) => {
        const typeName = Object.keys(mysql.Types).find((key) => (mysql.Types as any)[key] === field.type);
        return { fieldName: field.name, fieldType: typeName ?? '' };
    });
}

function getTablesFromQuery(query: string): string[] {
    try {
        const { Parser } = (parserModule as any).default ?? parserModule;
        const parser = new Parser();

        const { tableList } = parser.parse(query);
        const cleanTableList = tableList.map((table: string) => {
            const parts = table.split('::');
            return parts[parts.length - 1];
        });
        return cleanTableList;
    } catch {
        return [];
    }
}

/* -------------------------------------------------------------------------- */
/* Public query API                                                           */
/* -------------------------------------------------------------------------- */

export async function executeMySQLQuery(query: string, values: any[] = [], returnFieldTypes = false, connKey?: boolean | string, timeoutMs?: number) {
    return executeMySQLQuery2({ query, values, returnFieldTypes, connKey, timeoutMs });
}

/**
 * Runs a query and **always** resolves to a wrapper — it never throws and never returns
 * bare rows, so every result is safe to inspect before use:
 *
 * ```ts
 * const res = await executeMySQLQuery3<User[]>({ query: 'SELECT ...', values });
 * if (!res.ok) return res.error;   // always a non-empty string, plus code/errno/sqlState
 * res.rows[0].email;               // narrowed by `ok`, guaranteed present
 * ```
 *
 * `T` types the rows: `User[]` for a SELECT, `ResultSetHeader` for an INSERT/UPDATE.
 *
 * Retries are limited to transient failures (deadlock, lock timeout, lost connection,
 * server out of connections). Deterministic errors — duplicate key, bad syntax, constraint
 * violations — come back on the first attempt.
 */
export async function executeMySQLQuery3<T = any>(opt: MySQLQueryOptions): Promise<MySQLQueryResult<T>> {
    const { values = [], returnFieldTypes = false, returnListTables = false } = opt;
    let { connKey } = opt;
    const keyOf = () => (typeof connKey === 'string' ? connKey : null);

    if (!config || !pool) {
        const msg = 'MySQL client not initialized. Call init(config) before using this package.';
        handleError(msg, 'MySQL: executeMySQLQuery3');
        return fail('not-initialized', msg, values, keyOf());
    }
    if (typeof opt.query !== 'string') {
        const msg = `Invalid query: expected a string, received ${typeof opt.query}`;
        handleError(msg, 'MySQL: executeMySQLQuery3');
        return fail('invalid-input', msg, values, keyOf());
    }

    const query = opt.query;
    const timeoutMs = opt.timeoutMs ?? config.defaultQueryTimeoutMs;
    const createsNewTransaction = connKey === true;
    const usesExistingTransaction = typeof connKey === 'string' && connKey.length > 0;

    /**
     * Executes a query with automatic retry on transient failures.
     *
     * - `callerOwnsConnection`: caller holds a transaction and manages commit/rollback.
     *     - Deadlock   → transaction already rolled back by MySQL, retire it and throw.
     *     - Timeout    → statement rolled back, transaction still alive — wait and retry
     *                    up to MAX_EXECUTE_ATTEMPTS; throw on last attempt so caller rollbacks.
     *     - Conn lost  → transaction is gone, retire it and throw.
     * - `createsNewTransaction`: we own the transaction internally.
     *     - Any retryable error → roll back, open a fresh transaction, retry.
     * - Neither (plain pool):
     *     - Wait (delay depends on the error) and retry against the pool.
     */
    async function executeWithRetry(startConn: mysql.PoolConnection | undefined, startKey: string | undefined, callerOwnsConnection: boolean): Promise<{ rows: any; fields: mysql.FieldPacket[]; connKey?: string }> {
        let conn = startConn;
        let key = startKey;

        for (let attempt = 1; attempt <= MAX_EXECUTE_ATTEMPTS; attempt++) {
            try {
                const { rows, fields } = await runStatement(conn, key, query, values, timeoutMs);
                return { rows, fields, connKey: key };
            } catch (error: any) {
                const isDeadlock = error?.code === 'ER_LOCK_DEADLOCK';
                const isLockTimeout = error?.code === 'ER_LOCK_WAIT_TIMEOUT';
                const isConnLost = isConnectionLost(error);
                const lastAttempt = attempt === MAX_EXECUTE_ATTEMPTS;

                // A lost connection takes its transaction with it; a deadlock has already
                // been rolled back by MySQL. Either way the transaction is finished.
                if (key && (isConnLost || isDeadlock)) {
                    await killTransaction(key, isConnLost ? 'the connection was lost' : 'MySQL rolled it back after a deadlock', false);
                    if (createsNewTransaction) listTransaction.delete(key);
                    conn = undefined;
                }

                // The caller's transaction can only survive a lock timeout: that rolls back
                // the statement, not the transaction. Anything else is theirs to clean up.
                const callerTransactionIsDead = callerOwnsConnection && (isDeadlock || isConnLost);

                if (!isTransientError(error) || callerTransactionIsDead || lastAttempt) {
                    if (createsNewTransaction && key) {
                        // Keep the (dead) entry so the caller's own rollback of the key we
                        // report back succeeds instead of erroring with "key not found".
                        await killTransaction(key, `the query failed: ${describeError(error)}`, !isConnLost && !isDeadlock);
                    }
                    if (key) (error as any).connKey = key;
                    throw error;
                }

                const retryDelay = isDeadlock ? DEADLOCK_RETRY_DELAY_MS : isLockTimeout ? LOCK_TIMEOUT_RETRY_DELAY_MS : TRANSIENT_RETRY_DELAY_MS;
                await sleep(retryDelay * attempt);

                if (createsNewTransaction) {
                    // Our transaction is unusable — retire it and open a fresh one to retry in.
                    if (key) {
                        await killTransaction(key, `retrying after ${describeError(error)}`, true);
                        listTransaction.delete(key);
                    }
                    conn = undefined;
                    const reqTr = await createTransaction();
                    if ('error' in reqTr) {
                        const failure: any = new Error(`Failed to recreate transaction after ${describeError(error)}: ${describeError(reqTr.error)}`);
                        failure.code = (reqTr.error as any)?.code;
                        failure.cause = reqTr.error;
                        throw failure;
                    }
                    conn = reqTr.conn;
                    key = reqTr.connKey;
                } else if (!conn) {
                    await ensurePool();
                }
            }
        }

        throw new Error('MySQL: executeWithRetry reached unexpected end');
    }

    if (!usesExistingTransaction && lastConnectionCheck + POOL_CHECK_INTERVAL_MS <= Date.now()) {
        await ensurePool();
    }

    let conn: mysql.PoolConnection | undefined;

    try {
        if (createsNewTransaction) {
            const reqTr = await createTransaction();
            if ('error' in reqTr) return fail('transaction-create', reqTr.error, values, null);
            connKey = reqTr.connKey;
            conn = reqTr.conn;
        } else if (usesExistingTransaction && typeof connKey === 'string') {
            const tr = listTransaction.get(connKey);
            if (!tr) {
                const msg = `Transaction key not found: ${connKey}`;
                handleError(msg, 'MySQL: executeMySQLQuery3');
                return fail('transaction-lookup', msg, values, connKey);
            }
            if (tr.dead) {
                const msg = `Transaction ${connKey} is no longer usable: ${tr.dead}`;
                handleError(msg, 'MySQL: executeMySQLQuery3');
                return fail('transaction-lookup', msg, values, connKey);
            }
            tr.lastUpdate = Date.now();
            conn = tr.conn;
        }

        const {
            rows,
            fields,
            connKey: updatedConnKey,
        } = await executeWithRetry(conn, typeof connKey === 'string' ? connKey : undefined, usesExistingTransaction);

        if (updatedConnKey) connKey = updatedConnKey;

        if (query.trim().toLowerCase().startsWith('call')) {
            const procError = checkStoredProcedureResult(rows, query);
            if (procError) {
                if (createsNewTransaction && typeof connKey === 'string') {
                    await killTransaction(connKey, `the procedure reported: ${procError}`, true);
                }
                return fail('procedure', procError, values, keyOf());
            }
        }

        return {
            ok: true,
            rows: rows as T,
            fieldsType: returnFieldTypes ? resolveFieldTypes(fields) : [],
            tables: returnListTables ? getTablesFromQuery(query) : [],
            connKey: keyOf(),
        };
    } catch (error: any) {
        // executeWithRetry reports which transaction the failure ended on, which may be a
        // recreated one rather than the key we started with.
        if (typeof error?.connKey === 'string') connKey = error.connKey;

        const errorMsg = describeError(error);
        const queryStr = query.length > 200 ? `${query.substring(0, 200)}...` : query;
        handleError(error, `MySQL${error?.code ? ` [${error.code}]` : ''}${connKey ? ' (using connection)' : ''}\n${errorMsg}\n\nparams: ${values}\n\nquery: ${queryStr}`);

        return fail('execute', error, values, keyOf());
    }
}

/**
 * Legacy shape, kept for existing call sites: returns the rows directly on success
 * (or `{ rows, fieldsType, connKey, tables }` when a transaction or extra metadata was
 * requested), and `{ error, values, connKey }` on failure — now carrying `code`, `errno`
 * and `sqlState` alongside the message.
 *
 * New code should prefer {@link executeMySQLQuery3}, which always returns a typed
 * `{ ok, ... }` wrapper.
 */
export async function executeMySQLQuery2(opt: MySQLQueryOptions): Promise<any> {
    requireConfig(); // unchanged: calling this before init() is a programming error, so it throws

    const { values = [], returnFieldTypes = false, returnListTables = false } = opt;
    const createsNewTransaction = opt.connKey === true;

    const result = await executeMySQLQuery3(opt);

    if (result.ok) {
        if (createsNewTransaction || returnFieldTypes || returnListTables) {
            return { rows: result.rows, fieldsType: result.fieldsType, connKey: result.connKey ?? undefined, tables: result.tables };
        }
        return result.rows;
    }

    switch (result.stage) {
        case 'transaction-create':
            return { error: result.cause ?? result.error };
        case 'transaction-lookup':
        case 'not-initialized':
        case 'invalid-input':
            return { error: result.error };
        case 'procedure':
            return { error: result.error, values };
        default: {
            const isLockError = result.code === 'ER_LOCK_DEADLOCK' || result.code === 'ER_LOCK_WAIT_TIMEOUT';
            const error = isLockError ? 'A lock error occurred, please retry' : ((result.cause as any)?.message ?? result.cause ?? result.error);
            return { error, values, connKey: result.connKey, code: result.code, errno: result.errno, sqlState: result.sqlState };
        }
    }
}

/**
 * Runs a statement through mysql2's `query()` (text protocol) instead of `execute()`
 * (prepared-statement protocol).
 *
 * MySQL refuses a number of statements in the prepared-statement protocol
 * ("This command is not supported in the prepared statement protocol yet") —
 * `SET GLOBAL ...`, `USE ...`, `LOCK TABLES`, several `SHOW` variants, etc.
 * Use this for those; keep using `executeMySQLQuery` for everything else, since
 * that one adds deadlock/lock-timeout retries and prepared statements.
 *
 * Values are escaped and interpolated client-side by mysql2 (`?` placeholders),
 * so parameters are still safe to pass.
 *
 * Returns the rows on success, or `{ error, values, connKey }` on failure —
 * same shape as `executeMySQLQuery`.
 */
export async function runMySQLQuery(query: string, values: any[] = [], connKey?: string, timeoutMs?: number) {
    const cfg = requireConfig();

    let conn: mysql.PoolConnection | undefined;

    try {
        if (connKey) {
            const tr = listTransaction.get(connKey);
            if (!tr) {
                const msg = `Transaction key not found: ${connKey}`;
                handleError(msg, 'MySQL: runMySQLQuery');
                return { error: msg, values, connKey };
            }
            if (tr.dead) {
                const msg = `Transaction ${connKey} is no longer usable: ${tr.dead}`;
                handleError(msg, 'MySQL: runMySQLQuery');
                return { error: msg, values, connKey };
            }
            tr.lastUpdate = Date.now();
            conn = tr.conn;
        } else if (lastConnectionCheck + POOL_CHECK_INTERVAL_MS <= Date.now()) {
            await ensurePool();
        }

        const { rows } = await runStatement(conn, connKey, query, values, timeoutMs ?? cfg.defaultQueryTimeoutMs, 'query');
        return rows;
    } catch (error: any) {
        const errorMsg = describeError(error);
        const queryStr = query.length > 200 ? `${query.substring(0, 200)}...` : query;
        handleError(error, `MySQL${error?.code ? ` [${error.code}]` : ''}${connKey ? ' (using connection)' : ''}\n${errorMsg}\n\nparams: ${values}\n\nquery: ${queryStr}`);
        return { error: error?.message ?? error, values, connKey: connKey ?? null, ...errorDetails(error) };
    }
}
