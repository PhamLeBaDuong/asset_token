#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./common.sh
exec docker exec -i "${exec_env[@]}" "$ASSET_DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U "$ASSET_DB_USER" -d asset_token "$@"
