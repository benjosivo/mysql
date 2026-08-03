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
    /** Called whenever this client encounters an error it can't throw directly (e.g. inside retry loops). Defaults to console.error. */
    onError?: (error: unknown, context: string) => void;
}

let config: MySQLClientConfig | undefined;
let pool: mysql.Pool | undefined;
let lastConnectionCheck = 0;

function defaultOnError(error: unknown, context: string) {
    console.error(`[mysql-client] ${context}`, error);
}

function handleError(error: unknown, context: string) {
    (config?.onError ?? defaultOnError)(error, context);
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

    try {
        await pool.end();
    } catch {}

    pool = undefined;
    config = undefined;
    lastConnectionCheck = 0;
}

interface TransactionEntry {
    conn: mysql.PoolConnection;
    lastValidConn?: mysql.PoolConnection;
    timestamp: number;
    lastUpdate: number;
    creation: number;
}
const listTransaction = new Map<string, TransactionEntry>();

let killOpenTRXInterval: ReturnType<typeof setInterval> | null = null;
async function killOpenTRX() {
    const staleTransactionMs = config?.staleTransactionMs ?? 5 * 60_000;
    const rollbackPromises: Promise<unknown>[] = [];
    for (const [key, value] of listTransaction) {
        if (value.timestamp + staleTransactionMs < Date.now()) {
            rollbackPromises.push(connectionRollback(key));
        }
    }
    await Promise.all(rollbackPromises);
}
export function loopKillOpenTRX(): void {
    if (killOpenTRXInterval) return;
    killOpenTRXInterval = setInterval(killOpenTRX, 1000);
}
export function stopLoopKillOpenTRX(): void {
    if (!killOpenTRXInterval) return;
    clearInterval(killOpenTRXInterval);
    killOpenTRXInterval = null;
}

async function ensurePool() {
    try {
        const conn = await requirePool().getConnection();
        conn.release();
        lastConnectionCheck = Date.now();
    } catch {
        try {
            await requirePool().end();
        } catch {}
        try {
            createPool();
        } catch (err) {
            handleError(err, 'MySQL: ensurePool — could not recreate pool');
        }
    }
}

