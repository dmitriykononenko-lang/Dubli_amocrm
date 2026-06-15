import { normalizeInn } from '../inn.normalizer';

describe('normalizeInn', () => {
  it('валидный 10-значный ИНН (юрлицо)', () => {
    // 7707083893 — корректная контрольная сумма.
    expect(normalizeInn('7707083893')).toBe('7707083893');
    expect(normalizeInn(' 7707083893 ')).toBe('7707083893');
  });

  it('валидный 12-значный ИНН (физлицо/ИП)', () => {
    // 500100732259 — корректные контрольные цифры.
    expect(normalizeInn('500100732259')).toBe('500100732259');
  });

  it('неверная контрольная сумма → null', () => {
    expect(normalizeInn('7707083890')).toBeNull();
    expect(normalizeInn('500100732250')).toBeNull();
  });

  it('неверная длина → null', () => {
    expect(normalizeInn('123')).toBeNull();
    expect(normalizeInn('77070838931')).toBeNull();
  });

  it('мусор/пусто → null', () => {
    expect(normalizeInn('abcdefghij')).toBeNull();
    expect(normalizeInn('')).toBeNull();
    expect(normalizeInn(null)).toBeNull();
  });
});
