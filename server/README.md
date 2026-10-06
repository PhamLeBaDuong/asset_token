# Asset API: checkpoint step 6

This Node API reads asset records from the existing remote `asset_token` database.
It runs on your PC for development; PostgreSQL stays in the existing container on
167.233.214.178. No local PostgreSQL or Docker setup is required.

From `server`:

```powershell
npm ci
```

The ignored `server/.env` contains the remote host and database settings. Set its
`DB_PASSWORD` to the current password for the `postgres` user in
`soccer-field-booking-management-db-1`. `.env.example` documents the required
settings without credentials. `DB_NAME` must be `asset_token`.

```powershell
npm run check-db
npm run dev
```

In another terminal, from `frontend`:

```powershell
npm run dev
```

Vite proxies `/api` to the local API at `127.0.0.1:3001`. PostgreSQL credentials
remain in the API process and are not included in the frontend bundle. Keep
`API_PORT=3001` unless you also update the proxy target in `frontend/vite.config.js`.

## Load a saved asset

1. Import the downloaded token record into the remote database using the scripts
   in [database](../database/README.md), if you have not already done so.
2. Connect your browser wallet on the token's network and enter its expected
   chain ID, such as 11155111 for Sepolia.
3. Enter `coffee-001` (or your actual asset ID), and click **Load saved asset**.
   The factory address is filled from the database record.

The API retrieves the record by asset ID **and chain ID** using a parameterized
SQL query. The frontend checks the network, confirms the token address against
the saved factory's mapping, and compares issuer and creation details against the
factory's creation event. It then shows the stored description and JSON metadata,
alongside live token supply, wallet balances, and transfer history.

The asset URL becomes `/assets/coffee-001?chainId=11155111`. Opening or refreshing
that URL pre-fills the lookup; connect your wallet to load the record and blockchain
state. Transfers still go directly from the browser wallet to the token contract.
Balance refreshes preserve the loaded database record.

This API supports reads. Changes to description/metadata are still downloaded
and imported using step 5. It does not automatically save form edits or upload
documents. Document hashing and integrity verification remain steps 7 and 8.

## Endpoints and checks

- `GET /api/assets/:assetId?chainId=11155111`: saved record; 404 when missing.
- `GET /api/health`: checks database access and the assets table, including an
  empty table; 503 when unavailable.
- `npm test`: tests HTTP behavior, parameterization, missing records, connection
  errors, and database configuration using an isolated test database adapter.
- `npm run check-db`: performs a read-only check of the actual remote table.

The frontend blockchain test for step 6 runs the real HTTP API with a test database
adapter and reads a real deployed token on Hardhat. It checks that altered chain,
token, issuer, and creation details are rejected. This is separate from live remote
database verification.

A deployed frontend needs an equivalent same-origin `/api` reverse proxy to this
API, plus SPA fallback for `/assets/*`. Vite's proxy is for local dev/preview; a
static production build does not include an API server.

Implementation references: [node-postgres parameterized queries](https://node-postgres.com/features/queries)
and [Vite proxy configuration](https://vite.dev/config/server-options#server-proxy).
