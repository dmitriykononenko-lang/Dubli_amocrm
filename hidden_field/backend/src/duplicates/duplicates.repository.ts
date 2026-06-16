import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB, EntityType, KeyType } from '../common/db/database.types';

/** Строка совпадения: ключ кандидата, совпавший с ключом цели. */
export interface CandidateKeyRow {
  entity_id: string;
  amo_id: string;
  key_fields: Record<string, unknown>;
  key_type: KeyType;
  key_norm: string;
}

@Injectable()
export class DuplicatesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /** Внутренний id проиндексированной сущности (или undefined, если её нет в индексе). */
  async findEntityId(
    accountId: string,
    entityType: EntityType,
    amoId: string,
  ): Promise<string | undefined> {
    requireAccountId(accountId);
    const row = await this.db
      .selectFrom('entities')
      .select('id')
      .where('account_id', '=', accountId)
      .where('entity_type', '=', entityType)
      .where('amo_id', '=', amoId)
      .executeTakeFirst();
    return row?.id;
  }

  /**
   * Кандидаты в дубли: сущности того же типа, делящие с целью нормализованный ключ.
   * Self-join entity_keys по индексу обнаружения (account_id, entity_type, key_type, key_hash) —
   * перебора API amoCRM нет (§6.2). Возвращает по строке на каждый совпавший ключ кандидата.
   */
  async findCandidateMatches(input: {
    accountId: string;
    entityType: EntityType;
    targetEntityId: string;
  }): Promise<CandidateKeyRow[]> {
    requireAccountId(input.accountId);
    return this.db
      .selectFrom('entity_keys as cand')
      .innerJoin('entity_keys as tgt', (join) =>
        join
          .onRef('tgt.account_id', '=', 'cand.account_id')
          .onRef('tgt.entity_type', '=', 'cand.entity_type')
          .onRef('tgt.key_type', '=', 'cand.key_type')
          .onRef('tgt.key_hash', '=', 'cand.key_hash'),
      )
      .innerJoin('entities as e', 'e.id', 'cand.entity_id')
      .select([
        'cand.entity_id as entity_id',
        'e.amo_id as amo_id',
        'e.key_fields as key_fields',
        'cand.key_type as key_type',
        'cand.key_norm as key_norm',
      ])
      .where('tgt.entity_id', '=', input.targetEntityId)
      .where('cand.account_id', '=', input.accountId)
      .where('cand.entity_type', '=', input.entityType)
      .where('cand.entity_id', '!=', input.targetEntityId)
      .execute();
  }
}
