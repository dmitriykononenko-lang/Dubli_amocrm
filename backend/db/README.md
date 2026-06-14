# БД бэкенда — схема (Этап 1)

Схема PostgreSQL для бэкенда виджета «Поиск и объединение дублей». Рассчитана на
**Selectel managed PostgreSQL** (защищённый сегмент «Облако ФЗ-152»). Подробное описание
модели — в [`docs/db-schema.md`](../../docs/db-schema.md).

## Применение

Скрипт идемпотентный (можно запускать повторно):

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require" -f backend/db/schema.sql
```

Локальная проверка во временной БД (Docker):

```bash
docker run --rm -d --name dubli-pg -e POSTGRES_PASSWORD=pg -p 5433:5432 postgres:16-alpine
until docker exec dubli-pg pg_isready -U postgres; do sleep 1; done
PGPASSWORD=pg psql -h localhost -p 5433 -U postgres -f backend/db/schema.sql
docker rm -f dubli-pg
```

## Принципы

- **Изоляция по аккаунтам.** Во всех прикладных таблицах есть `account_id`; запросы приложения
  обязаны фильтроваться по нему (152-ФЗ, §8 ТЗ). Данные одного аккаунта недоступны другому.
- **Шифрование токенов.** В `oauth_tokens` хранятся только зашифрованные значения (AES-GCM,
  ключ — во внешнем KMS/секрет-менеджере; провайдер под Selectel уточняется на Этапе 3).
  Открытых токенов в БД нет.
- **Индекс поиска дублей.** Обнаружение идёт по `entity_keys` (btree по
  `account_id, entity_type, key_type, key_hash`), а не перебором API amoCRM (§6.2/§7.3).
- **Локализация данных.** Первичная БД с ПДн размещается в РФ (152-ФЗ, ст. 18 ч. 5).

## Миграции

Для Этапа 3 рекомендуется завести инструмент миграций под выбранный стек (например, для NestJS —
TypeORM/Prisma/`node-pg-migrate`). Текущий `schema.sql` — стартовая (baseline) миграция.
