-- Hidden Field — виджет управления видимостью полей amoCRM/Kommo
-- Схема БД бэкенда. PostgreSQL. Идемпотентно: безопасно запускать повторно.
-- Изоляция данных по account_id присутствует во всех прикладных таблицах.

BEGIN;

-- =========================================================================
-- ENUM-типы (идемпотентно через DO/EXCEPTION — CREATE TYPE не поддерживает IF NOT EXISTS)
-- =========================================================================
DO $$ BEGIN
  -- O открыть · S скрыть · * звёздочки · B блокировать · V воронка
  CREATE TYPE field_mode AS ENUM ('O', 'S', '*', 'B', 'V');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM ('install', 'token_use', 'api_call', 'matrix_save');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- accounts — подключённые аккаунты amoCRM/Kommo (биллинг за аккаунт)
-- =========================================================================
CREATE TABLE IF NOT EXISTS accounts (
  account_id   BIGINT PRIMARY KEY,                       -- id аккаунта amoCRM
  subdomain    TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'active',     -- active | suspended | uninstalled
  plan         TEXT,                                      -- тариф (монетизация за аккаунт)
  settings     JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- настройки виджета (в т.ч. security_key)
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================================
-- oauth_tokens — пара токенов OAuth, зашифровано at rest (AES-GCM, ключ в KMS)
-- =========================================================================
CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id         BIGINT      PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  access_token_enc   BYTEA       NOT NULL,                -- шифртекст access_token (AES-GCM)
  refresh_token_enc  BYTEA       NOT NULL,                -- шифртекст refresh_token (AES-GCM)
  nonce              BYTEA       NOT NULL,                 -- GCM nonce/IV (access || refresh)
  kms_key_ref        TEXT        NOT NULL,                 -- ссылка на ключ в KMS/секрет-менеджере
  access_expires_at  TIMESTAMPTZ NOT NULL,                -- ~24 ч
  refresh_expires_at TIMESTAMPTZ NOT NULL,                -- ~3 мес
  rotated_at         TIMESTAMPTZ NOT NULL DEFAULT now()   -- ротация обоих токенов при каждом refresh
);

-- =========================================================================
-- visibility_matrix — матрица «поле × пользователь» → режим видимости.
-- Хранятся только нестандартные режимы (≠ 'O'); отсутствие строки = 'O' (открыто).
-- =========================================================================
CREATE TABLE IF NOT EXISTS visibility_matrix (
  account_id BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL,                         -- id пользователя amoCRM
  field_id   TEXT        NOT NULL,                         -- id поля amoCRM или код системного поля
  mode       field_mode  NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id, field_id)
);
-- быстрый разрез по пользователю (применение режимов в карточке)
CREATE INDEX IF NOT EXISTS idx_visibility_matrix_user
  ON visibility_matrix (account_id, user_id);

-- =========================================================================
-- visibility_funnels — настройки видимости на уровне воронки (для режима V).
-- Когда ячейка «поле × пользователь» = V, пользователь наследует режим воронки
-- для этого поля. Хранятся только режимы S/*/B (O = по умолчанию, не хранится).
-- =========================================================================
CREATE TABLE IF NOT EXISTS visibility_funnels (
  account_id  BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  pipeline_id BIGINT      NOT NULL,                        -- id воронки amoCRM
  field_id    TEXT        NOT NULL,                        -- id поля amoCRM или код системного поля
  mode        field_mode  NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, pipeline_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_visibility_funnels_pipeline
  ON visibility_funnels (account_id, pipeline_id);

-- =========================================================================
-- audit_log — аудит (установка, использование токенов, сохранение матрицы)
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

COMMIT;
