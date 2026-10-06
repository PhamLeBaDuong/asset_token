# Remote PostgreSQL: checkpoint step 5

For setup without copying the full folder, `setup-remote.sh` is a standalone
script with the assets schema embedded. Copy that file to the server and run
`bash setup-remote.sh`. It uses your existing container by name.

Run these scripts on **167.233.214.178**, where your PostgreSQL Docker container
already runs. They create a separate `asset_token` database inside that container
and apply its `public.assets` table. They do not start containers, install
PostgreSQL, alter Docker port mappings, or change the soccer databases.

The target is your existing `soccer-field-booking-management-db-1` container
running PostgreSQL 16. It publishes host port **5432**, according to the container
listing you supplied. The older project `.env` using port 5433 does not describe
this mapping.

Copy this `database` folder to the server:

```powershell
scp -r database root@167.233.214.178:~/asset-token-db
ssh root@167.233.214.178
```

Then on the server:

```bash
cd ~/asset-token-db
bash setup.sh
bash test.sh
```

The scripts target `soccer-field-booking-management-db-1` by name, so published
ports do not affect setup. To override the name if the container is renamed:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
export ASSET_DB_CONTAINER=YOUR_EXISTING_POSTGRES_CONTAINER
bash setup.sh
bash test.sh
```

The database user defaults to `postgres`, matching your current project. If local
socket authentication inside the container requires a password, enter it without
putting it in command history:

```bash
read -rsp 'Postgres password: ' PGPASSWORD; echo
export PGPASSWORD
bash setup.sh
```

Use the same exported container setting for subsequent import/query commands.
The scripts require Bash and Docker access; the importer also uses Python 3 to
parse a JSON file. No package installation is performed.

## Store your actual token

In the frontend, connect to the network where you deployed the token, look it up,
enter its description and additional JSON metadata, and press **Download asset
record**. The download contains addresses read from that deployment, not any
hardcoded local test addresses. Transfer it to your server:

```powershell
scp "PATH_TO_DOWNLOADED_ASSET.json" root@167.233.214.178:~/asset-token-db/asset.json
```

On the server:

```bash
cd ~/asset-token-db
bash import-asset.sh asset.json
bash psql.sh -c 'SELECT asset_id, name, chain_id, token_address, issuer_address, description, metadata FROM public.assets;'
```

The import runs in a transaction and streams JSON through PostgreSQL `COPY` rather
than interpolating descriptions into SQL. Importing the same deployment again
updates its metadata while preserving its original creation date. A different
token, issuer, factory, or creation transaction for an existing asset causes an
error rather than replacing its blockchain link.

`test.sh` checks metadata storage, numeric precision, address validation, and
uniqueness, then rolls back its fixture records. It does not remove saved assets.

## Application connection settings for step 6

For an API running on the server host, the settings are:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=YOUR_EXISTING_POSTGRES_PASSWORD
DB_NAME=asset_token
```

For an API running on your PC, use `DB_HOST=167.233.214.178` when that remote
database port is reachable. An API in another Docker container uses the PostgreSQL
container's network hostname and internal port `5432`.

If using `DATABASE_URL`, its database path must be `/asset_token`. Do not retain
the soccer database path. `?schema=public` is a Prisma setting and is not needed
for a plain PostgreSQL connection. These are server/API settings; never put
database credentials in frontend `VITE_*` variables. This step does not use JWT.

The record stores the existing on-chain `document_hash`; it does not hash or
verify the exported document. Hashing and integrity verification come in steps
7 and 8. The frontend-to-database API link comes in step 6.
