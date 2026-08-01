import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { PANEL_HTML } from './panel-page';
import { SESSION_COOKIE, safeEqual, signSession } from './vendor-session';

interface LoginBody {
  user?: string;
  password?: string;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

/**
 * Вендор-панель управления подписками. Сама страница — публичный SPA-шелл; данные она
 * берёт с /vendor/billing/* по сессионной cookie (роль billing_admin). Логин — по
 * BILLING_ADMIN_USER/PASSWORD, cookie подписана billingAdminSessionSecret.
 */
@Controller('vendor/panel')
export class VendorPanelController {
  constructor(private readonly config: AppConfigService) {}

  @Get()
  page(@Res() res: Response): void {
    res.type('html').send(PANEL_HTML);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginBody, @Res({ passthrough: true }) res: Response): { ok: true } {
    const user = this.config.billingAdminUser;
    const pass = this.config.billingAdminPassword;
    const secret = this.config.billingAdminSessionSecret;
    if (!user || !pass || !secret) {
      throw new ServiceUnavailableException(
        'Вход в панель не настроен (BILLING_ADMIN_USER/PASSWORD, VENDOR_ADMIN_TOKEN)',
      );
    }
    const ok = safeEqual(body?.user ?? '', user) && safeEqual(body?.password ?? '', pass);
    if (!ok) throw new UnauthorizedException('Неверный логин или пароль');
    const token = signSession(secret, {
      u: user,
      role: 'billing_admin',
      exp: Date.now() + SESSION_TTL_MS,
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true, // прод за nginx/TLS (https://dubli.koagency.ru)
      path: '/vendor',
      maxAge: SESSION_TTL_MS,
    });
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(SESSION_COOKIE, { path: '/vendor' });
    return { ok: true };
  }
}
