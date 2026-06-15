#!/usr/bin/env bash
# Применяет baseline-схему БД (backend/db/schema.sql) к указанной БД.
# Схема идемпотентна — безопасно запускать повторно.
# Использование: DATABASE_URL=postgres://user:pass@host:5432/db bash scripts/apply-schema.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DATABASE_URL:?нужно задать переменную окружения DATABASE_URL}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/db/schema.sql"
echo "schema.sql применён."
