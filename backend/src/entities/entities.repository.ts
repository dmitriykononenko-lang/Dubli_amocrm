import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB, EntityType } from '../common/db/database.types';
import type { NormalizedKey } from '../normalization/normalization.service';

@Injectable()
export class EntitiesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /** Upsert сущности + полная пересборка её ключей в одной транзакции. */
  async upsertWithKeys(input: {
    accountId: string;
    entityType: EntityType;
    amoId: string;
    keyFields: Record<string, unknown>;
    keys: NormalizedKey[];
  }): Promise<{ entityId: string }> {
    requireAccountId(input.accountId);
    return this.db.transaction().execute(async (trx) => {
      const entity = await trx
        .insertInto('entities')
        .values({
          account_id: input.accountId,
          entity_type: input.entityType,
          amo_id: input.amoId,
          key_fields: JSON.stringify(input.keyFields),
        })
        .onConflict((oc) =>
          oc.columns(['account_id', 'entity_type', 'amo_id']).doUpdateSet({
            key_fields: JSON.stringify(input.keyFields),
            updated_at: new Date(),
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx.deleteFrom('entity_keys').where('entity_id', '=', entity.id).execute();
      if (input.keys.length > 0) {
        await trx
          .insertInto('entity_keys')
          .values(
            input.keys.map((k) => ({
              account_id: input.accountId,
              entity_id: entity.id,
              entity_type: input.entityType,
              key_type: k.key_type,
              key_hash: k.key_hash,
              key_norm: k.key_norm,
            })),
          )
          .execute();
      }
      return { entityId: entity.id };
    });
  }

  /** Удаление сущности (entity_keys удаляются каскадом по FK). */
  async remove(accountId: string, entityType: EntityType, amoId: string): Promise<void> {
    requireAccountId(accountId);
    await this.db
      .deleteFrom('entities')
      .where('account_id', '=', accountId)
      .where('entity_type', '=', entityType)
      .where('amo_id', '=', amoId)
      .execute();
  }
}
