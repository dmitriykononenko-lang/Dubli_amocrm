# Hidden Field — бэкенд

Серверное ядро виджета **Hidden Field** (управление видимостью полей amoCRM/Kommo).
Стек: **NestJS + TypeScript**, доступ к PostgreSQL через **`pg` + Kysely**. Схема БД —
`db/schema.sql` (источник правды, применяется отдельно, не через ORM-миграции).

> Ядро (OAuth, шифрование токенов, клиент amoCRM v4, изоляция по аккаунту) унаследовано
> от проверенного бэкенда виджета «Поиск дублей»; логика дублей удалена, добавлены
> хранение матрицы видимости и выдача конфигурации виджету.

## Возможности

- OAuth 2.0 с amoCRM, шифрованное хранение токенов (AES-256-GCM, ключ за интерфейсом KMS),
  авто-refresh.
- API-клиент amoCRM v4 (троттлинг ~7 rps, ретраи): чтение полей, пользователей и воронок.
- Хранение матрицы «поле × сотрудник» → режим (`O/S/*/B/V`) с изоляцией по аккаунту.
- API для виджета: метаданные для экрана настроек, конфигурация режимов для текущего
  пользователя, сохранение матрицы.

## API

Аутентификация всех `/api/*`: `account_id` в query + `security_key` в заголовке
`X-Security-Key` (приоритет — `accounts.settings.security_key`, фолбэк — env
`API_SECURITY_KEY`). В настройках виджета это значение задаётся в поле `api_token`.

### `GET /api/meta?account_id=`

Данные для экрана настроек: поля (по сущностям), пользователи, воронки и текущая матрица.
Системные поля (название, бюджет, ответственный, теги) добавляются сервером с id вида
`sys_<entity>_<code>`; остальные поля — кастомные поля amoCRM.

```jsonc
{
  "fields": [
    { "id": "sys_lead_price", "name": "Бюджет", "entity": "lead", "system": true },
    { "id": "111", "name": "Источник", "entity": "lead" }
  ],
  "users":     [{ "id": "500", "name": "Менеджер" }],
  "pipelines": [{ "id": "1", "name": "Продажи" }],
  "matrix":    { "111:500": "S" },   // "field:user" -> mode (только режимы ≠ O)
  "groups":    []                     // виртуальные группы — следующая очередь
}
```

### `GET /api/config?account_id=&user_id=`

Режимы полей для пользователя — в формате, который применяет `resolveMode()` во фронтенде.

```jsonc
{
  "rules":   { "111": { "*": { "*": "S" } } },  // rules[fieldId][entity][pipeline] = mode
  "funnels": { "7": { "111": "S" } }             // настройки воронок — их наследует режим V
}
```

### `POST /api/matrix?account_id=`

Полное сохранение матрицы (тело `{ "matrix": { "field:user": mode } }`). Режим `O`
(по умолчанию) и кривые ключи отбрасываются. Возвращает `{ "saved": <число строк> }`.

```bash
curl -X POST 'http://localhost:3000/api/matrix?account_id=123' \
  -H 'X-Security-Key: <key>' -H 'Content-Type: application/json' \
  -d '{ "matrix": { "111:500": "S", "222:500": "B" } }'
```

### `POST /api/funnels?account_id=`

Настройки видимости на уровне воронки (их наследует режим `V`). Тело
`{ "funnels": { "pipeline:field": mode } }`, допустимы режимы `S`/`*`/`B`.
Полная замена; возвращает `{ "saved": <число> }`.

```bash
curl -X POST 'http://localhost:3000/api/funnels?account_id=123' \
  -H 'X-Security-Key: <key>' -H 'Content-Type: application/json' \
  -d '{ "funnels": { "7:111": "S", "7:222": "B" } }'
```

## Быстрый старт (Docker Compose)

Поднимает Postgres + бэкенд одной командой; схема БД применяется автоматически
при первом старте:

```bash
cd hidden_field/backend
bash scripts/gen-env.sh          # создаст .env со сгенерированными ключами
# впишите в .env: AMOCRM_CLIENT_ID, AMOCRM_CLIENT_SECRET, AMOCRM_REDIRECT_URI
docker compose up --build        # http://localhost:3000 ; проверка: GET /health
```

`gen-env.sh` печатает `API_SECURITY_KEY` — впишите его в настройку виджета `api_token`.
Наружу по HTTPS пробрасывается туннелем (`cloudflared`/`ngrok`) на порт 3000.

> Схема применяется только при пустом томе БД. После правок `db/schema.sql`
> пересоздайте БД: `docker compose down -v && docker compose up --build`.

## Прод-развёртывание (Docker + Caddy)

Приложение за Caddy с автоматическим HTTPS (Let's Encrypt); БД по умолчанию —
внешняя managed PostgreSQL. Нужен сервер с публичным доменом (A-запись на сервер,
открыты порты 80/443).

1. Соберите `.env` (`bash scripts/gen-env.sh`, затем допишите прод-значения):
   ```ini
   DOMAIN=hf.example.com
   ACME_EMAIL=admin@example.com
   DATABASE_URL=postgres://user:pass@managed-pg-host:5432/hidden_field?sslmode=require
   DATABASE_SSL=true
   AMOCRM_REDIRECT_URI=https://hf.example.com/oauth/callback
   # + AMOCRM_CLIENT_ID / AMOCRM_CLIENT_SECRET / TOKEN_ENC_KEY / API_SECURITY_KEY
   ```
2. Примените схему к managed PG (однократно, нужен `psql`):
   ```bash
   DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)" bash scripts/apply-schema.sh
   ```
3. Запуск:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
4. Проверка (ничего не пишет в БД):
   ```bash
   BASE=https://hf.example.com KEY=<API_SECURITY_KEY> ACCOUNT=<account_id> bash scripts/smoke.sh
   ```

**Postgres на том же сервере** (вместо managed): в `.env` укажите
`DATABASE_URL=postgres://postgres:pg@db:5432/hidden_field` и `DATABASE_SSL=false`, затем
```bash
docker compose -f docker-compose.prod.yml --profile bundled-db up -d --build
```

## Требования

- Node.js ≥ 20 (разработка на 22).
- PostgreSQL 16 (локально — Docker).
- `psql` в PATH (для `npm run db:apply`).

## Установка и запуск

```bash
cd hidden_field/backend
npm ci                  # или npm install
cp .env.example .env    # заполнить TOKEN_ENC_KEY, DATABASE_URL, AMOCRM_*, API_SECURITY_KEY
openssl rand -base64 32 # сгенерировать TOKEN_ENC_KEY (32 байта)
npm run build
npm run start:dev       # http://localhost:3000 ; проверка: GET /health
```

## База данных (локально)

```bash
docker run --rm -d --name hf-pg -e POSTGRES_PASSWORD=pg -p 5433:5432 postgres:16-alpine
until docker exec hf-pg pg_isready -U postgres; do sleep 1; done
DATABASE_URL=postgres://postgres:pg@localhost:5433/postgres npm run db:apply
```

> При изменении `db/schema.sql` обновите типы Kysely в `src/common/db/database.types.ts`.

## Тесты

- **Юнит** (без БД/сети): `npm test` — логика сервиса видимости, crypto, oauth/tokens с моками.
- **e2e** (нужен PostgreSQL): `npm run test:e2e`. Поднимет PostgreSQL через testcontainers
  (нужен Docker) либо использует `DATABASE_URL_TEST`. Без Docker и без `DATABASE_URL_TEST`
  e2e-тесты с БД пропускаются.

```bash
DATABASE_URL_TEST=postgres://postgres:pg@localhost:5433/postgres npm run test:e2e
```
