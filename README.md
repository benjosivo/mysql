# @benjosivo/mysql

Shared MySQL client (pooling, automatic retry on deadlock/lock-timeout, transaction helpers) for use across multiple projects. Nothing connects until you call `init()` — the package has no side effects at import time and no dependency on any particular env var naming.

## Install

```
npm install @benjosivo/mysql
```

## Usage

```ts
import { init, executeMySQLQuery, closeMySQLConnection } from '@benjosivo/mysql';

await init({
    host: process.env.DB_HOST!,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    onError: (error, context) => myLogger.error(context, error), // optional, defaults to console.error
});

const rows = await executeMySQLQuery('SELECT * FROM users WHERE id = ?', [userId]);

// on shutdown
await closeMySQLConnection();
```

Call `init()` once per process, at startup. Each consuming project supplies its own credentials and (optionally) its own error reporting — this package has no opinion on either.

### Config

| Field | Required | Default | Description |
|---|---|---|---|
| `host`, `user`, `password`, `database` | yes | — | MySQL connection details |
| `waitForConnections` | no | `true` | passed through to `mysql2` pool |
| `connectionLimit` | no | `50` | passed through to `mysql2` pool |
| `queueLimit` | no | `0` | passed through to `mysql2` pool |
| `multipleStatements` | no | `true` | passed through to `mysql2` pool |
| `staleTransactionMs` | no | `300000` (5 min) | a transaction with no statement activity for this long is auto rolled back |
| `defaultQueryTimeoutMs` | no | — (off) | default per-statement timeout; overridable per call with `timeoutMs` |
| `onError` | no | `console.error` | called with `(error, context)` whenever the client can't throw the error directly (e.g. background retry loops) |

Calling `init()` again (e.g. to reconfigure) closes the previous pool first.

### Queries

```ts
executeMySQLQuery3<T>({ query, values?, connKey?, returnFieldTypes?, returnListTables?, timeoutMs? })
```

**Preferred for new code.** Always resolves to a wrapper — it never throws and never returns
bare rows, so every result is safe to inspect before use:

```ts
const res = await executeMySQLQuery3<User[]>({ query: 'SELECT * FROM users WHERE id = ?', values: [userId] });

if (!res.ok) {
    // res.error is always a non-empty string
    logger.error(res.error, res.code, res.errno, res.sqlState);
    return;
}

res.rows[0].email; // narrowed by `ok` — TypeScript knows rows is present
```

`T` types the rows: `User[]` for a SELECT, `ResultSetHeader` for an INSERT/UPDATE. It defaults to
`any`, so untyped calls keep working.

| On success | On failure |
|---|---|
| `ok: true` | `ok: false` |
| `rows: T` | `error: string` (never empty), `code?`, `errno?`, `sqlState?`, `cause?` |
| `fieldsType: []` unless `returnFieldTypes` | `stage`: which step failed (`execute`, `transaction-lookup`, `procedure`, …) |
| `tables: []` unless `returnListTables` | `values`: the parameters that were sent |
| `connKey: string \| null` | `connKey: string \| null` |

Because the union is discriminated on `ok`, TypeScript will not let you read `rows` off a result
you haven't checked.

#### Retries

Only *transient* failures are retried (up to 5 attempts, with a backoff): deadlocks, lock timeouts,
lost connections, and a server that is out of connections. Deterministic failures — duplicate key,
bad syntax, constraint violations, unknown column, access denied — are returned on the **first**
attempt, since re-sending them can only produce the same error.

#### Timeouts

`timeoutMs` (or `defaultQueryTimeoutMs` in the config) bounds a statement, covering both the wait
for a pooled connection and the query itself. On expiry the statement is aborted server-side with
`KILL QUERY` so it stops consuming resources, and the failure comes back as
`{ ok: false, code: 'ETIMEDOUT' }`. Timed-out statements are never retried — a killed write must
not be silently re-applied.

```ts
const res = await executeMySQLQuery3({ query: 'SELECT ...', values, timeoutMs: 10_000 });
```

#### Legacy shape

```ts
executeMySQLQuery(query, values?, returnFieldTypes?, connKey?, timeoutMs?)
executeMySQLQuery2({ query, values?, connKey?, returnFieldTypes?, returnListTables?, timeoutMs? })
```

Unchanged: these return the rows directly on success (or `{ rows, fieldsType, connKey, tables }`
when a transaction or extra metadata was requested), and `{ error, values, connKey }` on failure
instead of throwing. Failures now also carry `code`, `errno` and `sqlState` alongside the message.
They share the retry, timeout and transaction handling described above; `executeMySQLQuery2` is a
thin adapter over `executeMySQLQuery3`.

### Statements prepared statements can't run

`executeMySQLQuery` uses `execute()` (MySQL's prepared-statement protocol), and MySQL rejects a
number of statements there with *"This command is not supported in the prepared statement protocol
yet"* — `SET GLOBAL ...`, `USE ...`, `LOCK TABLES`, several `SHOW` variants, and so on. For those,
use `runMySQLQuery`, which goes through `query()` (text protocol) instead:

```ts
import { runMySQLQuery } from '@benjosivo/mysql';

await runMySQLQuery("SET GLOBAL general_log = 'OFF'");

// placeholders still work — mysql2 escapes and interpolates them client-side
await runMySQLQuery('SET GLOBAL general_log = ?', ['OFF']);

// optionally run inside an existing transaction
await runMySQLQuery('SELECT * FROM users WHERE id = ?', [userId], connKey);
```

```ts
runMySQLQuery(query, values?, connKey?, timeoutMs?)
```

Same result shape as `executeMySQLQuery`: rows on success, `{ error, values, connKey }` on failure
(with `code`/`errno`/`sqlState` when MySQL supplied them).
It's deliberately simple — no deadlock/lock-timeout retry — so prefer `executeMySQLQuery` for
regular application queries and keep this one for statements the prepared-statement protocol
refuses.

### Transactions

```ts
const opened = await executeMySQLQuery3({ query: 'INSERT ...', values, connKey: true });
if (!opened.ok) return opened.error;

await executeMySQLQuery3({ query: 'UPDATE ...', values, connKey: opened.connKey }); // same transaction

await connectionCommit(opened.connKey!);
// or: await connectionRollback(opened.connKey!);
```

A transaction is retired as soon as it can no longer be used — MySQL rolled it back after a
deadlock, its connection was lost, or the background sweep found it idle. Its connection is
released immediately, and any later use reports *why*:

```ts
// Transaction <key> is no longer usable: MySQL rolled it back after a deadlock
```

`connectionRollback` on a transaction that was already retired succeeds (there is nothing left to
undo); `connectionCommit` reports an error, because the data did not make it. Both always free the
connection, even if the COMMIT or ROLLBACK itself fails.

`staleTransactionMs` measures **idle** time: a transaction is swept only when no statement has run
on it for that long, so a long-running but active transaction is left alone.

### Shutdown

```ts
await closeMySQLConnection();
```

Rolls back any open transactions, ends the pool, and stops the background sweep. Safe to call even if `init()` was never called.
