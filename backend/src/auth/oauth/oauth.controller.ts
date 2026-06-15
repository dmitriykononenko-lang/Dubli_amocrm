import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OauthService, type InstallQuery } from './oauth.service';

@Controller('oauth')
export class OauthController {
  constructor(private readonly oauth: OauthService) {}

  // amoCRM редиректит сюда после выдачи доступа (redirect_uri интеграции).
  @Get('callback')
  async callback(@Query() query: InstallQuery, @Res() res: Response): Promise<void> {
    await this.oauth.handleInstall(query);
    res.status(200).send('Интеграция Dubli установлена. Это окно можно закрыть.');
  }
}
