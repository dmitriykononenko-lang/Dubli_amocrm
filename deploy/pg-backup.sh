#!/usr/bin/env bash
# Логический дамп PostgreSQL из docker-compose + выгрузка в S3.
# ВАЖНО: диск сервера эфемерный — дампы обязательно уносим наружу (S3).
# Требует: docker compose (сервис db из docker-compose.yml) и awscli (для S3).
# Конфиг берётся из .env проекта (POSTGRES_*) + переменные S3 ниже.
# Запуск вручную:  bash deploy/pg-backup.sh
# По расписанию:   см. deploy/pg-backup.cron
set -euo pipefail

# Корень проекта (где docker-compose.yml и .env), независимо от места вызова.
cd "$(dirname "$0")/.."
set -a
[ -f .env ] && . ./.env
set +a

TS="$(date +%Y%m%d-%H%M%S)"
DIR="${BACKUP_DIR:-/opt/dubli/backups}"
mkdir -p "$DIR"
FILE="$DIR/dubli-${TS}.sql.gz"

echo "[$(date -Is)] dump → $FILE"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-dubli}" -d "${POSTGRES_DB:-dubli}" \
  | gzip -9 >"$FILE"
echo "  size: $(du -h "$FILE" | cut -f1)"

# Выгрузка в S3-совместимое хранилище (например Selectel S3), если задан бакет.
if [ -n "${S3_BUCKET:-}" ]; then
  aws s3 cp "$FILE" "s3://${S3_BUCKET}/dubli/${TS}.sql.gz" \
    ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"}
  echo "  uploaded: s3://${S3_BUCKET}/dubli/${TS}.sql.gz"
else
  echo "  S3_BUCKET не задан — дамп только локально (для эфемерного диска настройте S3!)"
fi

# Локальная ротация: оставляем последние BACKUP_KEEP файлов.
KEEP="${BACKUP_KEEP:-14}"
ls -1t "$DIR"/dubli-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "[$(date -Is)] готово (локально храним последние $KEEP)"
