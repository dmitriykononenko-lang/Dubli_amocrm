import { applyPlan, isEmptyPatch, planFieldTransfer, restorePayload } from '../field-merge';
import type { RawAmoEntity } from '../../entities/field-extractor';

function field(fieldId: number, value: string) {
  return { field_id: fieldId, values: [{ value }] };
}

describe('planFieldTransfer (gap-fill)', () => {
  it('переносит имя, если у главной пусто, а у дубля есть', () => {
    const plan = planFieldTransfer({ name: '' }, { name: 'Иван' });
    expect(plan.patch.name).toBe('Иван');
    expect(plan.transferred.name).toBe(true);
  });

  it('не трогает имя, если у главной оно уже есть', () => {
    const plan = planFieldTransfer({ name: 'Пётр' }, { name: 'Иван' });
    expect(plan.patch.name).toBeUndefined();
    expect(plan.transferred.name).toBe(false);
  });

  it('добавляет поле дубля, которого нет у главной', () => {
    const master: RawAmoEntity = { name: 'A', custom_fields_values: [field(1, 'phone')] };
    const duplicate: RawAmoEntity = { name: 'B', custom_fields_values: [field(2, 'a@b.ru')] };
    const plan = planFieldTransfer(master, duplicate);
    expect(plan.transferred.field_ids).toEqual([2]);
    expect(plan.patch.custom_fields_values).toEqual([field(2, 'a@b.ru')]);
  });

  it('не трогает поле, которое у главной уже заполнено (по field_id)', () => {
    const master: RawAmoEntity = { custom_fields_values: [field(1, 'master@x.ru')] };
    const duplicate: RawAmoEntity = { custom_fields_values: [field(1, 'dup@x.ru')] };
    const plan = planFieldTransfer(master, duplicate);
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.transferred.field_ids).toEqual([]);
  });

  it('пропускает поля дубля с пустыми значениями и без field_id', () => {
    const duplicate: RawAmoEntity = {
      custom_fields_values: [
        { field_id: 5, values: [{ value: '' }] },
        { field_code: 'PHONE', values: [{ value: '123' }] }, // нет field_id
      ],
    };
    const plan = planFieldTransfer({}, duplicate);
    expect(isEmptyPatch(plan.patch)).toBe(true);
  });

  it('пустой патч, когда переносить нечего', () => {
    expect(isEmptyPatch(planFieldTransfer({ name: 'A' }, { name: 'B' }).patch)).toBe(true);
  });
});

describe('applyPlan', () => {
  it('применяет имя и добавленные поля к главной (для переиндексации)', () => {
    const master: RawAmoEntity = { id: 1, name: '', custom_fields_values: [field(1, 'phone')] };
    const duplicate: RawAmoEntity = { name: 'Иван', custom_fields_values: [field(2, 'mail')] };
    const merged = applyPlan(master, planFieldTransfer(master, duplicate));
    expect(merged.name).toBe('Иван');
    expect(merged.custom_fields_values).toEqual([field(1, 'phone'), field(2, 'mail')]);
  });
});

describe('restorePayload', () => {
  it('собирает имя и поля из снимка, пропуская пустые', () => {
    expect(restorePayload({ name: 'Иван', custom_fields_values: [field(1, 'x')] })).toEqual({
      name: 'Иван',
      custom_fields_values: [field(1, 'x')],
    });
    expect(restorePayload({ name: '' })).toEqual({});
  });
});
