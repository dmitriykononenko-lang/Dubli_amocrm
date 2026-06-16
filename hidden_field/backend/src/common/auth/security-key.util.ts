import { timingSafeEqual } from 'node:crypto';

/**
 * Тайминг-безопасное сравнение security_key (защита от timing-атак).
 * Разная длина → сразу false (без утечки через время сравнения буферов).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
