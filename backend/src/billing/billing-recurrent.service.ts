import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsRepository } from './subscriptions.repository';
import { YookassaClient } from './yookassa.client';
import { computeQuote } from './billing.pricing';

/**
 * Рекуррент карты: безакцептные списания на дату продления + dunning при неудаче.
 * Списание идемпотентно на стороне ЮKassa (Idempotence-Key = accountId+paid_till+attempt),
 * а продление — по payment_id (payments UNIQUE), так что двойного списания/продления нет.
 */
@Injectable()
export class BillingRecurrentService {
  private readonly log = new Logger('BillingRecurrent');

  constructor(
    private readonly subs: SubscriptionsService,
    private readonly repo: SubscriptionsRepository,
    private readonly yookassa: YookassaClient,
    private readonly config: AppConfigService,
  ) {}

  async chargeDueCards(): Promise<{ charged: number; failed: number; canceled: number }> {
    let charged = 0;
    let failed = 0;
    let canceled = 0;
    if (!this.yookassa.enabled) return { charged, failed, canceled };
    const now = new Date();
    const due = await this.repo.dueForCharge(now, this.config.billingRenewLeadDays);

    for (const s of due) {
      const accountId = String(s.account_id);
      const users = s.users ?? this.config.billingMinUsers;
      const months = s.months ?? 12;
      const q = computeQuote(users, months, {
        pricePerUser: this.config.billingPricePerUser,
        minUsers: this.config.billingMinUsers,
      });
      const idempotenceKey = `recur:${accountId}:${s.paid_till ? new Date(s.paid_till).getTime() : 0}:${s.dunning_attempts}`;
      try {
        const payment = await this.yookassa.chargeSaved({
          amount: q.sum,
          description: `Продление «Дубли»: ${q.users} польз. × ${q.months} мес`,
          paymentMethodId: s.yk_payment_method_id,
          metadata: { accountId, users: q.users, months: q.months, recurrent: true },
          idempotenceKey,
        });
        if (payment.status === 'succeeded') {
          await this.subs.recordPayment({
            accountId,
            months,
            users,
            source: 'yookassa',
            paymentId: payment.id,
            amount: q.sum,
          });
          charged++;
          this.log.log(`Рекуррент: списано с ${accountId} на ${q.sum} ₽`);
        } else if (payment.status === 'pending') {
          // off-session редко бывает pending; дождёмся вебхука, не считаем неудачей.
          this.log.log(`Рекуррент: платёж ${payment.id} pending (${accountId})`);
        } else {
          (await this.dunning(accountId, s.dunning_attempts, now)) === 'canceled' ? canceled++ : failed++;
        }
      } catch (e) {
        (await this.dunning(accountId, s.dunning_attempts, now)) === 'canceled' ? canceled++ : failed++;
        this.log.warn(`Рекуррент ${accountId}: ${String(e)}`);
      }
    }
    if (charged || failed || canceled) {
      this.log.log(`Рекуррент итог: списано ${charged}, повтор ${failed}, отменено ${canceled}`);
    }
    return { charged, failed, canceled };
  }

  /** Неудачное списание: планируем следующий ретрай или (по исчерпании) отменяем подписку. */
  private async dunning(accountId: string, prevAttempts: number, now: Date): Promise<'retry' | 'canceled'> {
    const retries = this.config.billingDunningRetries; // напр. [1,3,5]
    const attempt = (prevAttempts ?? 0) + 1;
    if (attempt <= retries.length) {
      const next = new Date(now.getTime() + retries[attempt - 1] * 86400_000);
      // Доступ держим до следующего ретрая (grace), статус — past_due.
      await this.repo.update(accountId, {
        dunning_attempts: attempt,
        next_charge_at: next,
        status: 'past_due',
        grace_until: next,
      });
      this.log.warn(`Dunning ${accountId}: попытка ${attempt}/${retries.length}, повтор ${next.toISOString().slice(0, 10)}`);
      return 'retry';
    }
    await this.repo.update(accountId, { status: 'canceled', auto_renew: false, next_charge_at: null });
    this.log.warn(`Dunning ${accountId}: исчерпано (${retries.length}) → canceled`);
    return 'canceled';
  }
}
