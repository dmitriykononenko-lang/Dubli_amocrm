import { Injectable } from '@nestjs/common';
import { requireAccountId } from '../common/db/account-scope';
import type { EntityType, KeyType } from '../common/db/database.types';
import { RulesRepository } from '../rules/rules.repository';
import { DuplicatesRepository } from './duplicates.repository';
import { evaluateRules, ruleSatisfied } from './duplicate-detector';

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

export interface DuplicateGroupEntity {
  amo_id: string;
  name: string | null;
}

export interface DuplicateGroup {
  key_type: KeyType;
  key_norm: string;
  entities: DuplicateGroupEntity[];
}

export interface DuplicateGroupsResult {
  entity_type: EntityType;
  count: number;
  groups: DuplicateGroup[];
}

@Injectable()
export class DuplicatesService {
  constructor(
    private readonly repo: DuplicatesRepository,
    private readonly rules: RulesRepository,
  ) {}

  /**
   * Группы дублей по сущности во всей базе аккаунта (для экрана настроек): записи,
   * делящие один нормализованный ключ (телефон/email/ИНН/…), сгруппированные по ключу.
   * Имена — общие (name) — исключаются, чтобы не шуметь совпадениями по частым именам.
   */
  async findGroups(accountId: string, entityType: EntityType): Promise<DuplicateGroupsResult> {
    requireAccountId(accountId);
    const rows = await this.repo.findDuplicateGroupRows(accountId, entityType);

    const byKey = new Map<
      string,
      { key_type: KeyType; key_norm: string; entities: Map<string, DuplicateGroupEntity> }
    >();
    for (const r of rows) {
      const gk = `${r.key_type}:${r.kh}`;
      let g = byKey.get(gk);
      if (!g) {
        g = { key_type: r.key_type, key_norm: r.key_norm, entities: new Map() };
        byKey.set(gk, g);
      }
      g.entities.set(r.amo_id, { amo_id: r.amo_id, name: extractName(r.key_fields) });
    }

    const groups: DuplicateGroup[] = [...byKey.values()]
      .map((g) => ({
        key_type: g.key_type,
        key_norm: g.key_norm,
        entities: [...g.entities.values()],
      }))
      .filter((g) => g.entities.length >= 2)
      .sort(
        (a, b) =>
          b.entities.length - a.entities.length ||
          a.key_norm.localeCompare(b.key_norm, undefined, { numeric: true }),
      );

    return { entity_type: entityType, count: groups.length, groups };
  }

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

  /**
   * Однозначная пара для авто-слияния: если найден ровно один кандидат, удовлетворяющий
   * правилу с auto_merge, вернуть пару (главная — более старая запись = меньший amo_id).
   * Иначе null (нет дублей / нет auto_merge-правил / неоднозначно — оставляем ручному режиму).
   */
  async findAutoMergeTarget(
    accountId: string,
    entityType: EntityType,
    amoId: string,
  ): Promise<{ masterAmoId: string; duplicateAmoId: string } | null> {
    requireAccountId(accountId);
    const targetId = await this.repo.findEntityId(accountId, entityType, amoId);
    if (targetId === undefined) return null;

    const [matches, rules] = await Promise.all([
      this.repo.findCandidateMatches({ accountId, entityType, targetEntityId: targetId }),
      this.rules.findEnabled(accountId, entityType),
    ]);
    const autoRules = rules.filter((r) => r.auto_merge);
    if (autoRules.length === 0) return null;

    // key_type-множества по кандидату (amo_id → Set<KeyType>)
    const byCandidate = new Map<string, Set<KeyType>>();
    for (const row of matches) {
      let set = byCandidate.get(row.amo_id);
      if (!set) {
        set = new Set<KeyType>();
        byCandidate.set(row.amo_id, set);
      }
      set.add(row.key_type);
    }

    const hits: string[] = [];
    for (const [candidateAmoId, types] of byCandidate) {
      if (autoRules.some((r) => ruleSatisfied(types, r))) hits.push(candidateAmoId);
    }
    if (hits.length !== 1) return null; // 0 или неоднозначно (>1) — авто-слияние пропускаем

    // главная — более старая запись (меньший amo_id), вторая — дубль
    const other = hits[0];
    const [masterAmoId, duplicateAmoId] =
      amoId.localeCompare(other, undefined, { numeric: true }) <= 0
        ? [amoId, other]
        : [other, amoId];
    return { masterAmoId, duplicateAmoId };
  }
}

/** Имя сущности из снимка key_fields ({ name, fields }). */
function extractName(keyFields: Record<string, unknown>): string | null {
  const name = keyFields?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}
