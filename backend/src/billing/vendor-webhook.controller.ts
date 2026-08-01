import { Body, Controller, ForbiddenException, HttpCode, Post, Query } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { AppConfigService } from '../config/app-config.service';

interface AmoLeadStatusEvent {
  id?: string;
  status_id?: string;
  pipeline_id?: string;
}
interface AmoWebhookBody {
  leads?: { status?: AmoLeadStatusEvent[] | Record<string, AmoLeadStatusEvent> };
}

/**
 * Вебхук koagency: сделка-счёт ушла в стадию «Оплачен» (VENDOR_AMOCRM_STATUS_PAID) →
 * подтверждаем оплату счёта по vendor_deal_id (оператор только двигает стадию).
 * amoCRM не шлёт заголовки авторизации, поэтому защита — ключ в query
 * (?key=WEBHOOK_SECURITY_KEY). Тело — form-urlencoded с вложенными массивами.
 */
@Controller('vendor/billing/webhook')
export class VendorWebhookController {
  constructor(
    private readonly subs: SubscriptionsService,
    private readonly config: AppConfigService,
  ) {}

  @Post('amocrm-paid')
  @HttpCode(200)
  async amocrmPaid(
    @Query('key') key: string,
    @Body() body: AmoWebhookBody,
  ): Promise<{ ok: boolean; handled: number }> {
    const expected = this.config.webhookSecurityKey;
    if (!expected || key !== expected) throw new ForbiddenException('Неверный ключ вебхука');
    const paidStatus = this.config.vendorAmocrmStatusPaid;
    if (!paidStatus) return { ok: true, handled: 0 };

    const raw = body?.leads?.status;
    const events: AmoLeadStatusEvent[] = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
    let handled = 0;
    for (const ev of events) {
      if (ev?.id && Number(ev.status_id) === Number(paidStatus)) {
        const res = await this.subs.markInvoicePaidByDeal(String(ev.id), { actor: 'amocrm-webhook' });
        if ('ok' in res && res.ok) handled++;
      }
    }
    return { ok: true, handled };
  }
}
