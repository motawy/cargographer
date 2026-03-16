#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="${1:-cartograph}"
INPUT="${2:-cartograph-export.sql}"

if [ ! -f "$INPUT" ]; then
  echo "Error: ${INPUT} not found"
  exit 1
fi

echo "==> Clearing existing data in ${DB_NAME}..."
docker compose exec -T postgres psql -U cartograph -d "$DB_NAME" -c "
  DELETE FROM symbol_references;
  DELETE FROM symbols;
  DELETE FROM files;
  DELETE FROM repos;
"

echo "==> Importing ${INPUT} into ${DB_NAME}..."
# --single-transaction + SET CONSTRAINTS defers FK checks until commit
# (handles self-referential symbols.parent_symbol_id ordering)
{
  echo "SET CONSTRAINTS ALL DEFERRED;"
  cat "$INPUT"
} | docker compose exec -T postgres psql -U cartograph -d "$DB_NAME" --single-transaction

echo "==> Done. Row counts:"
docker compose exec -T postgres psql -U cartograph -d "$DB_NAME" -t -A -c "
  SELECT 'repos: ' || COUNT(*) FROM repos
  UNION ALL
  SELECT 'files: ' || COUNT(*) FROM files
  UNION ALL
  SELECT 'symbols: ' || COUNT(*) FROM symbols
  UNION ALL
  SELECT 'symbol_references: ' || COUNT(*) FROM symbol_references
"
