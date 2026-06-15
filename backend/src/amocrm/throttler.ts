/**
 * Простой лимитер ~rps запросов в секунду (token-bucket) на ключ/аккаунт.
 * Защищает от превышения лимита amoCRM API (~7 req/s — сверить с докой).
 */
export class Throttler {
  private readonly queue: Array<() => void> = [];
  private tokens: number;
  private readonly capacity: number;
  private readonly refillMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(rps: number) {
    this.capacity = Math.max(1, Math.floor(rps));
    this.tokens = this.capacity;
    this.refillMs = Math.max(1, Math.floor(1000 / this.capacity));
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private drain(): void {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens--;
      this.queue.shift()!();
    }
    if (this.queue.length > 0 && this.timer === null) {
      this.timer = setInterval(() => {
        this.tokens = Math.min(this.capacity, this.tokens + 1);
        this.drain();
        if (this.queue.length === 0 && this.timer !== null) {
          clearInterval(this.timer);
          this.timer = null;
        }
      }, this.refillMs);
      this.timer.unref?.();
    }
  }
}
