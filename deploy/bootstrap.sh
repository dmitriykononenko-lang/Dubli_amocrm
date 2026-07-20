#!/usr/bin/env bash
# Первичная настройка Dubli на сервере. Запускать ИЗ КОРНЯ склонированного репозитория:
#   bash deploy/bootstrap.sh
# Идемпотентно: если .env уже есть — не перезаписывает.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/3 Проверка Docker =="
docker --version
if ! docker compose version >/dev/null 2>&1; then
  echo "compose-плагин отсутствует — устанавливаю…"
  apt-get update -y && apt-get install -y docker-compose-plugin
fi
docker compose version

echo
echo "== 2/3 Подготовка .env =="
if [ -f .env ]; then
  echo ".env уже существует — оставляю как есть."
else
  cp .env.example .env
  # Безопасные значения генерируем на сервере (в git не попадают — .env в .gitignore).
  ENC="$(openssl rand -base64 32)"
  WK="$(openssl rand -hex 24)"
  PGP="$(openssl rand -hex 16)"
  sed -i "s#^TOKEN_ENC_KEY=.*#TOKEN_ENC_KEY=${ENC}#" .env
  sed -i "s#^WEBHOOK_SECURITY_KEY=.*#WEBHOOK_SECURITY_KEY=${WK}#" .env
  sed -i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${PGP}#" .env
  echo "Создан .env; сгенерированы TOKEN_ENC_KEY, WEBHOOK_SECURITY_KEY, POSTGRES_PASSWORD."
fi

echo
echo "== 3/3 Осталось вписать вручную в .env (nano .env) =="
echo "  AMOCRM_CLIENT_ID       — из приватной интеграции amoCRM"
echo "  AMOCRM_CLIENT_SECRET   — из приватной интеграции amoCRM"
echo "  AMOCRM_REDIRECT_URI    = https://<ВАШ-ДОМЕН>/oauth/callback"
echo "  (опционально) S3_BUCKET и AWS_* — для бэкапов БД в S3"
echo
echo "Затем поднять сервисы:"
echo "  docker compose up -d --build"
echo "  curl -s localhost:3000/health   # ожидаем ok"
echo
echo "ВНИМАНИЕ: WEBHOOK_SECURITY_KEY понадобится в настройках виджета и в URL вебхука."
echo "Посмотреть его на сервере:  grep '^WEBHOOK_SECURITY_KEY=' .env"
echo "(в публичный чат значение НЕ вставлять)"
