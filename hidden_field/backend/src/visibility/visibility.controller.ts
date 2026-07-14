import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { VisibilityService, type ConfigResult, type MetaResult } from './visibility.service';

/**
 * API виджета Hidden Field. Аутентификация — ApiSecurityGuard:
 * account_id в query, security_key в заголовке X-Security-Key (или query security_key).
 *   GET  /api/meta?account_id=             — поля/пользователи/воронки + матрица (экран настроек)
 *   GET  /api/config?account_id=&user_id=  — режимы полей пользователя (применение в карточке)
 *   POST /api/matrix?account_id=           — сохранение матрицы (тело: { matrix })
 *   POST /api/funnels?account_id=          — сохранение настроек воронок для режима V (тело: { funnels })
 */
@Controller('api')
@UseGuards(ApiSecurityGuard)
export class VisibilityController {
  constructor(private readonly service: VisibilityService) {}

  @Get('meta')
  meta(@AccountId() accountId: string): Promise<MetaResult> {
    return this.service.getMeta(accountId);
  }

  @Get('config')
  config(@AccountId() accountId: string, @Query('user_id') userId?: string): Promise<ConfigResult> {
    return this.service.getConfigForUser(accountId, (userId ?? '').trim());
  }

  @Post('matrix')
  save(
    @AccountId() accountId: string,
    @Body() body: { matrix?: unknown },
  ): Promise<{ saved: number }> {
    return this.service.saveMatrix(accountId, body?.matrix);
  }

  @Post('funnels')
  saveFunnels(
    @AccountId() accountId: string,
    @Body() body: { funnels?: unknown },
  ): Promise<{ saved: number }> {
    return this.service.saveFunnels(accountId, body?.funnels);
  }
}
