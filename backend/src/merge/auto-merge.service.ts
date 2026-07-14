import { Injectable, Logger } from '@nestjs/common';
import type { EntityType } from '../common/db/database.types';
import { DuplicatesService } from '../duplicates/duplicates.service';
import { MergeService } from './merge.service';

export interface AutoMergeResult {
  merged: boolean;
  mergeId?: string;
  masterAmoId?: string;
  duplicateAmoId?: string;
}

/**
 * Авто-слияние по правилам: если только что проиндексированная сущность образует
 * однозначный дубль под правилом с auto_merge — объединяет автоматически (режим auto,
 * главная — более старая запись). Best-effort: ошибку логируем, не роняя вызывающий поток.
 */
@Injectable()
export class AutoMergeService {
  private readonly logger = new Logger('AutoMerge');

  constructor(
    private readonly duplicates: DuplicatesService,
    private readonly merge: MergeService,
  ) {}

  async tryForEntity(
    accountId: string,
    entityType: EntityType,
    amoId: string,
  ): Promise<AutoMergeResult> {
    try {
      const target = await this.duplicates.findAutoMergeTarget(accountId, entityType, amoId);
      if (!target) return { merged: false };
      const res = await this.merge.merge(accountId, {
        entityType,
        masterAmoId: target.masterAmoId,
        duplicateAmoId: target.duplicateAmoId,
        mode: 'auto',
        authorUserId: null,
      });
      this.logger.log(
        `Авто-слияние ${entityType} #${target.duplicateAmoId} → #${target.masterAmoId} (merge ${res.mergeId})`,
      );
      return {
        merged: true,
        mergeId: res.mergeId,
        masterAmoId: target.masterAmoId,
        duplicateAmoId: target.duplicateAmoId,
      };
    } catch (e) {
      this.logger.error(
        `Авто-слияние не удалось (${entityType} #${amoId}): ${(e as Error).message}`,
      );
      return { merged: false };
    }
  }
}
