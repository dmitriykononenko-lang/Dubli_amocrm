import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';

export interface YkPayment {
  id: string;
  status: string;
  paid?: boolean;
  amount?: { value: string; currency: string };
  confirmation?: { confirmation_url?: string };
  metadata?: Record<string, unknown>;
}

/**
 * Клиент ЮKassa (api.yookassa.ru). Basic-auth = shopId:secret.
 * Карточные данные не проходят через нас — используется hosted-страница ЮKassa.
 */
@Injectable()
export class YookassaClient {
  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return Boolean(this.config.yookassaShopId && this.config.yookassaSecretKey);
  }

  private authHeader(): string {
    const raw = `${this.config.yookassaShopId}:${this.config.yookassaSecretKey}`;
    return 'Basic ' + Buffer.from(raw).toString('base64');
  }

  async createPayment(input: {
    amount: number;
    description: string;
    returnUrl: string;
    metadata: Record<string, unknown>;
  }): Promise<YkPayment> {
    const res = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Idempotence-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: { value: input.amount.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: input.returnUrl },
        description: input.description.slice(0, 128),
        metadata: input.metadata,
      }),
    });
    if (!res.ok) throw new Error(`ЮKassa createPayment ${res.status}: ${await res.text()}`);
    return (await res.json()) as YkPayment;
  }

  /** Перепроверка платежа по id (не доверяем телу вебхука). */
  async getPayment(id: string): Promise<YkPayment> {
    const res = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(id)}`, {
      headers: { Authorization: this.authHeader() },
    });
    if (!res.ok) throw new Error(`ЮKassa getPayment ${res.status}`);
    return (await res.json()) as YkPayment;
  }
}
