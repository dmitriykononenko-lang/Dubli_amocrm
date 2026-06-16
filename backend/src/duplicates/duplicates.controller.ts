import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { parseAmoId, parseEntityTypeParam } from '../common/request-params';
import { DuplicatesService, type DuplicatesResult } from './duplicates.service';

/**
 * Поиск дублей для плашки виджета в карточке.
 * `GET /api/duplicates?account_id=&entity_type=&amo_id=` + security_key (заголовок/query).
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
  ): Promise<DuplicatesResult> {
    const entityType = parseEntityTypeParam(entityTypeRaw);
    if (!entityType) {
      throw new BadRequestException('entity_type должен быть contact|company|lead');
    }
    const amoId = parseAmoId(amoIdRaw);
    if (!amoId) throw new BadRequestException('amo_id обязателен (целое положительное число)');
    return this.service.findForEntity(accountId, entityType, amoId);
  }
}
