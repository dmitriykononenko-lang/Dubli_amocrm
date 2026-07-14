import { evaluateRules } from '../duplicate-detector';
import type { EnabledRule } from '../../rules/rules.repository';
import type { KeyType } from '../../common/db/database.types';

function rule(partial: Partial<EnabledRule> & Pick<EnabledRule, 'name' | 'operator'>): EnabledRule {
  return { id: '1', fields: [], auto_merge: false, ...partial };
}
function matched(...types: KeyType[]): Set<KeyType> {
  return new Set(types);
}

describe('evaluateRules', () => {
  describe('без правил — фолбэк «любой общий ключ»', () => {
    it('есть общий ключ → дубль, matchedRules пуст', () => {
      expect(evaluateRules(matched('phone'), [])).toEqual({ isDuplicate: true, matchedRules: [] });
    });
    it('нет общих ключей → не дубль', () => {
      expect(evaluateRules(matched(), [])).toEqual({ isDuplicate: false, matchedRules: [] });
    });
  });

  describe('правило AND', () => {
    const r = rule({
      name: 'Телефон и email',
      operator: 'AND',
      fields: [{ key_type: 'phone' }, { key_type: 'email' }],
    });
    it('совпал только один из требуемых ключей → не дубль', () => {
      expect(evaluateRules(matched('phone'), [r])).toEqual({
        isDuplicate: false,
        matchedRules: [],
      });
    });
    it('совпали все требуемые ключи → дубль', () => {
      expect(evaluateRules(matched('phone', 'email'), [r])).toEqual({
        isDuplicate: true,
        matchedRules: ['Телефон и email'],
      });
    });
  });

  describe('правило OR', () => {
    const r = rule({
      name: 'Телефон или email',
      operator: 'OR',
      fields: [{ key_type: 'phone' }, { key_type: 'email' }],
    });
    it('совпал хотя бы один ключ → дубль', () => {
      expect(evaluateRules(matched('email'), [r])).toEqual({
        isDuplicate: true,
        matchedRules: ['Телефон или email'],
      });
    });
  });

  describe('несколько правил — между ними OR', () => {
    const rules = [
      rule({
        name: 'AND phone+email',
        operator: 'AND',
        fields: [{ key_type: 'phone' }, { key_type: 'email' }],
      }),
      rule({ name: 'OR inn', operator: 'OR', fields: [{ key_type: 'inn' }] }),
    ];
    it('срабатывает второе правило → дубль с его именем', () => {
      expect(evaluateRules(matched('inn'), rules)).toEqual({
        isDuplicate: true,
        matchedRules: ['OR inn'],
      });
    });
    it('совпало по обоим правилам → оба имени', () => {
      expect(evaluateRules(matched('phone', 'email', 'inn'), rules)).toEqual({
        isDuplicate: true,
        matchedRules: ['AND phone+email', 'OR inn'],
      });
    });
    it('ни одно правило не сработало → не дубль (общий name игнорируется правилами)', () => {
      expect(evaluateRules(matched('name'), rules)).toEqual({
        isDuplicate: false,
        matchedRules: [],
      });
    });
  });

  it('правило без полей не срабатывает', () => {
    const r = rule({ name: 'Пустое', operator: 'AND', fields: [] });
    expect(evaluateRules(matched('phone', 'email'), [r])).toEqual({
      isDuplicate: false,
      matchedRules: [],
    });
  });
});
