/**
 * Расчёт стоимости подписки. Чистая функция — авторитетный источник суммы
 * (фронт показывает предварительно, бэкенд считает при оплате/счёте).
 */
export interface PricingConfig {
  pricePerUser: number;
  minUsers: number;
}

export interface Quote {
  users: number;
  months: number;
  billedMonths: number;
  pricePerUser: number;
  sum: number;
}

/** Срок подписки (мес) → сколько месяцев оплачивается (разница = бонусные месяцы). */
export const PLANS: Record<number, number> = {
  6: 6,
  12: 10,
};

export function computeQuote(usersRaw: number, monthsRaw: number, cfg: PricingConfig): Quote {
  const users = Math.max(cfg.minUsers, Math.floor(Number(usersRaw) || 0));
  const months = Math.max(1, Math.floor(Number(monthsRaw) || 0));
  const billedMonths = PLANS[months] ?? months;
  const sum = cfg.pricePerUser * users * billedMonths;
  return { users, months, billedMonths, pricePerUser: cfg.pricePerUser, sum };
}
