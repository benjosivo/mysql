# @benjosivo/mysql

Shared MySQL client (pooling, automatic retry on deadlock/lock-timeout, transaction helpers) for use across multiple projects. Nothing connects until you call `init()` — the package has no side effects at import time and no dependency on any particular env var naming.

## Install

This package is published to **GitHub Packages**, not the public npm registry, so every machine needs a one-time setup before `npm install` will work — even though the repo and package are public. GitHub Packages never allows anonymous installs; a valid GitHub token is always required.

### One-time setup (per machine)

1. **Create a GitHub Personal Access Token.**
   GitHub → click your avatar → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.
   Scope needed: **`read:packages`**. Copy the token — GitHub only shows it once.

2. **Add two lines to your global npm config.**
   Find the file path:
   ```
   npm config get globalconfig
   ```
   It's typically `C:\Users\<you>\AppData\Roaming\npm\etc\npmrc` on Windows. Open that file in a text editor and add:
   ```
   @benjosivo:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_TOKEN_HERE
   ```
   Editing the file directly is more reliable than `npm config set` — on some npm versions, `npm config set @benjosivo:registry=... --global` fails with a cryptic `` `` is not a valid npm option `` error. If you'd rather use the CLI, use the space-separated form instead of `=`:
   ```
   npm config set @benjosivo:registry https://npm.pkg.github.com --global
   ```

3. **Verify both lines took effect:**
   ```
   npm config list
   ```
   You should see both `@benjosivo:registry = "https://npm.pkg.github.com"` and `//npm.pkg.github.com/:_authToken = (protected)` in the output.

### Install

```
npm install @benjosivo/mysql
```

### Troubleshooting

- **`404 Not Found - GET https://registry.npmjs.org/@benjosivo%2fmysql`** — npm is checking the default npm registry instead of GitHub Packages. This means the `@benjosivo:registry` line from step 2 above isn't set (check with `npm config get @benjosivo:registry`). Add it and retry.
- **401/403 or `ENEEDAUTH`** — the auth token is missing, expired, or lacks `read:packages` scope. Regenerate a token and re-add it.

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
