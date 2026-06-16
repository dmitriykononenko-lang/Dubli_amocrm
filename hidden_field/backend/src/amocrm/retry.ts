/** Ошибка, при которой запрос имеет смысл повторить (429/5xx). */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Повтор с экспоненциальным backoff + jitter. Уважает Retry-After (сек). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 300;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!(e instanceof RetryableError) || attempt === retries) throw e;
      const waitMs = e.retryAfterSec
        ? e.retryAfterSec * 1000
        : baseMs * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
