#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
echo "Using existing container: $ASSET_DB_CONTAINER"
# Fixed database name; do not run migrations in the soccer databases.
exists=$(docker exec "${exec_env[@]}" "$ASSET_DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U "$ASSET_DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'asset_token'")
if [[ "$exists" != "1" ]]; then
  docker exec "${exec_env[@]}" "$ASSET_DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
    -U "$ASSET_DB_USER" -d postgres -c 'CREATE DATABASE asset_token'
fi
bash ./psql.sh -f - < ./sql/001-assets.sql
echo 'asset_token database and assets table are ready in the existing container.'
bash ./psql.sh -c '\d public.assets'
