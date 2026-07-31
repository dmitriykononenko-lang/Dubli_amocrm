import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { AppConfigService, type OAuthClient } from '../config/app-config.service';
import { Throttler } from './throttler';
import { RetryableError, withRetry } from './retry';

export interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

export type TokenGrant =
  | { grant_type: 'authorization_code'; code: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

/**
 * Низкоуровневый HTTP-клиент amoCRM (undici). Не зависит от БД, чтобы избежать цикла
 * с TokensService. Троттлинг ~rps на аккаунт + ретраи на 429/5xx.
 */
@Injectable()
export class AmocrmHttpClient {
  private readonly throttlers = new Map<string, Throttler>();

  constructor(private readonly config: AppConfigService) {}

  baseUrl(subdomain: string): string {
    return `https://${subdomain}.amocrm.ru`;
  }

  private throttlerFor(key: string): Throttler {
    let t = this.throttlers.get(key);
    if (!t) {
      t = new Throttler(this.config.rateLimitRps);
      this.throttlers.set(key, t);
    }
    return t;
  }

  /**
   * OAuth: обмен authorization_code или обновление по refresh_token.
   * client — реквизиты приложения (приватного/публичного). Без него — приватное из конфига.
   */
  async exchangeToken(
    subdomain: string,
    grant: TokenGrant,
    client?: OAuthClient,
  ): Promise<TokenResponse> {
    const c = client ?? this.config.privateOauthClient;
    const body = {
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      ...grant,
    };
    const res = await request(`${this.baseUrl(subdomain)}/oauth2/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`amoCRM token endpoint ${res.statusCode}: ${text}`);
    }
    return (await res.body.json()) as TokenResponse;
  }

  /** Авторизованный GET к API v4 (троттлинг + ретраи). accountKey — для шардирования троттлера. */
  async apiGet<T>(
    subdomain: string,
    accountKey: string,
    path: string,
    accessToken: string,
  ): Promise<T> {
    return this.apiRequest<T>('GET', subdomain, accountKey, path, accessToken);
  }

  /** Авторизованный PATCH (обновление сущности). */
  async apiPatch<T>(
    subdomain: string,
    accountKey: string,
    path: string,
    accessToken: string,
    body: unknown,
  ): Promise<T> {
    return this.apiRequest<T>('PATCH', subdomain, accountKey, path, accessToken, body);
  }

  /** Авторизованный POST (создание/связывание). */
  async apiPost<T>(
    subdomain: string,
    accountKey: string,
    path: string,
    accessToken: string,
    body: unknown,
  ): Promise<T> {
    return this.apiRequest<T>('POST', subdomain, accountKey, path, accessToken, body);
  }

  /** Авторизованный DELETE (удаление сущности). */
  async apiDelete<T>(
    subdomain: string,
    accountKey: string,
    path: string,
    accessToken: string,
  ): Promise<T> {
    return this.apiRequest<T>('DELETE', subdomain, accountKey, path, accessToken);
  }

  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    subdomain: string,
    accountKey: string,
    path: string,
    accessToken: string,
    body?: unknown,
  ): Promise<T> {
    await this.throttlerFor(accountKey).acquire();
    return withRetry(async () => {
      const res = await request(`${this.baseUrl(subdomain)}${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        const ra = Number(res.headers['retry-after']);
        throw new RetryableError(
          `amoCRM API ${res.statusCode}`,
          Number.isFinite(ra) ? ra : undefined,
        );
      }
      if (res.statusCode >= 400) {
        throw new Error(`amoCRM API ${res.statusCode}: ${await res.body.text()}`);
      }
      // DELETE и некоторые ответы могут быть с пустым телом.
      const text = await res.body.text();
      return (text ? JSON.parse(text) : undefined) as T;
    });
  }
}
