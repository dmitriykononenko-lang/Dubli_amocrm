/** Настройки дедупликации аккаунта (хранятся в accounts.settings.dedup). */
export interface DedupSettings {
  /** Для каких сущностей искать дубли. */
  entities: { contact: boolean; company: boolean; lead: boolean };
  /** Предупреждать/блокировать создание новых дублей (применение — следующий слой). */
  prevent_create: boolean;
}

export const DEFAULT_DEDUP: DedupSettings = {
  entities: { contact: true, company: true, lead: true },
  prevent_create: false,
};

/**
 * Приводит произвольный объект к DedupSettings: недостающее берём из дефолтов,
 * значения коэрсим в boolean. Используется и при чтении, и при сохранении (PUT = замена).
 */
export function normalizeDedup(raw: unknown): DedupSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const entities = (obj.entities ?? {}) as Record<string, unknown>;
  return {
    entities: {
      contact: bool(entities.contact, DEFAULT_DEDUP.entities.contact),
      company: bool(entities.company, DEFAULT_DEDUP.entities.company),
      lead: bool(entities.lead, DEFAULT_DEDUP.entities.lead),
    },
    prevent_create: bool(obj.prevent_create, DEFAULT_DEDUP.prevent_create),
  };
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}
