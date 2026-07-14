import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { requireAccountId } from '../common/db/account-scope';
import type { EntityType, MergeMode } from '../common/db/database.types';
import { AmocrmService } from '../amocrm/amocrm.service';
import { EntitiesService } from '../entities/entities.service';
import { AuditService } from '../common/audit/audit.service';
import type { RawAmoEntity } from '../entities/field-extractor';
import { MergeRepository } from './merge.repository';
import { applyPlan, isEmptyPatch, planFieldTransfer, restorePayload } from './field-merge';

export interface MergeInput {
  entityType: EntityType;
  masterAmoId: string;
  duplicateAmoId: string;
  authorUserId?: string | null;
  mode?: MergeMode; // 'manual' (по умолчанию) | 'auto' (по правилу auto_merge)
}

export interface MergeResult {
  mergeId: string;
  master_amo_id: string;
  duplicate_amo_id: string;
  transferred: { name: boolean; field_ids: number[]; links: number };
}

export interface RollbackResult {
  mergeId: string;
  master_amo_id: string;
  restored_duplicate_amo_id: string;
}

/**
 * Объединение дублей. Атомарного merge-API в amoCRM нет, поэтому переносим данные
 * дубля в главную запись (gap-fill полей + перенос связей) и удаляем дубль, сохраняя
 * снимки для отката. Откат — best-effort: amoCRM не возвращает прежний id, поэтому
 * дубль воссоздаётся с новым id. (Точные эндпоинты links/delete сверить с докой amoCRM.)
 */
@Injectable()
export class MergeService {
  constructor(
    private readonly amocrm: AmocrmService,
    private readonly merges: MergeRepository,
    private readonly entities: EntitiesService,
    private readonly audit: AuditService,
  ) {}

  async merge(accountId: string, input: MergeInput): Promise<MergeResult> {
    requireAccountId(accountId);
    if (input.masterAmoId === input.duplicateAmoId) {
      throw new BadRequestException('master_amo_id и duplicate_amo_id совпадают');
    }
    const { entityType, masterAmoId, duplicateAmoId } = input;

    // 0. Снимки обеих сущностей до изменений.
    const [master, duplicate] = await Promise.all([
      this.amocrm.getById<RawAmoEntity>(accountId, entityType, masterAmoId),
      this.amocrm.getById<RawAmoEntity>(accountId, entityType, duplicateAmoId),
    ]);

    // 1. Перенос полей дубля → главную (gap-fill).
    const plan = planFieldTransfer(master, duplicate);
    if (!isEmptyPatch(plan.patch)) {
      await this.amocrm.update(accountId, entityType, masterAmoId, plan.patch);
    }

    // 2. Перенос связей дубля на главную запись.
    const links = await this.amocrm.getLinks(accountId, entityType, duplicateAmoId);
    if (links.length > 0) {
      await this.amocrm.link(accountId, entityType, masterAmoId, links);
    }

    // 3. Удаление дубля.
    await this.amocrm.remove(accountId, entityType, duplicateAmoId);

    // 4. Журнал + снимки для отката.
    const transferred = {
      name: plan.transferred.name,
      field_ids: plan.transferred.field_ids,
      links: links.length,
    };
    const { mergeId } = await this.merges.record({
      accountId,
      entityType,
      masterAmoId,
      duplicateAmoId,
      mode: input.mode ?? 'manual',
      authorUserId: input.authorUserId ?? null,
      transferred,
      snapshots: [
        { amoId: masterAmoId, payload: master as Record<string, unknown> },
        { amoId: duplicateAmoId, payload: duplicate as Record<string, unknown> },
      ],
    });

    // 5. Локальный индекс: переиндексируем главную (новые поля), убираем дубль.
    await this.entities.indexEntity(accountId, entityType, masterAmoId, applyPlan(master, plan));
    await this.entities.remove(accountId, entityType, duplicateAmoId);

    await this.audit.log({
      accountId,
      actor: input.authorUserId != null ? String(input.authorUserId) : 'system',
      action: 'merge',
      meta: { mergeId, master: masterAmoId, duplicate: duplicateAmoId, transferred },
    });

    return { mergeId, master_amo_id: masterAmoId, duplicate_amo_id: duplicateAmoId, transferred };
  }

  async rollback(accountId: string, mergeId: string): Promise<RollbackResult> {
    requireAccountId(accountId);
    const journal = await this.merges.findJournal(accountId, mergeId);
    if (!journal) throw new NotFoundException('Объединение не найдено');
    if (journal.rolled_back_at) throw new BadRequestException('Объединение уже откатано');

    const snapshots = await this.merges.findSnapshots(accountId, mergeId);
    const masterSnap = snapshots.find((s) => s.amo_id === journal.master_amo_id);
    const dupSnap = snapshots.find((s) => s.amo_id === journal.duplicate_amo_id);
    if (!masterSnap || !dupSnap) throw new BadRequestException('Нет снимков для отката');

    const entityType = journal.entity_type;
    const masterRaw = masterSnap.payload as RawAmoEntity;
    const dupRaw = dupSnap.payload as RawAmoEntity;

    // 1. Возврат полей главной к снимку.
    await this.amocrm.update(
      accountId,
      entityType,
      journal.master_amo_id,
      restorePayload(masterRaw),
    );

    // 2. Воссоздание дубля из снимка (новый amo_id — прежний вернуть нельзя).
    const newDuplicateId = await this.amocrm.create(accountId, entityType, restorePayload(dupRaw));

    // 3. Отметка отката.
    await this.merges.markRolledBack(accountId, mergeId);

    // 4. Локальный индекс: главная по снимку, воссозданный дубль под новым id.
    await this.entities.indexEntity(accountId, entityType, journal.master_amo_id, masterRaw);
    await this.entities.indexEntity(accountId, entityType, newDuplicateId, dupRaw);

    await this.audit.log({
      accountId,
      action: 'rollback',
      meta: { mergeId, restoredDuplicate: newDuplicateId },
    });

    return {
      mergeId,
      master_amo_id: journal.master_amo_id,
      restored_duplicate_amo_id: newDuplicateId,
    };
  }
}
