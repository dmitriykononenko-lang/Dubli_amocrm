import { Injectable } from '@nestjs/common';
import { requireAccountId } from '../common/db/account-scope';
import type { EntityType, KeyType } from '../common/db/database.types';
import { RulesRepository } from '../rules/rules.repository';
import { DuplicatesRepository } from './duplicates.repository';
import { evaluateRules } from './duplicate-detector';

export interface MatchedKey {
  key_type: KeyType;
  key_norm: string;
}

export interface DuplicateItem {
  amo_id: string;
  name: string | null;
  matched_keys: MatchedKey[];
  matched_rules: string[];
}

export interface DuplicatesResult {
  entity: { entity_type: EntityType; amo_id: string; indexed: boolean };
  count: number;
  duplicates: DuplicateItem[];
}

@Injectable()
export class DuplicatesService {
  constructor(
    private readonly repo: DuplicatesRepository,
    private readonly rules: RulesRepository,
  ) {}

  /** Поиск дублей проиндексированной сущности по общим ключам и правилам аккаунта. */
  async findForEntity(
    accountId: string,
    entityType: EntityType,
    amoId: string,
  ): Promise<DuplicatesResult> {
    requireAccountId(accountId);
    const targetId = await this.repo.findEntityId(accountId, entityType, amoId);
    if (targetId === undefined) {
      // Сущности ещё нет в индексе (не пришёл вебхук / не было сканирования).
      return {
        entity: { entity_type: entityType, amo_id: amoId, indexed: false },
        count: 0,
        duplicates: [],
      };
    }

    const [matches, rules] = await Promise.all([
      this.repo.findCandidateMatches({ accountId, entityType, targetEntityId: targetId }),
      this.rules.findEnabled(accountId, entityType),
    ]);

    // Группируем совпавшие ключи по кандидату (дедуп по key_type+key_norm).
    const byCandidate = new Map<
      string,
      { amoId: string; name: string | null; keys: Map<string, MatchedKey> }
    >();
    for (const row of matches) {
      let cand = byCandidate.get(row.entity_id);
      if (!cand) {
        cand = { amoId: row.amo_id, name: extractName(row.key_fields), keys: new Map() };
        byCandidate.set(row.entity_id, cand);
      }
      cand.keys.set(`${row.key_type}:${row.key_norm}`, {
        key_type: row.key_type,
        key_norm: row.key_norm,
      });
    }

    const duplicates: DuplicateItem[] = [];
    for (const cand of byCandidate.values()) {
      const matchedKeys = [...cand.keys.values()];
      const matchedTypes = new Set<KeyType>(matchedKeys.map((k) => k.key_type));
      const { isDuplicate, matchedRules } = evaluateRules(matchedTypes, rules);
      if (!isDuplicate) continue;
      duplicates.push({
        amo_id: cand.amoId,
        name: cand.name,
        matched_keys: matchedKeys,
        matched_rules: matchedRules,
      });
    }

    // Стабильный порядок: сильнее совпадение (больше ключей) — выше, затем по amo_id.
    duplicates.sort(
      (a, b) =>
        b.matched_keys.length - a.matched_keys.length ||
        a.amo_id.localeCompare(b.amo_id, undefined, { numeric: true }),
    );

    return {
      entity: { entity_type: entityType, amo_id: amoId, indexed: true },
      count: duplicates.length,
      duplicates,
    };
  }
}

/** Имя сущности из снимка key_fields ({ name, fields }). */
function extractName(keyFields: Record<string, unknown>): string | null {
  const name = keyFields?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}
