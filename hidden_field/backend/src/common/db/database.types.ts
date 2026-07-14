import type { ColumnType, GeneratedAlways } from 'kysely';

// =========================================================================
// Типы Kysely, отражающие backend/db/schema.sql 1:1.
// При изменении schema.sql — обновить здесь (вручную или kysely-codegen).
// =========================================================================

// Сущности amoCRM, у которых берём поля для матрицы видимости.
export type EntityType = 'contact' | 'company' | 'lead';

// Режим видимости поля: O открыть · S скрыть · * звёздочки · B блокировать · V воронка.
export type FieldMode = 'O' | 'S' | '*' | 'B' | 'V';

export type AuditAction = 'install' | 'token_use' | 'api_call' | 'matrix_save';

// TIMESTAMPTZ — читаем как Date.
type TsDefault = ColumnType<Date, Date | string | undefined, Date | string>; // есть DEFAULT now()
type TsRequired = ColumnType<Date, Date | string, Date | string>;

// BIGINT — pg возвращает строкой (точность сохраняется): account_id, user_id.
type BigIntStr = ColumnType<string, string | number | bigint, string | number | bigint>;
// GENERATED ALWAYS AS IDENTITY — только чтение, строка.
type IdentityId = GeneratedAlways<string>;

// JSONB: читаем как объект (node-postgres парсит), пишем строкой (JSON.stringify).
type JsonbDefault<T> = ColumnType<T, string | undefined, string>; // есть DEFAULT

export interface AccountSettings {
  security_key?: string;
  backend_url?: string;
  [k: string]: unknown;
}

export interface AccountsTable {
  account_id: BigIntStr;
  subdomain: string;
  status: ColumnType<string, string | undefined, string>;
  plan: string | null;
  settings: JsonbDefault<AccountSettings>;
  installed_at: TsDefault;
  updated_at: TsDefault;
}

export interface OauthTokensTable {
  account_id: BigIntStr;
  access_token_enc: Buffer;
  refresh_token_enc: Buffer;
  nonce: Buffer;
  kms_key_ref: string;
  access_expires_at: TsRequired;
  refresh_expires_at: TsRequired;
  rotated_at: TsDefault;
}

/**
 * Матрица видимости: режим поля для пары «поле × пользователь» в рамках аккаунта.
 * Хранятся только нестандартные режимы (≠ 'O'); отсутствие строки = 'O' (открыто).
 */
export interface VisibilityMatrixTable {
  account_id: BigIntStr;
  user_id: BigIntStr;
  field_id: string; // id поля amoCRM или код системного поля → TEXT
  mode: ColumnType<FieldMode, FieldMode, FieldMode>;
  updated_at: TsDefault;
}

/**
 * Настройки видимости на уровне воронки — их наследует режим V.
 * Хранятся только режимы S, * и B; отсутствие строки = 'O' (открыто).
 */
export interface VisibilityFunnelsTable {
  account_id: BigIntStr;
  pipeline_id: BigIntStr;
  field_id: string; // id поля amoCRM или код системного поля → TEXT
  mode: ColumnType<FieldMode, FieldMode, FieldMode>;
  updated_at: TsDefault;
}

export interface AuditLogTable {
  id: IdentityId;
  account_id: BigIntStr | null;
  actor: string | null;
  action: AuditAction;
  meta: JsonbDefault<Record<string, unknown>>;
  created_at: TsDefault;
}

export interface DB {
  accounts: AccountsTable;
  oauth_tokens: OauthTokensTable;
  visibility_matrix: VisibilityMatrixTable;
  visibility_funnels: VisibilityFunnelsTable;
  audit_log: AuditLogTable;
}
