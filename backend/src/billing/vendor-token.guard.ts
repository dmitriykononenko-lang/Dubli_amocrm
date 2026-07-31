import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';

/**
 * Доступ к /vendor/billing/* только по заголовку X-Vendor-Token, равному VENDOR_ADMIN_TOKEN
 * из .env. Если токен не задан — роуты закрыты (401), а не открыты. Сравнение постоянного времени.
 */
@Injectable()
export class VendorTokenGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.vendorAdminToken;
    if (!expected) {
      throw new UnauthorizedException('Вендор-доступ выключен (VENDOR_ADMIN_TOKEN не задан)');
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.header('x-vendor-token') ?? '';
    if (!VendorTokenGuard.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Неверный или отсутствующий X-Vendor-Token');
    }
    return true;
  }

  /** Сравнение без утечки длины/префикса по времени. */
  private static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
