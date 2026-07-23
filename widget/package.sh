#!/usr/bin/env bash
# Сборка архива виджета «Дубли» для загрузки в кабинет разработчика amoCRM.
#
# code и secret_key берутся из widget/.publish.env (в git НЕ коммитится) или из
# переменных окружения WIDGET_CODE / WIDGET_SECRET_KEY. Так секрет не попадает в
# репозиторий: в manifest.json он пустой, а в готовый zip подставляется при сборке.
#
# Использование:
#   cp widget/.publish.env.example widget/.publish.env   # заполнить code+secret_key
#   ./widget/package.sh                                    # → widget/dubli-<version>.zip
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# 1. Секреты: .publish.env (если есть) → переменные окружения.
if [[ -f .publish.env ]]; then
  set -a; # shellcheck disable=SC1091
  source .publish.env; set +a
fi
CODE="${WIDGET_CODE:-}"
SECRET="${WIDGET_SECRET_KEY:-}"
if [[ -z "$CODE" || -z "$SECRET" ]]; then
  echo "✖ Нет WIDGET_CODE / WIDGET_SECRET_KEY." >&2
  echo "  Скопируйте .publish.env.example → .publish.env и впишите code и secret_key" >&2
  echo "  из кабинета разработчика (Настройки → Интеграции → ваша интеграция → Ключи и доступы)." >&2
  exit 1
fi

# 2. Версия из манифеста → имя архива.
VERSION="$(python3 -c 'import json;print(json.load(open("manifest.json"))["widget"]["version"])')"
OUT="$DIR/dubli-${VERSION}.zip"

# 3. Сборка во временной папке (manifest.json с подставленными code+secret_key).
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cp -r manifest.json script.js i18n images "$BUILD/"
python3 - "$BUILD/manifest.json" "$CODE" "$SECRET" <<'PY'
import json, sys
path, code, secret = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(open(path, encoding="utf-8"))
m["widget"]["code"] = code
m["widget"]["secret_key"] = secret
json.dump(m, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
# Лёгкая валидация: обязательные поля на месте.
w = m["widget"]
for f in ("name", "version", "interface_version", "code", "secret_key"):
    assert w.get(f) not in (None, ""), f"widget.{f} пустой"
assert isinstance(w["installation"], bool), "installation должен быть true/false (boolean)"
print(f"manifest ok — code={code[:4]}…, version={w['version']}")
PY

# 4. Zip: manifest.json в КОРНЕ архива, без мусора.
rm -f "$OUT"
( cd "$BUILD" && zip -rq "$OUT" . -x "*.DS_Store" -x "__MACOSX/*" )
echo "✔ Собрано: $OUT"
unzip -l "$OUT" | sed -n '1,12p'
echo ""
echo "Дальше: кабинет разработчика → ваша интеграция → «Загрузить виджет» → выбрать $OUT"
