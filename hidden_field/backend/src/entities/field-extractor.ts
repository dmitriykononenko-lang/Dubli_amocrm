import type { EntityType } from '../common/db/database.types';
import type { RawField } from '../normalization/normalization.service';

export interface AmoFieldValue {
  value?: unknown;
}
export interface AmoCustomField {
  field_code?: string;
  field_name?: string;
  field_id?: number;
  values?: AmoFieldValue[];
}
export interface RawAmoEntity {
  id?: number | string;
  name?: string;
  updated_at?: number | string;
  custom_fields_values?: AmoCustomField[] | null;
}

/**
 * Достаёт сырые ключевые поля (имя/телефон/email/ИНН) из объекта сущности amoCRM.
 * Привязка к конкретным field_id из правил (rules) — на следующем этапе.
 */
export function extractRawFields(entity: RawAmoEntity, _entityType: EntityType): RawField[] {
  const fields: RawField[] = [];
  if (entity.name) fields.push({ key_type: 'name', value: String(entity.name) });

  for (const cf of entity.custom_fields_values ?? []) {
    const code = (cf.field_code ?? '').toUpperCase();
    const fname = (cf.field_name ?? '').toLowerCase();
    const values = (cf.values ?? []).map((v) => String(v?.value ?? '')).filter((v) => v.length > 0);
    for (const value of values) {
      if (code === 'PHONE') fields.push({ key_type: 'phone', value });
      else if (code === 'EMAIL') fields.push({ key_type: 'email', value });
      else if (code === 'INN' || fname.includes('инн')) fields.push({ key_type: 'inn', value });
    }
  }
  return fields;
}
