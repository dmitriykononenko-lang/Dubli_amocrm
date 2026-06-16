import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB, EntityType, MergeMode } from '../common/db/database.types';

export interface SnapshotInput {
  amoId: string;
  payload: Record<string, unknown>;
}

export interface RecordMergeInput {
  accountId: string;
  entityType: EntityType;
  masterAmoId: string;
  duplicateAmoId: string;
  mode: MergeMode;
  authorUserId: string | null;
  transferred: Record<string, unknown>;
  snapshots: SnapshotInput[];
}

@Injectable()
export class MergeRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /** Журнал объединения + снимки обеих сущностей (для отката) в одной транзакции. */
  async record(input: RecordMergeInput): Promise<{ mergeId: string }> {
    requireAccountId(input.accountId);
    return this.db.transaction().execute(async (trx) => {
      const journal = await trx
        .insertInto('merge_journal')
        .values({
          account_id: input.accountId,
          entity_type: input.entityType,
          master_amo_id: input.masterAmoId,
          duplicate_amo_id: input.duplicateAmoId,
          mode: input.mode,
          author_user_id: input.authorUserId,
          transferred: JSON.stringify(input.transferred),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (input.snapshots.length > 0) {
        await trx
          .insertInto('snapshots')
          .values(
            input.snapshots.map((s) => ({
              merge_id: journal.id,
              account_id: input.accountId,
              entity_type: input.entityType,
              amo_id: s.amoId,
              payload: JSON.stringify(s.payload),
            })),
          )
          .execute();
      }
      return { mergeId: journal.id };
    });
  }

  findJournal(accountId: string, mergeId: string) {
    requireAccountId(accountId);
    return this.db
      .selectFrom('merge_journal')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('id', '=', mergeId)
      .executeTakeFirst();
  }

  findSnapshots(accountId: string, mergeId: string) {
    requireAccountId(accountId);
    return this.db
      .selectFrom('snapshots')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('merge_id', '=', mergeId)
      .execute();
  }

  async markRolledBack(accountId: string, mergeId: string): Promise<void> {
    requireAccountId(accountId);
    await this.db
      .updateTable('merge_journal')
      .set({ rolled_back_at: new Date() })
      .where('account_id', '=', accountId)
      .where('id', '=', mergeId)
      .execute();
  }
}
