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

Слияние, фоновое сканирование и эндпоинт дублей для виджета — следующие этапы.

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
