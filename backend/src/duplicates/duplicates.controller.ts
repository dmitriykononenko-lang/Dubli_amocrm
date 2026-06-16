import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiSecurityGuard } from '../common/auth/api-security.guard';
import { AccountId } from '../common/auth/account-id.decorator';
import { toSingular } from '../common/entity-type.util';
import type { EntityType } from '../common/db/database.types';
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
    const entityType = parseEntityType(entityTypeRaw);
    if (!entityType) {
      throw new BadRequestException('entity_type должен быть contact|company|lead');
    }
    const amoId = parseAmoId(amoIdRaw);
    if (!amoId) throw new BadRequestException('amo_id обязателен (целое положительное число)');
    return this.service.findForEntity(accountId, entityType, amoId);
  }
}

/** Принимаем и единственное (enum БД), и множественное число (как в API amoCRM/фронте). */
function parseEntityType(raw?: string): EntityType | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'contact' || v === 'company' || v === 'lead') return v;
  return toSingular(v);
}

function parseAmoId(raw?: string): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return /^\d+$/.test(v) ? v : null;
}
