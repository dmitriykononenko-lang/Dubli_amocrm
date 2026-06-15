import { normalizeName } from '../name.normalizer';

describe('normalizeName', () => {
  it('lowercase + trim + схлопывание пробелов', () => {
    expect(normalizeName('  Иван   Иванов ')).toBe('иван иванов');
  });

  it('убирает кавычки', () => {
    expect(normalizeName('«Ромашка»')).toBe('ромашка');
    expect(normalizeName('"Ромашка"')).toBe('ромашка');
  });

  it('для компаний убирает ОПФ (короткие формы)', () => {
    expect(normalizeName('ООО "Ромашка"', { stripOpf: true })).toBe('ромашка');
    expect(normalizeName('ПАО Сбербанк', { stripOpf: true })).toBe('сбербанк');
    expect(normalizeName('ИП Петров', { stripOpf: true })).toBe('петров');
  });

  it('для компаний убирает ОПФ (полные формы)', () => {
    expect(
      normalizeName('Общество с ограниченной ответственностью «Ромашка»', { stripOpf: true }),
    ).toBe('ромашка');
    expect(normalizeName('Акционерное общество Ромашка', { stripOpf: true })).toBe('ромашка');
  });

  it('без stripOpf форма не удаляется', () => {
    expect(normalizeName('ООО Ромашка')).toBe('ооо ромашка');
  });

  it('разные записи компании совпадают', () => {
    expect(normalizeName('ООО "Ромашка"', { stripOpf: true })).toBe(
      normalizeName('Ромашка', { stripOpf: true }),
    );
  });

  it('пусто → null', () => {
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });
});