export async function executeMySQLQuery(query: string, values: any[] = [], returnFieldTypes = false, connKey?: boolean | string) {
    return executeMySQLQuery2({ query, values, returnFieldTypes, connKey });
}
export async function executeMySQLQuery2(opt: { query: string; values?: any[]; connKey?: boolean | string; returnFieldTypes?: boolean; returnListTables?: boolean | string }) {
    requireConfig();
    const { query, values = [], returnFieldTypes = false, returnListTables = false } = opt;
    let { connKey } = opt;

    async function executeWithRetry(opt: {
        query: string;
        values: any[];
        conn?: mysql.PoolConnection;
        connKey?: string;
        callerOwnsConnection: boolean;
        createsNewTransaction: boolean;
    }): Promise<{ rows: any; fields: mysql.FieldPacket[]; connKey?: string }> {
        /**
         * Executes a query with automatic retry on deadlock and lock timeout.
         *
         * - `callerOwnsConnection`: caller holds a transaction and manages commit/rollback.
         *     - Deadlock   → transaction already rolled back by MySQL, throw immediately.
         *     - Timeout    → statement rolled back, transaction still alive — wait and retry
         *                    up to MAX_EXECUTE_ATTEMPTS; throw on last attempt so caller rollbacks.
         * - `createsNewTransaction`: we own the transaction internally.
         *     - Deadlock   → rollback + recreate transaction, retry.
         *     - Timeout    → rollback + recreate transaction, retry with longer delay.
         * - Neither (plain pool):
         *     - Both       → wait (with appropriate delay) and retry against the pool.
         */
        const { query, values, callerOwnsConnection, createsNewTransaction } = opt;
        let { conn, connKey } = opt;

        function isConnectionLost(error: any) {
            return (
                error?.code === 'PROTOCOL_CONNECTION_LOST' ||
                error?.code === 'ECONNRESET' ||
                error?.code === 'ECONNREFUSED' ||
                error?.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR' ||
                error?.fatal === true
            );
        }

        for (let attempt = 1; attempt <= MAX_EXECUTE_ATTEMPTS; attempt++) {
            try {
                const [rows, fields] = await (conn ?? requirePool()).execute(query, values);
                if (conn && connKey) {
                    const activeTr = listTransaction.get(connKey);
                    if (activeTr) {
                        activeTr.lastValidConn = conn;
                    }
                }
                return { rows, fields: fields as mysql.FieldPacket[], connKey };
            } catch (error: any) {
                const isDeadlock = error?.code === 'ER_LOCK_DEADLOCK';
                const isLockTimeout = error?.code === 'ER_LOCK_WAIT_TIMEOUT';
                const isLockError = isDeadlock || isLockTimeout;
                const isConnLost = isConnectionLost(error);

                if (attempt === MAX_EXECUTE_ATTEMPTS) {
                    if (createsNewTransaction && connKey) {
                        try {
                            await connectionRollback(connKey);
                        } catch {}
                    }
                    throw error;
                }

                // Fatal connection loss requires cleanup.
                if (isConnLost) {
                    if (createsNewTransaction && connKey) {
                        try {
                            await connectionRollback(connKey);
                        } catch {}
                        conn = undefined;
                        const reqTr = await createTransaction();
                        if ('error' in reqTr) throw new Error('Failed to recreate transaction after lost connection');
                        conn = reqTr.conn;
                        connKey = reqTr.connKey;
                        continue;
                    }

                    if (callerOwnsConnection) {
                        throw error;
                    }

                    await ensurePool();
                    continue;
                }

                // Deadlock + caller-owned: MySQL already rolled back the entire transaction,
                // retrying on the same connection is not possible — throw so the caller rollbacks.
                if (isDeadlock && callerOwnsConnection) {
                    if (connKey) connectionRollback(connKey);
                    throw error;
                }

                // Non-lock error: re-check the pool and retry
                if (!isLockError) {
                    if (!conn) await ensurePool(); // pool health is irrelevant when we own a connection
                    continue;
                }

                // Timeout + caller-owned: only the statement was rolled back, the transaction
                // is still alive — wait and retry the statement on the same connection.
                // The caller will rollback the transaction itself if we ultimately throw.
                if (isLockTimeout && callerOwnsConnection) {
                    await new Promise((r) => setTimeout(r, LOCK_TIMEOUT_RETRY_DELAY_MS * attempt));
                    continue;
                }

                // Deadlock: MySQL already rolled back the transaction — retry quickly.
                // Timeout:  something is holding a lock — wait longer before retrying.
                const retryDelay = isDeadlock ? DEADLOCK_RETRY_DELAY_MS : LOCK_TIMEOUT_RETRY_DELAY_MS;
                await new Promise((r) => setTimeout(r, retryDelay * attempt));

                if (createsNewTransaction) {
                    // For both error types, our transaction is no longer usable — recreate it
                    try {
                        conn?.release();
                    } catch {}
                    conn = undefined;
                    const reqTr = await createTransaction();
                    if ('error' in reqTr) throw new Error(`Failed to recreate transaction after ${isDeadlock ? 'deadlock' : 'lock timeout'}`);
                    conn = reqTr.conn;
                    connKey = reqTr.connKey;
                }
            }
        }

        throw new Error('MySQL: executeWithRetry reached unexpected end');
    }
    function checkStoredProcedureResult(rows: any, query: string): string | null {
        const message: string = rows?.[0]?.[0]?.['@message'] ?? '';
        if (!message.toLowerCase().startsWith('ok')) {
            return message || `No message returned from procedure: ${query}`;
        }
        return null;
    }
    function resolveFieldTypes(fields: mysql.FieldPacket[]): { fieldName: string; fieldType: string }[] {
        if (!mysql.Types) throw new Error('mysql.Types is not available');
        return fields.map((field) => {
            const typeName = Object.keys(mysql.Types).find((key) => (mysql.Types as any)[key] === field.type);
            return { fieldName: field.name, fieldType: typeName ?? '' };
        });
    }
    function getTablesFromQuery(query: string) {
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

    const DEADLOCK_RETRY_DELAY_MS = 100;
    const LOCK_TIMEOUT_RETRY_DELAY_MS = 500;
    const MAX_EXECUTE_ATTEMPTS = 5;

    const createsNewTransaction = connKey === true;
    const usesExistingTransaction = !!connKey && typeof connKey === 'string';

    if (lastConnectionCheck + 5 * 60_000 <= Date.now() && !usesExistingTransaction) {
        await ensurePool();
    }

    let conn: mysql.PoolConnection | undefined;

    try {
        if (createsNewTransaction) {
            const reqTr = await createTransaction();
            if ('error' in reqTr) return { error: reqTr.error };
            connKey = reqTr.connKey;
            conn = reqTr.conn;
        } else if (usesExistingTransaction && typeof connKey === 'string') {
            const tr = listTransaction.get(connKey);
            if (!tr) {
                const msg = `Transaction key not found: ${connKey}`;
                handleError(msg, 'MySQL: executeMySQLQuery2');
                return { error: msg };
            }
            tr.lastUpdate = Date.now();
            conn = tr.conn;
        }

        const {
            rows,
            fields,
            connKey: updatedConnKey,
        } = await executeWithRetry({
            query,
            values,
            conn,
            connKey: typeof connKey === 'string' ? connKey : undefined,
            callerOwnsConnection: usesExistingTransaction,
            createsNewTransaction,
        });

        if (updatedConnKey) connKey = updatedConnKey;

        if (query.trim().toLowerCase().startsWith('call')) {
            const procError = checkStoredProcedureResult(rows, query);
            if (procError) {
                if (createsNewTransaction && typeof connKey === 'string') {
                    try {
                        await connectionRollback(connKey);
                    } catch {}
                }
                return { error: procError, values };
            }
        }

        const fieldsType = returnFieldTypes ? resolveFieldTypes(fields) : [];
        const tables = returnListTables ? getTablesFromQuery(query) : [];

        if (createsNewTransaction || returnFieldTypes || returnListTables) {
            return { rows, fieldsType, connKey, tables };
        }
        return rows;
    } catch (error: any) {
        try {
            const errorMsg = String(error?.message ?? error);
            const queryStr = query.length > 200 ? `${query.substring(0, 200)}...` : query;
            if (connKey && typeof connKey === 'string' && errorMsg.includes('new command when connection is in closed state')) {
                const activeTr = listTransaction.get(connKey);
                if (activeTr) {
                    console.log(`lastValidConn (lastUpdate : ${activeTr.lastUpdate}) : `);
                    console.log(activeTr.lastValidConn);
                    console.log(`conn (creation : ${activeTr.creation})  : `);
                    console.log(conn);
                }
            }
            handleError(error, `MySQL${error?.code ? ` [${error.code}]` : ''}${connKey ? ' (using connection)' : ''}\n${errorMsg}\n\nparams: ${values}\n\nquery: ${queryStr}`);
        } catch (handlingError) {
            handleError(handlingError, 'MySQL: error inside error handler');
        }

        if (error?.code === 'ER_LOCK_DEADLOCK' || error?.code === 'ER_LOCK_WAIT_TIMEOUT') {
            return { error: 'A lock error occurred, please retry', values, connKey: connKey ?? null };
        }

        return { error: error?.message ?? error, values, connKey: connKey ?? null };
    }
}

async function createTransaction(): Promise<{ conn: mysql.PoolConnection; connKey: string } | { error: unknown }> {
    const keyConn = randomUUID();
    try {
        await ensurePool();
        const conn = await requirePool().getConnection();
        await conn.beginTransaction();
        listTransaction.set(keyConn, { conn, timestamp: Date.now(), lastUpdate: Date.now(), lastValidConn: conn, creation: Date.now() });
        return { conn, connKey: keyConn };
    } catch (error) {
        handleError(error, 'MySQL: createTransaction');
        try {
            listTransaction.delete(keyConn);
        } catch {}
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
    try {
        await tr.conn.commit();
        await tr.conn.release();
        listTransaction.delete(keyConn);
        return {};
    } catch (error) {
        handleError(error, 'MySQL: connectionCommit');
        return { error };
    }
}
export async function connectionRollback(keyConn: string): Promise<{ error?: unknown }> {
    const tr = listTransaction.get(keyConn);
    if (!tr) {
        handleError(`Transaction key not found: ${keyConn}`, 'MySQL: connectionRollback');
        return { error: `Transaction key not found: ${keyConn}` };
    }
    try {
        await tr.conn.rollback();
        await tr.conn.release();
        listTransaction.delete(keyConn);
        return {};
    } catch (error) {
        return { error };
    }
}
