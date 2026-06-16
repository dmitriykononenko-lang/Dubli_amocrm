import { toSingular } from './entity-type.util';
import type { EntityType } from './db/database.types';

/** entity_type запроса: принимаем единственное (enum БД) и множественное (API amoCRM/фронт) число. */
export function parseEntityTypeParam(raw?: unknown): EntityType | null {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'contact' || v === 'company' || v === 'lead') return v;
  return toSingular(v);
}

/** amo_id/merge_id: непустая строка из одних цифр (BIGINT приходит строкой). */
export function parseAmoId(raw?: unknown): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  return /^\d+$/.test(v) ? v : null;
}
