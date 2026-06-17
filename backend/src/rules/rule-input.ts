import { BadRequestException } from '@nestjs/common';
import type { KeyType, RuleField, RuleOperator } from '../common/db/database.types';
import { parseEntityTypeParam } from '../common/request-params';
import type { RuleInput, RulePatch } from './rules.repository';

const KEY_TYPES: KeyType[] = ['phone', 'email', 'inn', 'name', 'custom'];
const NAME_MAX = 200;

/** Валидация тела создания правила. Бросает BadRequestException при ошибке. */
export function parseRuleInput(body: Record<string, unknown>): RuleInput {
  const entityType = parseEntityTypeParam(body.entity_type);
  if (!entityType) throw new BadRequestException('entity_type должен быть contact|company|lead');
  return {
    entityType,
    name: parseName(body.name),
    fields: parseFields(body.fields),
    operator: parseOperator(body.operator) ?? 'AND',
    autoMerge: parseBool(body.auto_merge) ?? false,
    enabled: parseBool(body.enabled) ?? true,
  };
}

/** Валидация частичного обновления (PATCH): только переданные поля. */
export function parseRulePatch(body: Record<string, unknown>): RulePatch {
  const patch: RulePatch = {};
  if (body.name !== undefined) patch.name = parseName(body.name);
  if (body.fields !== undefined) patch.fields = parseFields(body.fields);
  if (body.operator !== undefined) {
    const op = parseOperator(body.operator);
    if (!op) throw new BadRequestException('operator должен быть AND или OR');
    patch.operator = op;
  }
  if (body.auto_merge !== undefined) patch.autoMerge = requireBool(body.auto_merge, 'auto_merge');
  if (body.enabled !== undefined) patch.enabled = requireBool(body.enabled, 'enabled');
  return patch;
}

function parseName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new BadRequestException('name обязателен');
  if (name.length > NAME_MAX) throw new BadRequestException(`name длиннее ${NAME_MAX} символов`);
  return name;
}

function parseFields(v: unknown): RuleField[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new BadRequestException('fields — непустой массив { key_type, field_id? }');
  }
  return v.map((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const keyType = f.key_type;
    if (typeof keyType !== 'string' || !KEY_TYPES.includes(keyType as KeyType)) {
      throw new BadRequestException(`key_type должен быть одним из: ${KEY_TYPES.join(', ')}`);
    }
    const field: RuleField = { key_type: keyType as KeyType };
    if (f.field_id !== undefined && f.field_id !== null) {
      const id = Number(f.field_id);
      if (!Number.isInteger(id)) throw new BadRequestException('field_id должен быть целым');
      field.field_id = id;
    }
    return field;
  });
}

function parseOperator(v: unknown): RuleOperator | null {
  if (v === undefined || v === null) return null;
  const op = String(v).toUpperCase();
  return op === 'AND' || op === 'OR' ? (op as RuleOperator) : null;
}

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function requireBool(v: unknown, field: string): boolean {
  const b = parseBool(v);
  if (b === undefined) throw new BadRequestException(`${field} должен быть boolean`);
  return b;
}
