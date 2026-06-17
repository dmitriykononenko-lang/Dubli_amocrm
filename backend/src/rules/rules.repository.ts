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

/** Полное правило для CRUD (без account_id — скоуп задаётся снаружи). */
export interface RuleRow {
  id: string;
  entity_type: EntityType;
  name: string;
  fields: RuleField[];
  operator: RuleOperator;
  auto_merge: boolean;
  enabled: boolean;
  created_at: Date;
}

export interface RuleInput {
  entityType: EntityType;
  name: string;
  fields: RuleField[];
  operator: RuleOperator;
  autoMerge: boolean;
  enabled: boolean;
}

export interface RulePatch {
  name?: string;
  fields?: RuleField[];
  operator?: RuleOperator;
  autoMerge?: boolean;
  enabled?: boolean;
}

const RULE_COLUMNS = [
  'id',
  'entity_type',
  'name',
  'fields',
  'operator',
  'auto_merge',
  'enabled',
  'created_at',
] as const;

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

  /** Все правила аккаунта (опц. фильтр по сущности), для экрана настроек. */
  async list(accountId: string, entityType?: EntityType): Promise<RuleRow[]> {
    requireAccountId(accountId);
    let q = this.db.selectFrom('rules').select(RULE_COLUMNS).where('account_id', '=', accountId);
    if (entityType) q = q.where('entity_type', '=', entityType);
    return this.normalizeRows(await q.orderBy('created_at', 'asc').execute());
  }

  async findById(accountId: string, id: string): Promise<RuleRow | undefined> {
    requireAccountId(accountId);
    const row = await this.db
      .selectFrom('rules')
      .select(RULE_COLUMNS)
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.normalizeRow(row) : undefined;
  }

  async create(accountId: string, input: RuleInput): Promise<RuleRow> {
    requireAccountId(accountId);
    const row = await this.db
      .insertInto('rules')
      .values({
        account_id: accountId,
        entity_type: input.entityType,
        name: input.name,
        fields: JSON.stringify(input.fields),
        operator: input.operator,
        auto_merge: input.autoMerge,
        enabled: input.enabled,
      })
      .returning(RULE_COLUMNS)
      .executeTakeFirstOrThrow();
    return this.normalizeRow(row);
  }

  /** Частичное обновление. undefined — если правила нет (для 404). */
  async update(accountId: string, id: string, patch: RulePatch): Promise<RuleRow | undefined> {
    requireAccountId(accountId);
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.fields !== undefined) set.fields = JSON.stringify(patch.fields);
    if (patch.operator !== undefined) set.operator = patch.operator;
    if (patch.autoMerge !== undefined) set.auto_merge = patch.autoMerge;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (Object.keys(set).length === 0) return this.findById(accountId, id);

    const row = await this.db
      .updateTable('rules')
      .set(set)
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .returning(RULE_COLUMNS)
      .executeTakeFirst();
    return row ? this.normalizeRow(row) : undefined;
  }

  /** true — если правило было и удалено. */
  async remove(accountId: string, id: string): Promise<boolean> {
    requireAccountId(accountId);
    const res = await this.db
      .deleteFrom('rules')
      .where('account_id', '=', accountId)
      .where('id', '=', id)
      .executeTakeFirst();
    return (res.numDeletedRows ?? 0n) > 0n;
  }

  private normalizeRows(rows: Array<Omit<RuleRow, 'fields'> & { fields: RuleField[] | null }>) {
    return rows.map((r) => this.normalizeRow(r));
  }
  private normalizeRow(row: Omit<RuleRow, 'fields'> & { fields: RuleField[] | null }): RuleRow {
    return { ...row, fields: row.fields ?? [] };
  }
}
