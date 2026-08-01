import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SubscriptionsService } from './subscriptions.service';
import { BillingNotifier } from './billing-notifier';
import { BillingRecurrentService } from './billing-recurrent.service';

type DueReminder = Awaited<ReturnType<SubscriptionsService['listDueReminders']>>[number];

/**
 * Ежедневное обслуживание биллинга (setInterval, как ScanProcessor — без @nestjs/schedule):
 *  - помечает просроченные подписки past_due;
 *  - шлёт напоминания об истечении (карта: «спишем автоматически», счёт: «пришлём счёт»),
 *    по одному разу на предыстечное окно (идемпотентно по notified_at).
 * В тестах (NODE_ENV=test) таймер не поднимается — tick() вызывают вручную.
 */
@Injectable()
export class BillingScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('BillingSched');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private static readonly INTERVAL_MS = 6 * 60 * 60 * 1000; // каждые 6 часов

  constructor(
    private readonly subs: SubscriptionsService,
    private readonly notifier: BillingNotifier,
    private readonly config: AppConfigService,
    private readonly recurrent: BillingRecurrentService,
  ) {}

  onModuleInit(): void {
    if (this.config.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.tick(), BillingScheduler.INTERVAL_MS);
    this.timer.unref?.();
    this.log.log('Планировщик биллинга активен (каждые 6 ч)');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // Сначала списываем карты (успех продлит paid_till и уберёт из «истекающих»).
      await this.recurrent.chargeDueCards();
      const overdue = await this.subs.markOverdue();
      if (overdue) this.log.log(`Помечено past_due: ${overdue}`);
      const due = await this.subs.listDueReminders();
      for (const d of due) {
        await this.notifier.send(this.composeReminder(d));
        await this.subs.markNotified(d.accountId);
      }
      if (due.length) this.log.log(`Напоминаний отправлено: ${due.length}`);
    } catch (e) {
      this.log.error(`tick: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private composeReminder(d: DueReminder): string {
    const base = `Подписка «Дубли» — ${d.subdomain}: истекает через ${d.daysLeft} дн (до ${d.paidTill.slice(0, 10)}).`;
    return d.paymentMethod === 'card'
      ? `${base} Спишем автоматически с сохранённой карты.`
      : `${base} Оплата по счёту: пришлём новый счёт — авто-списания нет.`;
  }
}
