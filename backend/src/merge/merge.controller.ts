import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { parseAmoId, parseEntityTypeParam } from '../common/request-params';
import { MergeService, type MergeResult, type RollbackResult } from './merge.service';

interface MergeBody {
  entity_type?: unknown;
  master_amo_id?: unknown;
  duplicate_amo_id?: unknown;
  author_user_id?: unknown;
}

/**
 * Объединение дублей из модалки виджета.
 * `POST /api/merge` (главная + дубль) и `POST /api/merge/:id/rollback` (откат).
 */
@Controller('api/merge')
@UseGuards(ApiSecurityGuard)
export class MergeController {
  constructor(private readonly service: MergeService) {}

  @Post()
  @HttpCode(200)
  merge(@AccountId() accountId: string, @Body() body: MergeBody): Promise<MergeResult> {
    const entityType = parseEntityTypeParam(body?.entity_type);
    if (!entityType) {
      throw new BadRequestException('entity_type должен быть contact|company|lead');
    }
    const masterAmoId = parseAmoId(body?.master_amo_id);
    const duplicateAmoId = parseAmoId(body?.duplicate_amo_id);
    if (!masterAmoId || !duplicateAmoId) {
      throw new BadRequestException('master_amo_id и duplicate_amo_id обязательны (целые числа)');
    }
    const authorUserId = parseAmoId(body?.author_user_id);
    return this.service.merge(accountId, {
      entityType,
      masterAmoId,
      duplicateAmoId,
      authorUserId,
    });
  }

  @Post(':id/rollback')
  @HttpCode(200)
  rollback(@AccountId() accountId: string, @Param('id') id: string): Promise<RollbackResult> {
    const mergeId = parseAmoId(id);
    if (!mergeId) throw new BadRequestException('Некорректный id объединения');
    return this.service.rollback(accountId, mergeId);
  }
}
