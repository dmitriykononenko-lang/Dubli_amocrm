import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccountsService } from '../accounts/accounts.service';
import { EntitiesService } from '../entities/entities.service';
import { AuditService } from '../common/audit/audit.service';
import { AutoMergeService } from '../merge/auto-merge.service';
import { WebhookEventsRepository } from './webhook-events.repository';
import { parseWebhook } from './webhook-parser';
import type { WebhookEvent } from './amo-webhook.types';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly entities: EntitiesService,
    private readonly events: WebhookEventsRepository,
    private readonly audit: AuditService,
    private readonly autoMerge: AutoMergeService,
  ) {}

  /** Приём вебхука: дедуп → (индексация | удаление) → пометка обработанным. */
  async process(body: unknown): Promise<{ processed: number; skipped: number }> {
    const { accountId, events } = parseWebhook(body);
    if (!accountId) throw new BadRequestException('В вебхуке нет account.id');
    const account = await this.accounts.findById(accountId);
    if (!account) throw new BadRequestException('Неизвестный аккаунт');

    let processed = 0;
    let skipped = 0;
    for (const ev of events) {
      const eventId = this.synthEventId(accountId, ev);
      const fresh = await this.events.markReceived(accountId, eventId, `${ev.op}_${ev.entityType}`);
      if (!fresh) {
        skipped++;
        continue;
      }
      if (ev.op === 'delete') {
        await this.entities.remove(accountId, ev.entityType, ev.amoId);
      } else {
        await this.entities.indexEntity(accountId, ev.entityType, ev.amoId, ev.raw);
        // Авто-слияние по правилам (best-effort, не роняет приём вебхука).
        await this.autoMerge.tryForEntity(accountId, ev.entityType, ev.amoId);
      }
      await this.events.markProcessed(accountId, eventId);
      processed++;
    }
    await this.audit.log({ accountId, action: 'webhook', meta: { processed, skipped } });
    return { processed, skipped };
  }

  /**
   * Классические вебхуки amoCRM не несут event_id — синтезируем стабильный идентификатор.
   * updated_at (если есть) разделяет повторную доставку и новое изменение.
   * Сверить с докой amoCRM наличие стабильного id/таймстампа события.
   */
  private synthEventId(accountId: string, ev: WebhookEvent): string {
    const ts = ev.raw?.updated_at ?? '';
    return createHash('sha1')
      .update(`${accountId}:${ev.entityType}:${ev.op}:${ev.amoId}:${ts}`)
      .digest('hex');
  }
}
