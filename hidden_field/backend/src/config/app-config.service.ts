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
  get apiSecurityKey(): string | undefined {
    return this.get('API_SECURITY_KEY');
  }
  get rateLimitRps(): number {
    return this.get('AMOCRM_RATE_LIMIT_RPS');
  }
}
