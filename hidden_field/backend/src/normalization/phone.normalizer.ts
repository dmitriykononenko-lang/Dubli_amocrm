/**
 * Нормализация телефона (§6.1): только цифры → E.164 РФ → ключ = последние 10 цифр.
 * Учитываем ведущую 8 (РФ) → 7. Возвращает null для мусора/слишком коротких.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let digits = String(raw).replace(/\D+/g, '');
  if (!digits) return null;
  // РФ: 11 цифр, начинается на 8 → заменяем на 7 (8 999… == 7 999…).
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }
  if (digits.length < 10) return null;
  // Ключ сравнения — национальный номер без кода страны (последние 10 цифр).
  return digits.slice(-10);
}
