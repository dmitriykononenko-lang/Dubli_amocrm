import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/** Пара реквизитов OAuth-приложения amoCRM (приватная или публичная интеграция). */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Типизированный доступ к конфигурации. В остальном коде — никаких прямых process.env. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }
  get port(): number {
    return this.get('PORT');
  }
  get logLevel(): Env['LOG_LEVEL'] {
    return this.get('LOG_LEVEL');
  }
  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }
  get databaseSsl(): boolean {
    return this.get('DATABASE_SSL');
  }
  /** Мастер-ключ AES-256-GCM (32 байта). */
  get tokenEncKey(): Buffer {
    return Buffer.from(this.get('TOKEN_ENC_KEY'), 'base64');
  }
  get kmsProvider(): Env['KMS_PROVIDER'] {
    return this.get('KMS_PROVIDER');
  }
  get amocrmClientId(): string {
    return this.get('AMOCRM_CLIENT_ID');
  }
  get amocrmClientSecret(): string {
    return this.get('AMOCRM_CLIENT_SECRET');
  }
  get amocrmRedirectUri(): string {
    return this.get('AMOCRM_REDIRECT_URI');
  }

  /** Приватная интеграция (основная, задана всегда). */
  get privateOauthClient(): OAuthClient {
    return {
      clientId: this.amocrmClientId,
      clientSecret: this.amocrmClientSecret,
      redirectUri: this.amocrmRedirectUri,
    };
  }
  /** Публичная (маркетплейс) интеграция — null, если PUBLIC_AMOCRM_* не заданы. */
  get publicOauthClient(): OAuthClient | null {
    const clientId = this.get('PUBLIC_AMOCRM_CLIENT_ID');
    const clientSecret = this.get('PUBLIC_AMOCRM_CLIENT_SECRET');
    if (!clientId || !clientSecret) return null;
    return {
      clientId,
      clientSecret,
      redirectUri: this.get('PUBLIC_AMOCRM_REDIRECT_URI') ?? this.amocrmRedirectUri,
    };
  }
  /** OAuth-клиент по его client_id (для refresh тем же приложением). Фолбэк — приватный. */
  oauthClientById(clientId?: string): OAuthClient {
    const pub = this.publicOauthClient;
    if (clientId && pub && pub.clientId === clientId) return pub;
    return this.privateOauthClient;
  }
  /**
   * Строгий поиск по client_id: вернёт клиента ТОЛЬКО если id совпал с настроенным
   * приватным или публичным приложением, иначе null. Для валидации callback: неизвестный
   * client_id → явная ошибка (в отличие от oauthClientById, который откатывается к приватному).
   */
  knownOauthClient(clientId: string): OAuthClient | null {
    if (clientId === this.amocrmClientId) return this.privateOauthClient;
    const pub = this.publicOauthClient;
    if (pub && clientId === pub.clientId) return pub;
    return null;
  }

  get webhookSecurityKey(): string | undefined {
    return this.get('WEBHOOK_SECURITY_KEY');
  }
  get rateLimitRps(): number {
    return this.get('AMOCRM_RATE_LIMIT_RPS');
  }
  get scanPollMs(): number {
    return this.get('SCAN_POLL_MS');
  }

  // --- Биллинг ---
  get billingPricePerUser(): number {
    return this.get('BILLING_PRICE_PER_USER');
  }
  get billingMinUsers(): number {
    return this.get('BILLING_MIN_USERS');
  }
  get vendorAmocrmAccountId(): string | undefined {
    return this.get('VENDOR_AMOCRM_ACCOUNT_ID');
  }
  get vendorAmocrmSubdomain(): string | undefined {
    return this.get('VENDOR_AMOCRM_SUBDOMAIN');
  }
  get vendorAmocrmToken(): string | undefined {
    return this.get('VENDOR_AMOCRM_TOKEN');
  }
  get vendorAmocrmPipelineId(): number | undefined {
    return this.get('VENDOR_AMOCRM_PIPELINE_ID');
  }
  get vendorAmocrmStatusInstalled(): number | undefined {
    return this.get('VENDOR_AMOCRM_STATUS_INSTALLED');
  }
  get vendorAmocrmStatusRequested(): number | undefined {
    return this.get('VENDOR_AMOCRM_STATUS_REQUESTED');
  }
  get vendorAmocrmStatusPaid(): number | undefined {
    return this.get('VENDOR_AMOCRM_STATUS_PAID');
  }
  get vendorAmocrmAccountFieldId(): number | undefined {
    return this.get('VENDOR_AMOCRM_ACCOUNT_FIELD_ID');
  }
  get vendorAmocrmAccountLinkFieldId(): number | undefined {
    return this.get('VENDOR_AMOCRM_ACCOUNT_LINK_FIELD_ID');
  }
  get yookassaShopId(): string | undefined {
    return this.get('YOOKASSA_SHOP_ID');
  }
  get yookassaSecretKey(): string | undefined {
    return this.get('YOOKASSA_SECRET_KEY');
  }
  get billingReturnUrl(): string | undefined {
    return this.get('BILLING_RETURN_URL');
  }
  get yookassaFiscal(): boolean {
    return this.get('YOOKASSA_FISCAL');
  }
  get yookassaVatCode(): number {
    return this.get('YOOKASSA_VAT_CODE');
  }
  /** Токен вендор-админа для /vendor/billing/*. undefined → vendor-роуты закрыты. */
  get vendorAdminToken(): string | undefined {
    return this.get('VENDOR_ADMIN_TOKEN');
  }
  /** Пробный период (дней от установки). */
  get billingTrialDays(): number {
    return this.get('BILLING_TRIAL_DAYS');
  }
  /** Льготный период после paid_till для трека «счёт» (дней). */
  get billingInvoiceGraceDays(): number {
    return this.get('BILLING_INVOICE_GRACE_DAYS');
  }
  /** За сколько дней до paid_till списывать карту (рекуррент). */
  get billingRenewLeadDays(): number {
    return this.get('BILLING_RENEW_LEAD_DAYS');
  }
  /** Дни ретраев списания карты (dunning), напр. [1,3,5]. */
  get billingDunningRetries(): number[] {
    return String(this.get('BILLING_DUNNING_RETRIES'))
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  /** За сколько дней до paid_till слать напоминание. */
  get billingNotifyLeadDays(): number {
    return this.get('BILLING_NOTIFY_LEAD_DAYS');
  }
  /** Вебхук уведомлений вендору (Telegram/incoming), либо undefined. */
  get billingNotifyTelegramWebhook(): string | undefined {
    return this.get('BILLING_NOTIFY_TELEGRAM_WEBHOOK');
  }
  /** Логин оператора вендор-панели (роль billing_admin). */
  get billingAdminUser(): string | undefined {
    return this.get('BILLING_ADMIN_USER');
  }
  get billingAdminPassword(): string | undefined {
    return this.get('BILLING_ADMIN_PASSWORD');
  }
  /** Секрет подписи сессионной cookie панели; фолбэк — VENDOR_ADMIN_TOKEN. */
  get billingAdminSessionSecret(): string | undefined {
    return this.get('BILLING_ADMIN_SESSION_SECRET') ?? this.vendorAdminToken;
  }
  /** Авто-сверка поступлений по счетам (фича-флаг, фаза 5). */
  get billingBankReconcile(): boolean {
    return this.get('BILLING_BANK_RECONCILE');
  }
}
