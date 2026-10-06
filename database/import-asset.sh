#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! -f "$1" ]]; then
  echo 'Usage: bash database/import-asset.sh /path/to/downloaded-asset.json' >&2
  exit 1
fi
# Read the input before changing directory so relative file paths work.
exec 3< "$1"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v python3 >/dev/null
# JSON escapes literal control characters, so these CSV delimiters cannot occur
# in the compact JSON payload. COPY streams the document without SQL interpolation.
python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=True, separators=(",", ":"), allow_nan=False))' <&3 |
  bash ./psql.sh --single-transaction \
    -c 'CREATE TEMP TABLE asset_import (payload jsonb NOT NULL) ON COMMIT DROP' \
    -c "COPY asset_import (payload) FROM STDIN WITH (FORMAT csv, DELIMITER E'\\x01', QUOTE E'\\x02')" \
    -c "$(cat ./sql/import-asset.sql)"
