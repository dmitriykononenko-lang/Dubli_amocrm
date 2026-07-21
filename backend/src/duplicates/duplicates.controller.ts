import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { parseAmoId, parseEntityTypeParam } from '../common/request-params';
import {
  DuplicatesService,
  type DuplicatesResult,
  type DuplicateGroupsResult,
} from './duplicates.service';

/**
 * Дубли для виджета. `GET /api/duplicates?account_id=&entity_type=[&amo_id=]`:
 * с `amo_id` — дубли конкретной записи (карточка); без него — список групп по сущности
 * во всей базе (экран настроек). security_key — заголовок/query.
 */
@Controller('api/duplicates')
@UseGuards(ApiSecurityGuard)
export class DuplicatesController {
  constructor(private readonly service: DuplicatesService) {}

  @Get()
  find(
    @AccountId() accountId: string,
    @Query('entity_type') entityTypeRaw?: string,
    @Query('amo_id') amoIdRaw?: string,
  ): Promise<DuplicatesResult | DuplicateGroupsResult> {
    const entityType = parseEntityTypeParam(entityTypeRaw);
    if (!entityType) {
      throw new BadRequestException('entity_type должен быть contact|company|lead');
    }
    // Без amo_id — список групп дублей по сущности.
    if (amoIdRaw == null || String(amoIdRaw).trim() === '') {
      return this.service.findGroups(accountId, entityType);
    }
    const amoId = parseAmoId(amoIdRaw);
    if (!amoId) throw new BadRequestException('amo_id должен быть целым положительным числом');
    return this.service.findForEntity(accountId, entityType, amoId);
  }
}
