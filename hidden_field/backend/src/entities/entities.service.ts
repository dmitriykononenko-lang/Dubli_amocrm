import { Injectable } from '@nestjs/common';
import { EntitiesRepository } from './entities.repository';
import { NormalizationService } from '../normalization/normalization.service';
import { extractRawFields, type RawAmoEntity } from './field-extractor';
import { isCompany } from '../common/entity-type.util';
import type { EntityType } from '../common/db/database.types';

@Injectable()
export class EntitiesService {
  constructor(
    private readonly repo: EntitiesRepository,
    private readonly normalization: NormalizationService,
  ) {}

  /** Индексация сущности: нормализуем ключевые поля и пересобираем entity_keys. */
  async indexEntity(
    accountId: string,
    entityType: EntityType,
    amoId: string,
    raw: RawAmoEntity,
  ): Promise<{ entityId: string; keyCount: number }> {
    const rawFields = extractRawFields(raw, entityType);
    const keys = this.normalization.buildKeys(rawFields, { isCompany: isCompany(entityType) });
    const { entityId } = await this.repo.upsertWithKeys({
      accountId,
      entityType,
      amoId,
      keyFields: { name: raw.name ?? null, fields: rawFields },
      keys,
    });
    return { entityId, keyCount: keys.length };
  }

  remove(accountId: string, entityType: EntityType, amoId: string): Promise<void> {
    return this.repo.remove(accountId, entityType, amoId);
  }
}
