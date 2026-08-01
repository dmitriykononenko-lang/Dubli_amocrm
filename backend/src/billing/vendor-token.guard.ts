import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { SESSION_COOKIE, parseCookies, safeEqual, verifySession } from './vendor-session';

/**
 * Доступ к /vendor/billing/* — двумя способами:
 *  1) заголовок X-Vendor-Token = VENDOR_ADMIN_TOKEN (curl/автоматизация);
 *  2) сессионная cookie вендор-панели (роль billing_admin) — для браузера, чтобы не
 *     класть VENDOR_ADMIN_TOKEN в JS.
 * Если ни один способ не настроен/не прошёл — 401. Сравнение токена постоянного времени.
 */
@Injectable()
export class VendorTokenGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (this.tokenOk(req) || this.sessionOk(req)) return true;
    throw new UnauthorizedException('Нужен X-Vendor-Token или вход в панель');
  }

  private tokenOk(req: Request): boolean {
    const expected = this.config.vendorAdminToken;
    if (!expected) return false;
    const provided = req.header('x-vendor-token') ?? '';
    return safeEqual(provided, expected);
  }

  private sessionOk(req: Request): boolean {
    const secret = this.config.billingAdminSessionSecret;
    if (!secret) return false;
    const sess = verifySession(secret, parseCookies(req.header('cookie'))[SESSION_COOKIE]);
    return Boolean(sess && sess.role === 'billing_admin');
  }
}
