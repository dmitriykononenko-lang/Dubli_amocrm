import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccountsService } from '../../accounts/accounts.service';
import { AppConfigService } from '../../config/app-config.service';
import { timingSafeEqualStr } from './security-key.util';
import { ACCOUNT_ID_PROP } from './account-id.decorator';

/**
 * Аутентификация запросов виджета к API (`/api/*`) по security_key.
 * account_id — из query `?account_id=`; ключ — из заголовка `X-Security-Key` или query `?security_key=`.
 * Ожидаемый ключ: per-account из accounts.settings (приоритет), фолбэк — env WEBHOOK_SECURITY_KEY.
 * После успеха кладёт проверенный account_id в req (см. @AccountId).
 */
@Injectable()
export class ApiSecurityGuard implements CanActivate {
  constructor(
    private readonly accounts: AccountsService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { [ACCOUNT_ID_PROP]?: string }>();

    const accountId = this.readAccountId(req);
    if (!accountId) throw new UnauthorizedException('Не передан account_id');

    const provided = this.readProvided(req);
    if (!provided) throw new UnauthorizedException('Не передан security_key');

    const expected =
      (await this.accounts.getSecurityKey(accountId)) ?? this.config.webhookSecurityKey ?? null;
    if (!expected) throw new UnauthorizedException('security_key не настроен');

    if (!timingSafeEqualStr(provided, expected)) {
      throw new UnauthorizedException('Неверный security_key');
    }

    req[ACCOUNT_ID_PROP] = accountId;
    return true;
  }

  private readAccountId(req: Request): string | null {
    const q = req.query?.account_id;
    return typeof q === 'string' && q ? q : null;
  }

  private readProvided(req: Request): string | null {
    const h = req.headers['x-security-key'];
    if (typeof h === 'string' && h) return h;
    const q = req.query?.security_key;
    if (typeof q === 'string' && q) return q;
    return null;
  }
}
