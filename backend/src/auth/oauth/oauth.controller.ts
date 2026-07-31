import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OauthService, type InstallQuery } from './oauth.service';

@Controller('oauth')
export class OauthController {
  constructor(private readonly oauth: OauthService) {}

  // Приватная интеграция: amoCRM редиректит сюда после выдачи доступа.
  @Get('callback')
  async callback(@Query() query: InstallQuery, @Res() res: Response): Promise<void> {
    await this.oauth.handleInstall(query, 'private');
    res.status(200).send('Интеграция Dubli установлена. Это окно можно закрыть.');
  }

  // Публичная (маркетплейс amoМаркет) интеграция — отдельный redirect_uri,
  // чтобы детерминированно выбрать OAuth-приложение (amoCRM не шлёт client_id).
  @Get('callback/public')
  async callbackPublic(@Query() query: InstallQuery, @Res() res: Response): Promise<void> {
    await this.oauth.handleInstall(query, 'public');
    res.status(200).send('Интеграция Dubli установлена. Это окно можно закрыть.');
  }
}
