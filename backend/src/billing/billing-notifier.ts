import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Канал уведомлений вендора (напоминания об истечении). POST { text } на
 * BILLING_NOTIFY_TELEGRAM_WEBHOOK (Telegram-бот через прокси/incoming webhook или
 * любой webhook на вендор-канал). Если вебхук не задан — просто логируем.
 */
@Injectable()
export class BillingNotifier {
  private readonly log = new Logger('BillingNotify');

  constructor(private readonly config: AppConfigService) {}

  async send(text: string): Promise<void> {
    const url = this.config.billingNotifyTelegramWebhook;
    if (!url) {
      this.log.log(`(вебхук не задан) ${text}`);
      return;
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) this.log.warn(`Уведомление отклонено (${res.status})`);
    } catch (e) {
      this.log.warn(`Не удалось отправить уведомление: ${String(e)}`);
    }
  }
}
