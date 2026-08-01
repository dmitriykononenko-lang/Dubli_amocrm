import type { ColumnType, GeneratedAlways } from 'kysely';

// =========================================================================
// Типы Kysely, отражающие backend/db/schema.sql 1:1.
// При изменении schema.sql — обновить здесь (вручную или kysely-codegen).
// =========================================================================

export type EntityType = 'contact' | 'company' | 'lead';
export type KeyType = 'phone' | 'email' | 'inn' | 'name' | 'custom';
export type SubscriptionStatus =
  | 'trial'
  | 'active'
  | 'awaiting_invoice_payment'
  | 'past_due'
  | 'canceled';
export type PaymentSource = 'yookassa' | 'invoice' | 'manual';
export type PaymentMethodType = 'card' | 'invoice' | 'none';
export type InvoiceStatus = 'issued' | 'paid' | 'canceled' | 'expired';
export type RuleOperator = 'AND' | 'OR';
export type MergeMode = 'auto' | 'manual';
export type ScanStatus = 'queued' | 'running' | 'paused' | 'done' | 'error';
export type AuditAction =
  | 'install'
  | 'token_use'
  | 'webhook'
  | 'api_call'
  | 'merge'
  | 'rollback'
  | 'scan';

// TIMESTAMPTZ — читаем как Date.
type TsDefault = ColumnType<Date, Date | string | undefined, Date | string>; // есть DEFAULT now()
type TsRequired = ColumnType<Date, Date | string, Date | string>;
type TsNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

// BIGINT — pg возвращает строкой (точность сохраняется): account_id, amo_id, *_user_id.
type BigIntStr = ColumnType<string, string | number | bigint, string | number | bigint>;
// GENERATED ALWAYS AS IDENTITY — только чтение, строка.
type IdentityId = GeneratedAlways<string>;

// JSONB: читаем как объект (node-postgres парсит), пишем строкой (JSON.stringify).
type JsonbDefault<T> = ColumnType<T, string | undefined, string>; // есть DEFAULT
type JsonbRequired<T> = ColumnType<T, string, string>;

export interface AccountSettings {
  security_key?: string;
  backend_url?: string;
  /** client_id OAuth-интеграции, которой установлен аккаунт (приватная/публичная) — чтобы refresh шёл тем же клиентом. */
  oauth_client_id?: string;
  /** id сделки этого клиента в нашей (Ko:agency) amoCRM — ведём его по этапам биллинга. */
  vendor_lead_id?: string;
  /** id компании клиента в vendor CRM (с полем «ID аккаунта amo»). */
  vendor_company_id?: string;
  /** id контакта клиента в vendor CRM (телефон/email). */
  vendor_contact_id?: string;
  /** Имя аккаунта клиента (из GET /api/v4/account) — для компании/контакта. */
  client_name?: string;
  /** Подписка оплачена до (ISO). Пусто/в прошлом → демо-режим. */
  paid_until?: string;
  /** Телефон клиента (из настроек виджета) — чтобы не дублировать примечание при пересохранении. */
  contact_phone?: string;
  [k: string]: unknown;
}

