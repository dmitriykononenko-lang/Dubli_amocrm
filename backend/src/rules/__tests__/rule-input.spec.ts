import { parseRuleInput, parseRulePatch } from '../rule-input';

describe('parseRuleInput', () => {
  it('нормализует валидное тело с дефолтами', () => {
    const r = parseRuleInput({
      entity_type: 'contact',
      name: '  По телефону  ',
      fields: [{ key_type: 'phone' }],
    });
    expect(r).toEqual({
      entityType: 'contact',
      name: 'По телефону',
      fields: [{ key_type: 'phone' }],
      operator: 'AND',
      autoMerge: false,
      enabled: true,
    });
  });

  it('принимает множественное число и field_id, коэрсит operator/флаги', () => {
    const r = parseRuleInput({
      entity_type: 'contacts',
      name: 'R',
      fields: [{ key_type: 'custom', field_id: '123' }],
      operator: 'or',
      auto_merge: 'true',
      enabled: false,
    });
    expect(r.entityType).toBe('contact');
    expect(r.fields).toEqual([{ key_type: 'custom', field_id: 123 }]);
    expect(r.operator).toBe('OR');
    expect(r.autoMerge).toBe(true);
    expect(r.enabled).toBe(false);
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['нет entity_type', { name: 'x', fields: [{ key_type: 'phone' }] }],
    ['плохой entity_type', { entity_type: 'deal', name: 'x', fields: [{ key_type: 'phone' }] }],
    ['пустое name', { entity_type: 'contact', name: '  ', fields: [{ key_type: 'phone' }] }],
    ['пустые fields', { entity_type: 'contact', name: 'x', fields: [] }],
    ['плохой key_type', { entity_type: 'contact', name: 'x', fields: [{ key_type: 'xxx' }] }],
    [
      'нецелый field_id',
      { entity_type: 'contact', name: 'x', fields: [{ key_type: 'phone', field_id: 'abc' }] },
    ],
  ];
  it.each(invalid)('бросает на невалидном теле (%s)', (_label, body) => {
    expect(() => parseRuleInput(body)).toThrow();
  });
});

describe('parseRulePatch', () => {
  it('берёт только переданные поля', () => {
    expect(parseRulePatch({ enabled: false })).toEqual({ enabled: false });
    expect(parseRulePatch({ name: 'New', operator: 'or' })).toEqual({
      name: 'New',
      operator: 'OR',
    });
    expect(parseRulePatch({})).toEqual({});
  });

  it('валидирует переданные значения', () => {
    expect(() => parseRulePatch({ operator: 'XOR' })).toThrow();
    expect(() => parseRulePatch({ name: '' })).toThrow();
    expect(() => parseRulePatch({ enabled: 'maybe' })).toThrow();
  });
});
