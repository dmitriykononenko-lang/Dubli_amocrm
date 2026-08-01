-- Dubli — виджет поиска и объединения дублей для amoCRM/Kommo
-- Схема БД бэкенда (Этап 1 — Проектирование). PostgreSQL.
-- Применяется на Selectel managed PostgreSQL. Идемпотентно: безопасно запускать повторно.
-- Изоляция данных по account_id присутствует во всех прикладных таблицах (152-ФЗ, §8 ТЗ).

BEGIN;

-- =========================================================================
-- ENUM-типы (идемпотентно через DO/EXCEPTION — CREATE TYPE не поддерживает IF NOT EXISTS)
-- =========================================================================
DO $$ BEGIN
  CREATE TYPE entity_type AS ENUM ('contact', 'company', 'lead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE key_type AS ENUM ('phone', 'email', 'inn', 'name', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rule_operator AS ENUM ('AND', 'OR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE merge_mode AS ENUM ('auto', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE scan_status AS ENUM ('queued', 'running', 'paused', 'done', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM
    ('install', 'token_use', 'webhook', 'api_call', 'merge', 'rollback', 'scan');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('trial', 'active', 'past_due', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_source AS ENUM ('yookassa', 'invoice', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method_type AS ENUM ('card', 'invoice', 'none');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('issued', 'paid', 'canceled', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ожидание оплаты по счёту — новый статус подписки. PG12+ допускает ADD VALUE в транзакции
-- (значение не используется в этой же транзакции — только в коде приложения).
ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'awaiting_invoice_payment';

-- =========================================================================
-- accounts — подключённые аккаунты amoCRM/Kommo (биллинг за аккаунт)
-- =========================================================================
CREATE TABLE IF NOT EXISTS accounts (
  account_id   BIGINT PRIMARY KEY,                       -- id аккаунта amoCRM (из JWT)
  subdomain    TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'active',     -- active | suspended | uninstalled
  plan         TEXT,                                      -- тариф (монетизация за аккаунт)
  settings     JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- настройки виджета
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- oauth_tokens — пара токенов OAuth, зашифровано at rest (AES-GCM, ключ в KMS), §7.3/§8
-- =========================================================================
CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id         BIGINT      PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  access_token_enc   BYTEA       NOT NULL,                -- шифртекст access_token (AES-GCM)
  refresh_token_enc  BYTEA       NOT NULL,                -- шифртекст refresh_token (AES-GCM)
  nonce              BYTEA       NOT NULL,                 -- GCM nonce/IV
  kms_key_ref        TEXT        NOT NULL,                 -- ссылка на ключ в KMS/секрет-менеджере
  access_expires_at  TIMESTAMPTZ NOT NULL,                -- ~24 ч
  refresh_expires_at TIMESTAMPTZ NOT NULL,                -- ~3 мес
  rotated_at         TIMESTAMPTZ NOT NULL DEFAULT now()   -- ротация обоих токенов при каждом refresh
);

-- =========================================================================
-- entities — реплика ключевых полей сущностей (индекс на стороне бэкенда), §7.3
-- =========================================================================
CREATE TABLE IF NOT EXISTS entities (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  entity_type entity_type NOT NULL,
  amo_id      BIGINT      NOT NULL,                        -- id сущности в amoCRM
  key_fields  JSONB       NOT NULL DEFAULT '{}'::jsonb,    -- снимок исходных ключевых полей
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, entity_type, amo_id)
);
CREATE INDEX IF NOT EXISTS idx_entities_account ON entities (account_id, entity_type);

-- =========================================================================
-- entity_keys — нормализованные ключи для поиска дублей. Основной механизм обнаружения, §6.2
-- =========================================================================
CREATE TABLE IF NOT EXISTS entity_keys (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  entity_id   BIGINT      NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entity_type entity_type NOT NULL,
  key_type    key_type    NOT NULL,
  key_hash    BYTEA       NOT NULL,                        -- SHA-256(key_type || ':' || normalized)
  key_norm    TEXT        NOT NULL                         -- нормализованное значение (отладка/нечёткое)
);
-- основной индекс обнаружения дублей: точное совпадение по нормализованному ключу
CREATE INDEX IF NOT EXISTS idx_entity_keys_lookup
  ON entity_keys (account_id, entity_type, key_type, key_hash);
CREATE INDEX IF NOT EXISTS idx_entity_keys_entity
  ON entity_keys (entity_id);
-- Нечёткое сравнение (2-я итерация, опционально): требует расширение pg_trgm.
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
--   CREATE INDEX IF NOT EXISTS idx_entity_keys_trgm
--     ON entity_keys USING gin (key_norm gin_trgm_ops);

-- =========================================================================
-- rules — правила поиска дублей (поля + AND/OR). Несколько правил на сущность, между ними OR. §4.4
-- =========================================================================
CREATE TABLE IF NOT EXISTS rules (
  id          BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT        NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  entity_type entity_type   NOT NULL,
  name        TEXT          NOT NULL,
  fields      JSONB         NOT NULL DEFAULT '[]'::jsonb,  -- [{ "key_type": "...", "field_id": 123 }]
  operator    rule_operator NOT NULL DEFAULT 'AND',
  auto_merge  BOOLEAN       NOT NULL DEFAULT FALSE,         -- автообъединение по умолчанию ВЫКЛ (§5.2)
  enabled     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rules_account
  ON rules (account_id, entity_type) WHERE enabled;

-- =========================================================================
-- merge_journal — журнал объединений (кто, когда, что), §6.4
-- =========================================================================
CREATE TABLE IF NOT EXISTS merge_journal (
  id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  entity_type      entity_type NOT NULL,
  master_amo_id    BIGINT      NOT NULL,
  duplicate_amo_id BIGINT      NOT NULL,
  mode             merge_mode  NOT NULL,
  author_user_id   BIGINT,                                 -- пользователь amoCRM (NULL при авто)
  transferred      JSONB       NOT NULL DEFAULT '{}'::jsonb,-- перенесённые связи (сделки/задачи/...)
  rolled_back_at   TIMESTAMPTZ,                            -- когда объединение откатили (NULL — активно)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- На случай применения к БД, созданной до добавления колонки отката.
ALTER TABLE merge_journal ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_merge_journal_account
  ON merge_journal (account_id, created_at DESC);

-- =========================================================================
-- snapshots — снимки дублей для отката, срок хранения по умолчанию 30 дней, §6.4
-- =========================================================================
CREATE TABLE IF NOT EXISTS snapshots (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merge_id    BIGINT      NOT NULL REFERENCES merge_journal(id) ON DELETE CASCADE,
  account_id  BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  entity_type entity_type NOT NULL,
  amo_id      BIGINT      NOT NULL,
  payload     JSONB       NOT NULL,                         -- полный снимок дубля для восстановления
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);
CREATE INDEX IF NOT EXISTS idx_snapshots_expiry ON snapshots (expires_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_merge  ON snapshots (merge_id);

-- =========================================================================
-- scan_jobs — фоновые задачи массового сканирования (прогресс/пауза/докачка), §5.3/§7.4
-- =========================================================================
CREATE TABLE IF NOT EXISTS scan_jobs (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  entity_type entity_type NOT NULL,
  status      scan_status NOT NULL DEFAULT 'queued',
  progress    INTEGER     NOT NULL DEFAULT 0,
  total       INTEGER     NOT NULL DEFAULT 0,
  cursor      TEXT,                                         -- докачка по _links.next
  params      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_account ON scan_jobs (account_id, status);

-- =========================================================================
-- webhook_events — идемпотентность приёма вебхуков (дедуп по event_id), §7.3
-- =========================================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  account_id   BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  event_id     TEXT        NOT NULL,
  type         TEXT        NOT NULL,                        -- add_contact | update_lead | ...
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, event_id)
);

-- =========================================================================
-- audit_log — аудит (токены, вебхуки, вызовы API, merge/rollback), §8
-- =========================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT       REFERENCES accounts(account_id) ON DELETE SET NULL,
  actor      TEXT,                                          -- user id / 'system'
  action     audit_action NOT NULL,
  meta       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log (account_id, created_at DESC);

-- =========================================================================
-- subscriptions — подписка клиента (одна на аккаунт). Источник истины по оплате
-- и дате продления: виджет в amoМаркете «Внешняя оплата», amoCRM «оплачено до» не хранит.
-- =========================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  account_id    BIGINT              PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  status        subscription_status NOT NULL DEFAULT 'trial',
  users         INTEGER,                                    -- параметры последней оплаты
  months        INTEGER,
  paid_till     TIMESTAMPTZ,                                -- оплачено до = дата продления (UTC)
  trial_ends_at TIMESTAMPTZ,                                -- конец пробного периода
  created_at    TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ         NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_paid_till ON subscriptions (paid_till);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);
-- Два трека оплаты (карта-рекуррент / счёт) + льготный период для банковского перевода.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method payment_method_type NOT NULL DEFAULT 'none';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS yk_payment_method_id TEXT;   -- токен сохранённой карты ЮKassa
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;      -- последнее напоминание об истечении

-- =========================================================================
-- payments — история платежей и ручных корректировок (аудит биллинга).
-- payment_id уникален (идемпотентность вебхуков ЮKassa); NULL для invoice/manual.
-- =========================================================================
CREATE TABLE IF NOT EXISTS payments (
  id          BIGINT         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT         NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  amount      NUMERIC(12,2),                                -- сумма в рублях (NULL — ручной сдвиг без суммы)
  users       INTEGER,
  months      INTEGER,
  source      payment_source NOT NULL,                      -- yookassa | invoice | manual
  payment_id  TEXT,                                         -- id платежа ЮKassa (идемпотентность)
  reason      TEXT,                                         -- причина (для manual/suspend/resume)
  actor       TEXT,                                         -- кто (vendor-admin / system / yookassa)
  paid_till   TIMESTAMPTZ,                                  -- снимок даты продления после операции
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  UNIQUE (payment_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_account ON payments (account_id, created_at DESC);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'RUB';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT;

-- =========================================================================
-- invoices — трек оплаты по счёту (юрлицо, банковский перевод). Продление после
-- подтверждения поступления (стадия сделки «Оплачен» или вручную). Матчинг по number.
-- =========================================================================
CREATE TABLE IF NOT EXISTS invoices (
  id             BIGINT         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     BIGINT         NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  number         TEXT           NOT NULL UNIQUE,                 -- референс в назначении платежа
  amount         NUMERIC(12,2),
  period_months  INTEGER,
  users          INTEGER,
  status         invoice_status NOT NULL DEFAULT 'issued',
  vendor_deal_id TEXT,                                           -- сделка-счёт в koagency
  issued_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices (account_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_deal ON invoices (vendor_deal_id);

COMMIT;
