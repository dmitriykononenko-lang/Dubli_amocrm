#!/usr/bin/env bash
# Быстрая НЕразрушающая проверка живости бэкенда Hidden Field (ничего не пишет в БД).
# Использование:
#   BASE=https://hf.example.com KEY=<API_SECURITY_KEY> ACCOUNT=<account_id amoCRM> bash scripts/smoke.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
KEY="${KEY:?задайте KEY=<API_SECURITY_KEY>}"
ACCOUNT="${ACCOUNT:?задайте ACCOUNT=<account_id amoCRM>}"

code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "BASE=$BASE  ACCOUNT=$ACCOUNT"
echo
printf '== /health: '
curl -sf "$BASE/health" || echo "(недоступен)"
echo
echo "== auth без ключа        → ждём 401: HTTP $(code "$BASE/api/config?account_id=$ACCOUNT&user_id=1")"
echo "== auth неверный ключ    → ждём 401: HTTP $(code -H 'X-Security-Key: wrong' "$BASE/api/config?account_id=$ACCOUNT&user_id=1")"
echo "== /api/config верный    → ждём 200: HTTP $(code -H "X-Security-Key: $KEY" "$BASE/api/config?account_id=$ACCOUNT&user_id=1")"
echo "== /api/meta             → 200 = OAuth пройден и amoCRM отвечает; 401 = аккаунт ещё не подключён:"
echo "                            HTTP $(code -H "X-Security-Key: $KEY" "$BASE/api/meta?account_id=$ACCOUNT")"
