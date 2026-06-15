import { normalizePhone } from '../phone.normalizer';

describe('normalizePhone', () => {
  it('форматированный +7 → последние 10 цифр', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('9991234567');
  });

  it('ведущая 8 (РФ) эквивалентна 7', () => {
    expect(normalizePhone('8 999 123 45 67')).toBe('9991234567');
    expect(normalizePhone('89991234567')).toBe('9991234567');
  });

  it('11 цифр с 7', () => {
    expect(normalizePhone('79991234567')).toBe('9991234567');
  });

  it('10 цифр без кода страны', () => {
    expect(normalizePhone('9991234567')).toBe('9991234567');
  });

  it('разные записи одного номера совпадают', () => {
    expect(normalizePhone('+7 999 123-45-67')).toBe(normalizePhone('8(999)1234567'));
  });

  it('мусор и слишком короткие → null', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});
