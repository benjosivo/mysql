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
| `staleTransactionMs` | no | `300000` (5 min) | idle transactions older than this are auto rolled back |
| `onError` | no | `console.error` | called with `(error, context)` whenever the client can't throw the error directly (e.g. background retry loops) |

Calling `init()` again (e.g. to reconfigure) closes the previous pool first.

### Queries

```ts
executeMySQLQuery(query, values?, returnFieldTypes?, connKey?)
```

Returns the rows directly on success. On failure it returns `{ error, values, connKey }` instead of throwing (matches `mysql2`'s row-result shape so existing call sites don't need try/catch).

### Transactions

```ts
const { connKey, error } = await executeMySQLQuery2({ query: 'INSERT ...', values, connKey: true });
if (error) { /* handle */ }

await executeMySQLQuery2({ query: 'UPDATE ...', values, connKey }); // reuse the same transaction

await connectionCommit(connKey);
// or: await connectionRollback(connKey);
```

Transactions left open longer than `staleTransactionMs` are automatically rolled back by a background sweep.

### Shutdown

```ts
await closeMySQLConnection();
```

Rolls back any open transactions, ends the pool, and stops the background sweep. Safe to call even if `init()` was never called.
