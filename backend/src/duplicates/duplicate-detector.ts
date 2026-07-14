import type { KeyType } from '../common/db/database.types';
import type { EnabledRule } from '../rules/rules.repository';

export interface RuleMatchResult {
  isDuplicate: boolean;
  matchedRules: string[];
}

/**
 * Решение «дубль ли кандидат» по набору совпавших key_type и правилам поиска (§4.4):
 * - правило `AND` — совпали ВСЕ его key_type;
 * - правило `OR`  — совпал ХОТЯ БЫ ОДИН его key_type;
 * - между правилами — OR (достаточно одного сработавшего);
 * - нет включённых правил → фолбэк: дубль при любом общем ключе.
 *
 * Сравнение идёт по key_type; привязка к конкретным field_id правил — следующий слой.
 */
export function evaluateRules(matched: Set<KeyType>, rules: EnabledRule[]): RuleMatchResult {
  if (rules.length === 0) {
    return { isDuplicate: matched.size > 0, matchedRules: [] };
  }
  const matchedRules = rules.filter((r) => ruleSatisfied(matched, r)).map((r) => r.name);
  return { isDuplicate: matchedRules.length > 0, matchedRules };
}

/**
 * Сработало ли одно правило на наборе совпавших key_type: AND — все ключи правила,
 * OR — хотя бы один. Правило без полей не срабатывает.
 */
export function ruleSatisfied(matched: Set<KeyType>, rule: EnabledRule): boolean {
  const required = ruleKeyTypes(rule);
  if (required.length === 0) return false;
  return rule.operator === 'AND'
    ? required.every((kt) => matched.has(kt))
    : required.some((kt) => matched.has(kt));
}

/** Уникальные key_type, упомянутые в полях правила. */
function ruleKeyTypes(rule: EnabledRule): KeyType[] {
  const seen = new Set<KeyType>();
  for (const f of rule.fields ?? []) {
    if (f?.key_type) seen.add(f.key_type);
  }
  return [...seen];
}
