#!/usr/bin/env bash
set -euo pipefail

container=soccer-field-booking-management-db-1
db_user=postgres
exec_env=()
if [[ -n "${PGPASSWORD:-}" ]]; then
  exec_env=(--env PGPASSWORD)
fi

echo "Using existing PostgreSQL container: $container"
docker inspect --format '{{.Config.Image}} {{.State.Status}}' "$container"
exists=$(docker exec "${exec_env[@]}" "$container" psql -X -v ON_ERROR_STOP=1 \
  -U "$db_user" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'asset_token'")
if [[ "$exists" != "1" ]]; then
  docker exec "${exec_env[@]}" "$container" psql -X -v ON_ERROR_STOP=1 \
    -U "$db_user" -d postgres -c 'CREATE DATABASE asset_token'
fi

docker exec -i "${exec_env[@]}" "$container" psql -X -v ON_ERROR_STOP=1 \
  -U "$db_user" -d asset_token <<'ASSET_SCHEMA_SQL'
BEGIN;
CREATE TABLE IF NOT EXISTS public.assets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id text NOT NULL CHECK (length(btrim(asset_id)) > 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    description text NOT NULL DEFAULT '',
    asset_type text NOT NULL CHECK (length(btrim(asset_type)) > 0),
    valuation numeric NOT NULL CHECK (
        valuation >= 0 AND valuation = trunc(valuation) AND
        valuation <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    currency text NOT NULL CHECK (length(btrim(currency)) > 0),
    metadata_uri text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    document_hash text NOT NULL CHECK (document_hash ~ '^0x[0-9a-f]{64}$'),
    token_address text NOT NULL CHECK (
        token_address ~ '^0x[0-9a-f]{40}$' AND token_address <> '0x0000000000000000000000000000000000000000'
    ),
    issuer_address text NOT NULL CHECK (
        issuer_address ~ '^0x[0-9a-f]{40}$' AND issuer_address <> '0x0000000000000000000000000000000000000000'
    ),
    factory_address text NOT NULL CHECK (
        factory_address ~ '^0x[0-9a-f]{40}$' AND factory_address <> '0x0000000000000000000000000000000000000000'
    ),
    chain_id numeric NOT NULL CHECK (
        chain_id > 0 AND chain_id = trunc(chain_id) AND
        chain_id <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    creation_transaction_hash text NOT NULL CHECK (creation_transaction_hash ~ '^0x[0-9a-f]{64}$'),
    creation_block bigint NOT NULL CHECK (creation_block >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chain_id, asset_id),
    UNIQUE (chain_id, token_address)
);
COMMIT;
ASSET_SCHEMA_SQL

docker exec "${exec_env[@]}" "$container" psql -X -v ON_ERROR_STOP=1 \
  -U "$db_user" -d asset_token -c '\d public.assets'
echo 'Ready: asset_token.public.assets. Existing soccer databases were not modified.'