export interface RuleField {
  key_type: KeyType;
  field_id?: number;
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

export interface EntitiesTable {
  id: IdentityId;
  account_id: BigIntStr;
  entity_type: EntityType;
  amo_id: BigIntStr;
  key_fields: JsonbDefault<Record<string, unknown>>;
  updated_at: TsDefault;
}

export interface EntityKeysTable {
  id: IdentityId;
  account_id: BigIntStr;
  entity_id: BigIntStr;
  entity_type: EntityType;
  key_type: KeyType;
  key_hash: Buffer;
  key_norm: string;
}

export interface RulesTable {
  id: IdentityId;
  account_id: BigIntStr;
  entity_type: EntityType;
  name: string;
  fields: JsonbDefault<RuleField[]>;
  operator: ColumnType<RuleOperator, RuleOperator | undefined, RuleOperator>;
  auto_merge: ColumnType<boolean, boolean | undefined, boolean>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: TsDefault;
}

export interface MergeJournalTable {
  id: IdentityId;
  account_id: BigIntStr;
  entity_type: EntityType;
  master_amo_id: BigIntStr;
  duplicate_amo_id: BigIntStr;
  mode: MergeMode;
  author_user_id: BigIntStr | null;
  transferred: JsonbDefault<Record<string, unknown>>;
  rolled_back_at: TsNullable;
  created_at: TsDefault;
}

export interface SnapshotsTable {
  id: IdentityId;
  merge_id: BigIntStr;
  account_id: BigIntStr;
  entity_type: EntityType;
  amo_id: BigIntStr;
  payload: JsonbRequired<Record<string, unknown>>;
  created_at: TsDefault;
  expires_at: TsDefault;
}

export interface ScanJobsTable {
  id: IdentityId;
  account_id: BigIntStr;
  entity_type: EntityType;
  status: ColumnType<ScanStatus, ScanStatus | undefined, ScanStatus>;
  progress: ColumnType<number, number | undefined, number>;
  total: ColumnType<number, number | undefined, number>;
  cursor: string | null;
  params: JsonbDefault<Record<string, unknown>>;
  started_at: TsNullable;
  finished_at: TsNullable;
  created_at: TsDefault;
}

export interface WebhookEventsTable {
  account_id: BigIntStr;
  event_id: string;
  type: string;
  received_at: TsDefault;
  processed_at: TsNullable;
}

export interface AuditLogTable {
  id: IdentityId;
  account_id: BigIntStr | null;
  actor: string | null;
  action: AuditAction;
  meta: JsonbDefault<Record<string, unknown>>;
  created_at: TsDefault;
}

// NUMERIC(12,2) — pg возвращает строкой; на запись принимаем число/строку.
type NumericStr = ColumnType<string | null, string | number | null | undefined, string | number | null>;

/** Подписка клиента (одна на аккаунт) — источник истины по оплате и дате продления. */
export interface SubscriptionsTable {
  account_id: BigIntStr;
  status: ColumnType<SubscriptionStatus, SubscriptionStatus | undefined, SubscriptionStatus>;
  users: ColumnType<number | null, number | null | undefined, number | null>;
  months: ColumnType<number | null, number | null | undefined, number | null>;
  paid_till: TsNullable;
  trial_ends_at: TsNullable;
  payment_method: ColumnType<PaymentMethodType, PaymentMethodType | undefined, PaymentMethodType>;
  grace_until: TsNullable;
  yk_payment_method_id: ColumnType<string | null, string | null | undefined, string | null>;
  auto_renew: ColumnType<boolean, boolean | undefined, boolean>;
  notified_at: TsNullable;
  created_at: TsDefault;
  updated_at: TsDefault;
}

/** Счёт клиенту (трек оплаты по счёту). Продление после подтверждения поступления. */
export interface InvoicesTable {
  id: IdentityId;
  account_id: BigIntStr;
  number: string;
  amount: NumericStr;
  period_months: ColumnType<number | null, number | null | undefined, number | null>;
  users: ColumnType<number | null, number | null | undefined, number | null>;
  status: ColumnType<InvoiceStatus, InvoiceStatus | undefined, InvoiceStatus>;
  vendor_deal_id: ColumnType<string | null, string | null | undefined, string | null>;
  issued_at: TsDefault;
  paid_at: TsNullable;
}

/** История платежей / ручных корректировок (аудит биллинга). */
export interface PaymentsTable {
  id: IdentityId;
  account_id: BigIntStr;
  amount: NumericStr;
  users: ColumnType<number | null, number | null | undefined, number | null>;
  months: ColumnType<number | null, number | null | undefined, number | null>;
  source: PaymentSource;
  payment_id: ColumnType<string | null, string | null | undefined, string | null>;
  reason: ColumnType<string | null, string | null | undefined, string | null>;
  actor: ColumnType<string | null, string | null | undefined, string | null>;
  paid_till: TsNullable;
  currency: ColumnType<string, string | undefined, string>;
  status: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: TsDefault;
}

export interface DB {
  accounts: AccountsTable;
  oauth_tokens: OauthTokensTable;
  entities: EntitiesTable;
  entity_keys: EntityKeysTable;
  rules: RulesTable;
  merge_journal: MergeJournalTable;
  snapshots: SnapshotsTable;
  scan_jobs: ScanJobsTable;
  webhook_events: WebhookEventsTable;
  audit_log: AuditLogTable;
  subscriptions: SubscriptionsTable;
  payments: PaymentsTable;
  invoices: InvoicesTable;
}
