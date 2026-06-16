import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AmocrmHttpClient } from '../../amocrm/amocrm-http.client';
import { AccountsService } from '../../accounts/accounts.service';
import { TokensService } from '../../tokens/tokens.service';
import { AuditService } from '../../common/audit/audit.service';

export interface InstallQuery {
  code?: string;
  referer?: string;
  client_id?: string;
  [k: string]: string | undefined;
}

@Injectable()
export class OauthService {
  private readonly logger = new Logger('OAuth');

  constructor(
    private readonly http: AmocrmHttpClient,
    private readonly accounts: AccountsService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
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
   * Сверить с докой amoCRM: точный состав query callback и способ получения account_id.
   */
  async handleInstall(q: InstallQuery): Promise<{ accountId: string; subdomain: string }> {
    if (!q.code) throw new BadRequestException('Не передан code авторизации');
    const subdomain = this.extractSubdomain(q.referer);

    const tok = await this.http.exchangeToken(subdomain, {
      grant_type: 'authorization_code',
      code: q.code,
    });
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
    await this.audit.log({ accountId, action: 'install', meta: { subdomain } });
    this.logger.log(`Интеграция установлена: аккаунт ${accountId} (${subdomain})`);
    return { accountId, subdomain };
  }
}
