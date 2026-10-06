#!/usr/bin/env bash
# Uses the PostgreSQL container already running on the remote server.
# Never starts containers or installs PostgreSQL.
ASSET_DB_CONTAINER=${ASSET_DB_CONTAINER:-soccer-field-booking-management-db-1}
ASSET_DB_USER=${ASSET_DB_USER:-postgres}
export ASSET_DB_CONTAINER ASSET_DB_USER
exec_env=()
if [[ -n "${PGPASSWORD:-}" ]]; then
  exec_env=(--env PGPASSWORD)
fi
