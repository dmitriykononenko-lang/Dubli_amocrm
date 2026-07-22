import { computeQuote } from '../billing.pricing';

const cfg = { pricePerUser: 399, minUsers: 5 };

describe('computeQuote', () => {
  it('5 пользователей × 6 мес = 11 970 ₽', () => {
    const q = computeQuote(5, 6, cfg);
    expect(q.billedMonths).toBe(6);
    expect(q.sum).toBe(11970);
  });

  it('срок 12 мес оплачивается как 10 (бонус 2 мес)', () => {
    const q = computeQuote(5, 12, cfg);
    expect(q.billedMonths).toBe(10);
    expect(q.sum).toBe(19950);
  });

  it('меньше минимума пользователей → берётся минимум', () => {
    expect(computeQuote(2, 6, cfg).users).toBe(5);
  });

  it('нестандартный срок — без бонуса', () => {
    const q = computeQuote(10, 3, cfg);
    expect(q.billedMonths).toBe(3);
    expect(q.sum).toBe(399 * 10 * 3);
  });

  it('мусорный ввод → минимум пользователей и 1 месяц', () => {
    const q = computeQuote(NaN as unknown as number, 0, cfg);
    expect(q.users).toBe(5);
    expect(q.months).toBe(1);
  });
});
