# Dubli — бэкенд (Этап 3, ядро)

Серверное ядро виджета поиска и объединения дублей amoCRM. Стек: **NestJS + TypeScript**,
доступ к PostgreSQL через **`pg` + Kysely**. Схема БД — `db/schema.sql` (источник правды,
применяется отдельно, не через ORM-миграции).

## Возможности ядра (этот этап)

- OAuth 2.0 с amoCRM, шифрованное хранение токенов (AES-256-GCM, ключ за интерфейсом KMS).
- API-клиент amoCRM v4 (троттлинг ~7 rps, ретраи, авто-refresh токенов).
- Приём вебхуков (`POST /webhooks/amo`): проверка `security_key`, идемпотентность, первичная
  индексация в `entities`/`entity_keys`.
- Сервис нормализации ключей (телефон/email/ИНН/имя → `key_hash`).
- Поиск дублей для плашки виджета: `GET /api/duplicates` — обнаружение по общим
  нормализованным ключам с учётом правил аккаунта (AND/OR).
- Объединение дублей: `POST /api/merge` (перенос полей/связей дубля → главную,
  удаление дубля, журнал + снимки) и `POST /api/merge/:id/rollback` (откат).
- Конфигурирование: CRUD правил (`/api/rules`) и настройки дедупликации (`/api/settings`).
- Фоновое массовое сканирование (`/api/scan`): постраничная индексация базы аккаунта
  с прогрессом, паузой и докачкой по `_links.next`.

## API

### `GET /api/duplicates`

Возвращает дубли проиндексированной сущности для плашки в карточке. Аутентификация —
как у вебхуков: `security_key` per-account (фолбэк — env `WEBHOOK_SECURITY_KEY`).

| Параметр | Где | Описание |
|---|---|---|
| `account_id` | query | id аккаунта amoCRM (обязателен) |
| `entity_type` | query | `contact`/`company`/`lead` (принимается и множественное число) |
| `amo_id` | query | id сущности в amoCRM (целое) |
| `security_key` | заголовок `X-Security-Key` или query | ключ доступа |

```bash
curl 'http://localhost:3000/api/duplicates?account_id=123&entity_type=contact&amo_id=456' \
  -H 'X-Security-Key: <key>'
```

```jsonc
{
  "entity": { "entity_type": "contact", "amo_id": "456", "indexed": true },
  "count": 1,
  "duplicates": [
    {
      "amo_id": "789",
      "name": "Иван Петров",
      "matched_keys": [{ "key_type": "phone", "key_norm": "9991112233" }],
      "matched_rules": ["По телефону"]   // имена сработавших правил; [] при фолбэке
    }
  ]
}
```

Обнаружение работает по индексу `entity_keys` (перебора API amoCRM нет, §6.2). Правила
(`rules`) комбинируют ключи через AND/OR, между правилами — OR; без включённых правил
дублем считается любая сущность с общим ключом. Если сущности ещё нет в индексе —
`indexed: false`, `duplicates: []` (придёт после вебхука/сканирования).

### `POST /api/merge` и `POST /api/merge/:id/rollback`

Объединяет дубль с главной записью и позволяет откатить. Аутентификация — та же
(`account_id` в query, `security_key` в заголовке/query). Тело — JSON.

```bash
curl -X POST 'http://localhost:3000/api/merge?account_id=123' \
  -H 'X-Security-Key: <key>' -H 'Content-Type: application/json' \
  -d '{"entity_type":"contact","master_amo_id":456,"duplicate_amo_id":789,"author_user_id":42}'
# → { "mergeId": "1", "master_amo_id": "456", "duplicate_amo_id": "789",
#     "transferred": { "name": false, "field_ids": [...], "links": 2 } }

curl -X POST 'http://localhost:3000/api/merge/1/rollback?account_id=123' -H 'X-Security-Key: <key>'
# → { "mergeId": "1", "master_amo_id": "456", "restored_duplicate_amo_id": "90001" }
```

Атомарного merge-API в amoCRM нет: данные дубля переносятся в главную (gap-fill полей +
перенос связей), дубль удаляется, в `merge_journal`/`snapshots` пишется журнал и снимки.
Откат — best-effort: amoCRM не возвращает прежний id, поэтому дубль воссоздаётся с **новым**
id, поля главной возвращаются к снимку. (Точные эндпоинты links/delete сверить с докой amoCRM.)

### Правила и настройки

- `GET/POST/PATCH/DELETE /api/rules` — правила поиска (`entity_type`, `name`, `fields`
  `[{key_type, field_id?}]`, `operator` AND/OR, `auto_merge`, `enabled`).
- `GET/PUT /api/settings` — `entities` (contact/company/lead) и `prevent_create`
  (хранятся в `accounts.settings.dedup`).

### Фоновое сканирование

- `POST /api/scan` `{ entity_type }` — поставить задачу; `GET /api/scan` — список;
  `GET /api/scan/:id` — статус (`queued|running|paused|done|error`, `progress`);
  `POST /api/scan/:id/pause` и `/resume` — пауза/докачка.

Задачи обрабатывает фоновый процессор (период — `SCAN_POLL_MS`, 0 — выключен): за шаг
индексируется одна страница amoCRM (с тем же движком, что и вебхуки), курсор `_links.next`
сохраняется в `scan_jobs.cursor`. amoCRM v4 не отдаёт общий count — `total` заполняется по
факту завершения.

## Требования

- Node.js ≥ 20 (разработка на 22).
- PostgreSQL 16 (локально — Docker, прод — Selectel managed).
- `psql` в PATH (для `npm run db:apply`).

## Установка и запуск

```bash
cd backend
npm ci                 # или npm install
cp .env.example .env    # заполнить TOKEN_ENC_KEY, DATABASE_URL, AMOCRM_*
openssl rand -base64 32 # сгенерировать TOKEN_ENC_KEY (32 байта)
npm run build
npm run start:dev       # http://localhost:3000 ; проверка: GET /health
```

## База данных (локально)

```bash
docker run --rm -d --name dubli-pg -e POSTGRES_PASSWORD=pg -p 5433:5432 postgres:16-alpine
until docker exec dubli-pg pg_isready -U postgres; do sleep 1; done
DATABASE_URL=postgres://postgres:pg@localhost:5433/postgres npm run db:apply
```

> При изменении `db/schema.sql` обновите типы Kysely в `src/common/db/database.types.ts`
> (вручную или через `kysely-codegen`).

## Тесты

- **Юнит** (без БД/сети): `npm test` — нормализация, crypto, сервисы с моками.
- **e2e** (нужен PostgreSQL): `npm run test:e2e`. Поднимет PostgreSQL через testcontainers
  (нужен Docker) либо использует `DATABASE_URL_TEST`. Без Docker и без `DATABASE_URL_TEST`
  e2e-тесты с БД пропускаются.

```bash
# e2e против внешней БД:
DATABASE_URL_TEST=postgres://postgres:pg@localhost:5433/postgres npm run test:e2e
```

Тесты виджета (фронт) — отдельный набор в корне репозитория: `node test/run-tests.js`.
