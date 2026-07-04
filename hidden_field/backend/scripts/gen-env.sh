#!/usr/bin/env bash
# Генерирует backend/.env со случайными секретами (TOKEN_ENC_KEY, API_SECURITY_KEY).
# AMOCRM_* оставляет пустыми — заполните после создания приватной интеграции.
# Не перезаписывает существующий .env.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$HERE/.env"

if [ -f "$ENV_FILE" ]; then
  echo ".env уже существует — не перезаписываю: $ENV_FILE"
  exit 0
fi

TOKEN_ENC_KEY="$(openssl rand -base64 32)"
API_SECURITY_KEY="$(openssl rand -hex 24)"

cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
LOG_LEVEL=log

# Для docker compose DATABASE_URL переопределяется на сервис db.
# Значение ниже — для запуска без Docker (npm run start:prod).
DATABASE_URL=postgres://postgres:pg@localhost:5432/hidden_field
DATABASE_SSL=false

# Шифрование токенов (AES-256-GCM) — сгенерировано.
TOKEN_ENC_KEY=$TOKEN_ENC_KEY
KMS_PROVIDER=env

# Приватная интеграция amoCRM — ЗАПОЛНИТЬ после её создания:
AMOCRM_CLIENT_ID=
AMOCRM_CLIENT_SECRET=
AMOCRM_REDIRECT_URI=https://REPLACE-ME.example.com/oauth/callback

# Ключ доступа виджета к /api/* — сгенерирован. Тот же впишите в настройку виджета api_token.
API_SECURITY_KEY=$API_SECURITY_KEY
AMOCRM_RATE_LIMIT_RPS=7
EOF

echo "Создан: $ENV_FILE"
echo
echo "  API_SECURITY_KEY = $API_SECURITY_KEY"
echo "  ^ впишите это значение в настройку виджета «api_token»."
echo
echo "Осталось заполнить в .env: AMOCRM_CLIENT_ID, AMOCRM_CLIENT_SECRET, AMOCRM_REDIRECT_URI"
echo "(REDIRECT_URI = <публичный HTTPS туннеля>/oauth/callback)."
