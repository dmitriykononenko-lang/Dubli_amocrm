import type { RawAmoEntity, AmoCustomField } from '../entities/field-extractor';

export interface FieldTransferPlan {
  /** Тело PATCH для главной записи. Пустой объект — переносить нечего. */
  patch: Record<string, unknown>;
  /** Сводка перенесённого (для журнала). */
  transferred: { name: boolean; field_ids: number[] };
}

/**
 * План переноса полей дубля → главную запись по принципу gap-fill:
 * заполняем только то, что у главной пусто (имя; поля с field_id, которых у неё нет).
 * Конфликты (оба заполнены) не трогаем — разрешение конфликтов появится с UI слияния.
 */
export function planFieldTransfer(
  master: RawAmoEntity,
  duplicate: RawAmoEntity,
): FieldTransferPlan {
  const patch: Record<string, unknown> = {};
  const transferred = { name: false, field_ids: [] as number[] };

  // Имя — только если у главной пусто, а у дубля есть.
  if (isBlank(master.name) && !isBlank(duplicate.name)) {
    patch.name = duplicate.name;
    transferred.name = true;
  }

  const masterFieldIds = new Set<number>();
  for (const cf of master.custom_fields_values ?? []) {
    if (typeof cf.field_id === 'number') masterFieldIds.add(cf.field_id);
  }

  const add: AmoCustomField[] = [];
  for (const cf of duplicate.custom_fields_values ?? []) {
    if (typeof cf.field_id !== 'number') continue; // без field_id перенести нельзя
    if (masterFieldIds.has(cf.field_id)) continue; // у главной поле уже есть — gap-fill не трогает
    const values = (cf.values ?? []).filter((v) => v && v.value != null && String(v.value) !== '');
    if (values.length === 0) continue;
    // Сохраняем field_code/field_name: по ним extractRawFields классифицирует ключ
    // при локальной переиндексации после переноса.
    add.push({ ...cf, values });
    transferred.field_ids.push(cf.field_id);
  }
  if (add.length > 0) patch.custom_fields_values = add;

  return { patch, transferred };
}

export function isEmptyPatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length === 0;
}

/** Главная запись с применённым планом — для локальной переиндексации после merge. */
export function applyPlan(master: RawAmoEntity, plan: FieldTransferPlan): RawAmoEntity {
  const added = (plan.patch.custom_fields_values as AmoCustomField[] | undefined) ?? [];
  return {
    ...master,
    name: (plan.patch.name as string | undefined) ?? master.name,
    custom_fields_values: [...(master.custom_fields_values ?? []), ...added],
  };
}

/** Тело для восстановления сущности из снимка (откат): имя + пользовательские поля. */
export function restorePayload(snapshot: RawAmoEntity): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (!isBlank(snapshot.name)) payload.name = snapshot.name;
  if ((snapshot.custom_fields_values ?? []).length > 0) {
    payload.custom_fields_values = snapshot.custom_fields_values;
  }
  return payload;
}

function isBlank(v: unknown): boolean {
  return v == null || String(v).trim() === '';
}
