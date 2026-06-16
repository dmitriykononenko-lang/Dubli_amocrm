/**
 * Нормализация имени/названия (§6.1): trim + lowercase, схлопывание пробелов, убрать кавычки.
 * Для компаний (stripOpf) — удалить организационно-правовую форму (ООО/АО/ПАО/ИП/…).
 */

// Длинные формы — раньше коротких, чтобы «акционерное общество» удалялось до «ао».
const OPF = [
  'общество с ограниченной ответственностью',
  'публичное акционерное общество',
  'непубличное акционерное общество',
  'закрытое акционерное общество',
  'открытое акционерное общество',
  'акционерное общество',
  'индивидуальный предприниматель',
  'ооо',
  'пао',
  'нао',
  'зао',
  'оао',
  'ао',
  'ип',
  'llc',
  'ltd',
  'gmbh',
  'inc',
];

const QUOTES = /[«»"'“”„`]/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeName(
  raw: string | null | undefined,
  opts: { stripOpf?: boolean } = {},
): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).toLowerCase().replace(QUOTES, ' ');

  if (opts.stripOpf) {
    for (const opf of OPF) {
      // Удаляем ОПФ как отдельный токен (с границами по пробелам/началу/концу).
      const re = new RegExp(`(^|\\s)${escapeRe(opf)}(\\s|$)`, 'g');
      s = s.replace(re, ' ');
    }
  }

  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}
