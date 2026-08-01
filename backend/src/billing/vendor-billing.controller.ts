import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { VendorTokenGuard } from './vendor-token.guard';
import { SubscriptionsService } from './subscriptions.service';
import type { SubscriptionStatus } from '../common/db/database.types';

interface ExtendBody {
  paid_till?: string;
  add_months?: number;
  reason?: string;
  actor?: string;
}
interface MutateBody {
  reason?: string;
  actor?: string;
}

const numOrUndef = (v?: string): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Вендор-управление подписками клиентов (внешняя оплата — amoCRM даты не хранит).
 * Защищено VendorTokenGuard (заголовок X-Vendor-Token = VENDOR_ADMIN_TOKEN).
 */
@Controller('vendor/billing')
@UseGuards(VendorTokenGuard)
export class VendorBillingController {
  constructor(private readonly subs: SubscriptionsService) {}

  /** Список клиентов: subdomain, status, users, paid_till, trial_ends_at, сумма последнего, дней до конца. */
  @Get('subscriptions')
  list(
    @Query('query') query?: string,
    @Query('status') status?: string,
    @Query('expiring_in_days') expiringInDays?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.subs.list({
      query: query || undefined,
      status: (status as SubscriptionStatus) || undefined,
      expiringInDays: numOrUndef(expiringInDays),
      limit: numOrUndef(limit),
      offset: numOrUndef(offset),
    });
  }

  /** Карточка подписки + история платежей. */
  @Get('subscriptions/:subdomain')
  get(@Param('subdomain') subdomain: string) {
    return this.subs.getBySubdomain(subdomain);
  }

  /** Установить/сдвинуть дату продления: { paid_till } ЛИБО { add_months }. */
  @Post('subscriptions/:subdomain/extend')
  async extend(@Param('subdomain') subdomain: string, @Body() body: ExtendBody) {
    const accountId = await this.subs.resolveAccountId(subdomain);
    return this.subs.extend(accountId, {
      paidTill: body?.paid_till,
      addMonths: body?.add_months,
      reason: body?.reason,
      actor: body?.actor,
    });
  }

  /** Приостановить (доступ закрыть). */
  @Post('subscriptions/:subdomain/suspend')
  async suspend(@Param('subdomain') subdomain: string, @Body() body: MutateBody) {
    const accountId = await this.subs.resolveAccountId(subdomain);
    await this.subs.suspend(accountId, { reason: body?.reason, actor: body?.actor });
    return { ok: true };
  }

  /** Снять приостановку (active, если paid_till в будущем). */
  @Post('subscriptions/:subdomain/resume')
  async resume(@Param('subdomain') subdomain: string, @Body() body: MutateBody) {
    const accountId = await this.subs.resolveAccountId(subdomain);
    return this.subs.resume(accountId, { actor: body?.actor });
  }

  /** Отметить счёт оплаченным вручную (fallback к стадийному вебхуку). Матчинг по номеру. */
  @Post('invoices/:number/mark-paid')
  markInvoicePaid(@Param('number') number: string, @Body() body: MutateBody) {
    return this.subs.markInvoicePaid(number, { actor: body?.actor ?? 'vendor-admin' });
  }

  /** Включить/выключить авто-продление карты. */
  @Post('subscriptions/:subdomain/auto-renew')
  async autoRenew(@Param('subdomain') subdomain: string, @Body() body: { enabled?: boolean; actor?: string }) {
    const accountId = await this.subs.resolveAccountId(subdomain);
    return this.subs.setAutoRenew(accountId, Boolean(body?.enabled), body?.actor);
  }
}
