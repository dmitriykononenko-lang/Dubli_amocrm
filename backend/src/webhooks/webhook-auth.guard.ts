import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AccountsService } from '../accounts/accounts.service';
import { AppConfigService } from '../config/app-config.service';

/**
 * Аутентификация входящего вебхука по security_key:
 * приоритет — per-account из accounts.settings, фолбэк — env WEBHOOK_SECURITY_KEY.
 * (Сверить с докой amoCRM актуальный механизм подписи вебхуков.)
 */
@Injectable()
export class WebhookAuthGuard implements CanActivate {
  constructor(
    private readonly accounts: AccountsService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = this.readProvided(req);
    if (!provided) throw new UnauthorizedException('Не передан security_key');

    const accountId = this.readAccountId(req);
    const expected =
      (accountId ? await this.accounts.getSecurityKey(accountId) : null) ??
      this.config.webhookSecurityKey ??
      null;
    if (!expected) throw new UnauthorizedException('security_key не настроен');

    if (!this.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Неверный security_key');
    }
    return true;
  }

  private readProvided(req: Request): string | null {
    const h = req.headers['x-security-key'];
    if (typeof h === 'string' && h) return h;
    const q = req.query?.security_key;
    if (typeof q === 'string' && q) return q;
    return null;
  }

  private readAccountId(req: Request): string | null {
    const q = req.query?.account_id;
    if (typeof q === 'string' && q) return q;
    const bodyAccountId = req.body?.account?.id;
    return bodyAccountId != null ? String(bodyAccountId) : null;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
