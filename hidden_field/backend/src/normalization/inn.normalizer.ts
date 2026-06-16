/**
 * Нормализация ИНН (§6.1): только цифры + проверка контрольной суммы.
 * Поддержка 10 знаков (юрлицо) и 12 знаков (физлицо/ИП). Невалидный → null.
 */
export function normalizeInn(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const d = String(raw).replace(/\D+/g, '');
  if (d.length === 10 && isValidInn10(d)) return d;
  if (d.length === 12 && isValidInn12(d)) return d;
  return null;
}

function checksum(digits: number[], weights: number[]): number {
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  return (sum % 11) % 10;
}

function isValidInn10(s: string): boolean {
  const n = s.split('').map(Number);
  return checksum(n, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[9];
}

function isValidInn12(s: string): boolean {
  const n = s.split('').map(Number);
  const c1 = checksum(n, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const c2 = checksum(n, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return c1 === n[10] && c2 === n[11];
}
