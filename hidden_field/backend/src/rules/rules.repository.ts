import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type { DB, EntityType, RuleField, RuleOperator } from '../common/db/database.types';

export interface EnabledRule {
  id: string;
  name: string;
  fields: RuleField[];
  operator: RuleOperator;
}

@Injectable()
export class RulesRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /** Включённые правила поиска дублей для сущности (между правилами — OR). §4.4 */
  async findEnabled(accountId: string, entityType: EntityType): Promise<EnabledRule[]> {
    requireAccountId(accountId);
    const rows = await this.db
      .selectFrom('rules')
      .select(['id', 'name', 'fields', 'operator'])
      .where('account_id', '=', accountId)
      .where('entity_type', '=', entityType)
      .where('enabled', '=', true)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      fields: r.fields ?? [],
      operator: r.operator,
    }));
  }
}
