# БД бэкенда — схема

Схема PostgreSQL для бэкенда виджета **Hidden Field** (управление видимостью полей
amoCRM/Kommo). Источник правды — [`schema.sql`](schema.sql).

## Применение

Скрипт идемпотентный (можно запускать повторно):

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require" -f backend/db/schema.sql
# или: DATABASE_URL=... bash backend/scripts/apply-schema.sh
```

Локальная проверка во временной БД (Docker):

```bash
docker run --rm -d --name hf-pg -e POSTGRES_PASSWORD=pg -p 5433:5432 postgres:16-alpine
until docker exec hf-pg pg_isready -U postgres; do sleep 1; done
PGPASSWORD=pg psql -h localhost -p 5433 -U postgres -f backend/db/schema.sql
docker rm -f hf-pg
```

## Таблицы

- **accounts** — подключённые аккаунты amoCRM/Kommo и их настройки (`settings.security_key`).
- **oauth_tokens** — пара OAuth-токенов, зашифрованы at rest (AES-GCM, ключ в KMS).
- **visibility_matrix** — матрица «поле × пользователь» → режим (`O/S/*/B/V`).
  Хранятся только нестандартные режимы (≠ `O`); отсутствие строки = `O` (открыто).
- **audit_log** — аудит (установка, использование токенов, сохранение матрицы).

## Принципы

- **Изоляция по аккаунтам.** Во всех прикладных таблицах есть `account_id`; запросы
  приложения фильтруются по нему (см. `requireAccountId`). Данные одного аккаунта
  недоступны другому.
- **Шифрование токенов.** В `oauth_tokens` хранятся только зашифрованные значения
  (AES-GCM, ключ — во внешнем KMS/секрет-менеджере). Открытых токенов в БД нет.

## Миграции

Текущий `schema.sql` — стартовая (baseline) миграция. При изменении схемы обновляйте
типы Kysely в `src/common/db/database.types.ts` (вручную или через `kysely-codegen`).
