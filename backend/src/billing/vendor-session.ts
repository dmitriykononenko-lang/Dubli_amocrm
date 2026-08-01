import { createHmac, timingSafeEqual } from 'node:crypto';

/** Имя сессионной cookie вендор-панели. */
export const SESSION_COOKIE = 'dubli_admin';

export interface SessionPayload {
  u: string;
  role: string;
  exp: number; // ms epoch
}

const b64url = (b: Buffer): string => b.toString('base64url');

/** Подписанный stateless-токен сессии: base64url(payload).base64url(hmac). */
export function signSession(secret: string, payload: SessionPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

/** Проверка подписи + срока. null, если невалиден/истёк. */
export function verifySession(secret: string, token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Сравнение строк постоянного времени (без утечки длины/префикса). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Разбор заголовка Cookie в map (без cookie-parser). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
