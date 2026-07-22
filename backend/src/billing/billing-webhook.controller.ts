import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { BillingService } from './billing.service';

interface YkNotification {
  event?: string;
  object?: { id?: string };
}

/**
 * Публичный вебхук ЮKassa (без security_key — его вызывает ЮKassa).
 * Тело не доверяем: сервис перепроверяет платёж по id через API ЮKassa.
 */
@Controller('api/billing/yookassa')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() body: YkNotification): Promise<{ ok: true }> {
    const id = body?.object?.id;
    if (id) await this.billing.handlePaymentNotification(String(id));
    return { ok: true };
  }
}
