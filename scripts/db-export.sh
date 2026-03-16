#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="${1:-cartograph}"
OUTPUT="${2:-cartograph-export.sql}"

echo "==> Exporting tables from ${DB_NAME} to ${OUTPUT}..."

docker compose exec -T postgres pg_dump \
  -U cartograph \
  -d "$DB_NAME" \
  --data-only \
  --table=repos \
  --table=files \
  --table=symbols \
  --table=symbol_references \
  > "$OUTPUT"

# Quick stats
LINES=$(wc -l < "$OUTPUT")
SIZE=$(du -h "$OUTPUT" | cut -f1)

echo "==> Exported ${OUTPUT} (${SIZE}, ${LINES} lines)"
echo ""
echo "Tables exported:"
docker compose exec -T postgres psql -U cartograph -d "$DB_NAME" -t -A -c "
  SELECT 'repos: ' || COUNT(*) FROM repos
  UNION ALL
  SELECT 'files: ' || COUNT(*) FROM files
  UNION ALL
  SELECT 'symbols: ' || COUNT(*) FROM symbols
  UNION ALL
  SELECT 'symbol_references: ' || COUNT(*) FROM symbol_references
"
