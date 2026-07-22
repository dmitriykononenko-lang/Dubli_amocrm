import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

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
  get yookassaShopId(): string | undefined {
    return this.get('YOOKASSA_SHOP_ID');
  }
  get yookassaSecretKey(): string | undefined {
    return this.get('YOOKASSA_SECRET_KEY');
  }
}
