import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB } from '../common/db/database.types';

@Injectable()
export class WebhookEventsRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * Регистрирует событие. Возвращает false, если оно уже было
   * (идемпотентность по PK account_id + event_id).
   */
  async markReceived(accountId: string, eventId: string, type: string): Promise<boolean> {
    requireAccountId(accountId);
    const res = await this.db
      .insertInto('webhook_events')
      .values({ account_id: accountId, event_id: eventId, type })
      .onConflict((oc) => oc.columns(['account_id', 'event_id']).doNothing())
      .executeTakeFirst();
    return (res?.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async markProcessed(accountId: string, eventId: string): Promise<void> {
    requireAccountId(accountId);
    await this.db
      .updateTable('webhook_events')
      .set({ processed_at: new Date() })
      .where('account_id', '=', accountId)
      .where('event_id', '=', eventId)
      .execute();
  }
}
