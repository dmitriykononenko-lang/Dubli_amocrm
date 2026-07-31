import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AmocrmHttpClient } from '../../amocrm/amocrm-http.client';
import { AccountsService } from '../../accounts/accounts.service';
import { TokensService } from '../../tokens/tokens.service';
import { AuditService } from '../../common/audit/audit.service';
import { BillingService } from '../../billing/billing.service';
import { AppConfigService, type OAuthClient } from '../../config/app-config.service';

export interface InstallQuery {
  code?: string;
  referer?: string;
  client_id?: string;
  [k: string]: string | undefined;
}

/** Какой интеграцией устанавливают виджет: приватной или публичной (маркетплейс). */
export type OAuthVariant = 'private' | 'public';

@Injectable()
export class OauthService {
  private readonly logger = new Logger('OAuth');

  constructor(
    private readonly http: AmocrmHttpClient,
    private readonly accounts: AccountsService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly config: AppConfigService,
  ) {}

  // referer вида "example.amocrm.ru" или полный URL → subdomain "example".
  private extractSubdomain(referer?: string): string {
    if (!referer) throw new BadRequestException('Не передан referer (домен аккаунта)');
    let host = referer.trim();
    if (host.includes('://')) {
      try {
        host = new URL(host).host;
      } catch {
        /* оставляем как есть */
      }
    }
    const sub = host.split('.')[0];
    if (!sub) throw new BadRequestException('Не удалось определить subdomain из referer');
    return sub;
  }

  /**
   * Обработка установки интеграции (OAuth authorization_code).
   * variant выбирает OAuth-приложение по эндпоинту редиректа: приватное
   * (/oauth/callback) или публичное маркетплейс (/oauth/callback/public).
   * amoCRM не передаёт client_id в callback, поэтому клиента определяет путь,
   * а не тело запроса — это детерминированно и не тратит одноразовый code.
   */
  async handleInstall(
    q: InstallQuery,
    variant: OAuthVariant = 'private',
  ): Promise<{ accountId: string; subdomain: string }> {
    if (!q.code) throw new BadRequestException('Не передан code авторизации');
    const subdomain = this.extractSubdomain(q.referer);

    const client = this.resolveInstallClient(q.client_id, variant);

    const tok = await this.http.exchangeToken(
      subdomain,
      { grant_type: 'authorization_code', code: q.code },
      client,
    );
    const account = await this.http.apiGet<{ id: number }>(
      subdomain,
      'install',
      '/api/v4/account',
      tok.access_token,
    );
    const accountId = String(account.id);

    await this.accounts.upsert({ accountId, subdomain, status: 'active' });
    await this.tokens.save(accountId, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresIn: tok.expires_in,
    });
    // Запоминаем OAuth-клиента (для refresh тем же приложением); прочие настройки сохраняем.
    const settings = await this.accounts.getSettings(accountId);
    await this.accounts.updateSettings(accountId, { ...settings, oauth_client_id: client.clientId });
    await this.audit.log({ accountId, action: 'install', meta: { subdomain, oauth: variant } });
    // Ведём клиента в нашей amoCRM: заводим сделку на этапе «Установил» (best-effort).
    await this.billing.onClientInstalled(accountId);
    this.logger.log(`Интеграция установлена (${variant}): аккаунт ${accountId} (${subdomain})`);
    return { accountId, subdomain };
  }

  /**
   * Выбор OAuth-приложения для установки. Приоритет — client_id из query: amoCRM МОЖЕТ
   * прислать его в callback, тогда выбор детерминирован даже на общем redirect (реестр
   * приватного/публичного). Неизвестный client_id → явная ошибка. Если client_id не пришёл —
   * выбираем по эндпоинту редиректа (variant: /oauth/callback vs /oauth/callback/public).
   */
  private resolveInstallClient(queryClientId: string | undefined, variant: OAuthVariant): OAuthClient {
    if (queryClientId) {
      const known = this.config.knownOauthClient(queryClientId);
      if (!known) {
        throw new BadRequestException(`Неизвестный client_id при установке: ${queryClientId}`);
      }
      return known;
    }
    const byVariant = variant === 'public' ? this.config.publicOauthClient : this.config.privateOauthClient;
    if (!byVariant) {
      throw new BadRequestException(
        'Публичная интеграция не настроена (PUBLIC_AMOCRM_CLIENT_ID/PUBLIC_AMOCRM_CLIENT_SECRET)',
      );
    }
    return byVariant;
  }
}
