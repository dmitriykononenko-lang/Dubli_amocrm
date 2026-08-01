import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AccountsService } from '../accounts/accounts.service';
import {
  SubscriptionsRepository,
  type PaymentRow,
  type SubscriptionRow,
} from './subscriptions.repository';
import type { PaymentSource, SubscriptionStatus } from '../common/db/database.types';

const DAY_MS = 86400_000;

export interface AccessState {
  allowed: boolean;
  status: SubscriptionStatus;
  paymentMethod: string;
  paidTill: string | null;
  graceUntil: string | null;
  trialEndsAt: string | null;
  daysLeft: number | null;
}

/**
 * Подписки клиентов (источник истины по оплате и дате продления). Виджет в amoМаркете —
 * «Внешняя оплата», amoCRM «оплачено до» не хранит: продление, триал и гейтинг доступа — здесь.
 */
@Injectable()
export class SubscriptionsService {
  private readonly log = new Logger('Subscriptions');

  constructor(
    private readonly repo: SubscriptionsRepository,
    private readonly accounts: AccountsService,
    private readonly config: AppConfigService,
  ) {}

  /** Гарантирует строку подписки (idempotent). Триал — от установки; paid_till — из legacy settings. */
  async ensure(accountId: string): Promise<SubscriptionRow> {
    const existing = await this.repo.find(accountId);
    if (existing) return existing;

    const acc = await this.accounts.findById(accountId);
    const installedAt = acc?.installed_at ? new Date(acc.installed_at) : new Date();
    const trialDays = this.config.billingTrialDays;
    const trialEndsAt = trialDays > 0 ? new Date(installedAt.getTime() + trialDays * DAY_MS) : null;

    // Не терять оплату клиентов, у кого дата хранилась в settings.paid_until (до этой таблицы).
    const settings = await this.accounts.getSettings(accountId);
    const paidTill = settings.paid_until ? new Date(String(settings.paid_until)) : null;

    const now = new Date();
    const status: SubscriptionStatus =
      paidTill && paidTill > now ? 'active' : trialEndsAt && trialEndsAt > now ? 'trial' : 'past_due';

    await this.repo.ensure(accountId, { status, trialEndsAt, paidTill });
    return (await this.repo.find(accountId)) as SubscriptionRow;
  }

  /**
   * Состояние доступа: разрешён, если не приостановлен и now ≤ paid_till ИЛИ now ≤ grace_until
   * (льгота для банковского перевода по счёту) ИЛИ now ≤ trial_ends_at.
   */
  async access(accountId: string): Promise<AccessState> {
    const sub = await this.ensure(accountId);
    const now = new Date();
    const paidTill = sub.paid_till ? new Date(sub.paid_till) : null;
    const graceUntil = sub.grace_until ? new Date(sub.grace_until) : null;
    const trialEndsAt = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
    const dateOk =
      (paidTill != null && now <= paidTill) ||
      (graceUntil != null && now <= graceUntil) ||
      (trialEndsAt != null && now <= trialEndsAt);
    const allowed = sub.status !== 'canceled' && dateOk;
    const horizon = this.latest(paidTill, graceUntil, trialEndsAt);
    const daysLeft = horizon ? Math.ceil((horizon.getTime() - now.getTime()) / DAY_MS) : null;
    return {
      allowed,
      status: sub.status,
      paymentMethod: sub.payment_method,
      paidTill: paidTill ? paidTill.toISOString() : null,
      graceUntil: graceUntil ? graceUntil.toISOString() : null,
      trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
      daysLeft,
    };
  }

  private latest(...dates: Array<Date | null>): Date | null {
    const t = dates.filter((d): d is Date => d != null).map((d) => d.getTime());
    return t.length ? new Date(Math.max(...t)) : null;
  }

  /**
   * Учёт оплаты (ЮKassa/счёт): продлеваем от текущей даты, если подписка активна, иначе от now.
   * Идемпотентно по paymentId (повторный вебхук не продлевает второй раз). Возвращает новую дату.
   */
  async recordPayment(input: {
    accountId: string;
    users?: number | null;
    months: number;
    source: PaymentSource;
    paymentId?: string | null;
    amount?: number | null;
    actor?: string | null;
    reason?: string | null;
    ykPaymentMethodId?: string | null;
  }): Promise<{ paidTill: string; duplicate: boolean }> {
    const sub = await this.ensure(input.accountId);
    if (input.paymentId && (await this.repo.paymentExists(input.paymentId))) {
      this.log.log(`Платёж ${input.paymentId} уже учтён — пропуск (идемпотентность)`);
      return { paidTill: sub.paid_till ? new Date(sub.paid_till).toISOString() : '', duplicate: true };
    }
    const months = Math.max(1, Math.floor(input.months));
    const newPaidTill = this.addMonths(this.baseFrom(sub.paid_till), months);
    const patch: Parameters<typeof this.repo.update>[1] = {
      status: 'active',
      users: input.users ?? sub.users,
      months,
      paid_till: newPaidTill,
    };
    // Трек оплаты: карта (ЮKassa) — рекуррент без grace; счёт — с льготным периодом.
    if (input.source === 'yookassa') {
      patch.payment_method = 'card';
      patch.auto_renew = true;
      patch.grace_until = null;
      if (input.ykPaymentMethodId) patch.yk_payment_method_id = input.ykPaymentMethodId;
    } else if (input.source === 'invoice') {
      patch.payment_method = 'invoice';
      patch.grace_until = new Date(newPaidTill.getTime() + this.config.billingInvoiceGraceDays * DAY_MS);
    }
    await this.repo.update(input.accountId, patch);
    await this.repo.insertPayment({
      accountId: input.accountId,
      amount: input.amount ?? null,
      users: input.users ?? sub.users,
      months,
      source: input.source,
      paymentId: input.paymentId ?? null,
      reason: input.reason ?? null,
      actor: input.actor ?? input.source,
      paidTill: newPaidTill,
    });
    this.log.log(`Оплата (${input.source}) аккаунт ${input.accountId}: +${months} мес → ${newPaidTill.toISOString()}`);
    return { paidTill: newPaidTill.toISOString(), duplicate: false };
  }

  /**
   * Выставление счёта (трек invoice): создаём запись invoices с уникальным номером и
   * переводим подписку в awaiting_invoice_payment. Авто-списания нет — ждём подтверждения.
   */
  async issueInvoice(
    accountId: string,
    input: { users?: number | null; months: number; amount?: number | null; number: string; vendorDealId?: string | null },
  ): Promise<{ number: string }> {
    await this.ensure(accountId);
    await this.repo.createInvoice({
      accountId,
      number: input.number,
      amount: input.amount ?? null,
      periodMonths: input.months,
      users: input.users ?? null,
      vendorDealId: input.vendorDealId ?? null,
    });
    await this.repo.update(accountId, { status: 'awaiting_invoice_payment' });
    this.log.log(`Счёт ${input.number} выставлен аккаунту ${accountId} (${input.months} мес)`);
    return { number: input.number };
  }

  /**
   * Подтверждение оплаты счёта по номеру (стадия сделки «Оплачен» или вручную из панели).
   * Идемпотентно: повторный вызов на уже оплаченном счёте не продлевает второй раз.
   */
  async markInvoicePaid(
    number: string,
    input: { actor?: string } = {},
  ): Promise<{ ok: true; paidTill: string | null; alreadyPaid: boolean }> {
    const inv = await this.repo.findInvoiceByNumber(number);
    if (!inv) throw new NotFoundException(`Счёт не найден: ${number}`);
    if (inv.status === 'paid') return { ok: true, paidTill: null, alreadyPaid: true };

    const accountId = String(inv.account_id);
    await this.repo.updateInvoice(String(inv.id), { status: 'paid', paid_at: new Date() });
    const res = await this.recordPayment({
      accountId,
      months: inv.period_months ?? 1,
      users: inv.users,
      source: 'invoice',
      paymentId: `invoice:${number}`, // идемпотентность продления по номеру счёта
      amount: inv.amount != null ? Number(inv.amount) : null,
      actor: input.actor ?? 'vendor-admin',
      reason: `Оплата счёта ${number}`,
    });
    this.log.log(`Счёт ${number} отмечен оплаченным (актор ${input.actor ?? 'vendor-admin'})`);
    return { ok: true, paidTill: res.paidTill, alreadyPaid: false };
  }

  /** Подтверждение по сделке-счёту (вебхук стадии «Оплачен» из koagency). */
  async markInvoicePaidByDeal(
    vendorDealId: string,
    input: { actor?: string } = {},
  ): Promise<{ ok: true; paidTill: string | null; alreadyPaid: boolean } | { ok: false; reason: string }> {
    const inv = await this.repo.findInvoiceByDeal(vendorDealId);
    if (!inv) return { ok: false, reason: `Счёт по сделке ${vendorDealId} не найден` };
    return this.markInvoicePaid(inv.number, input);
  }

  /** Ручная установка/сдвиг даты продления вендором (paid_till ЛИБО add_months). */
  async extend(
    accountId: string,
    input: { paidTill?: string; addMonths?: number; reason?: string; actor?: string },
  ): Promise<{ paidTill: string }> {
    const sub = await this.ensure(accountId);
    let newPaidTill: Date;
    if (input.paidTill) {
      const d = new Date(input.paidTill);
      if (Number.isNaN(d.getTime())) throw new NotFoundException('Некорректная дата paid_till');
      newPaidTill = d;
    } else if (input.addMonths && input.addMonths > 0) {
      newPaidTill = this.addMonths(this.baseFrom(sub.paid_till), Math.floor(input.addMonths));
    } else {
      throw new NotFoundException('Укажите paid_till или add_months');
    }
    const now = new Date();
    const status: SubscriptionStatus = newPaidTill > now ? 'active' : sub.status;
    await this.repo.update(accountId, { paid_till: newPaidTill, status });
    await this.repo.insertPayment({
      accountId,
      amount: null,
      users: sub.users,
      months: input.addMonths ?? null,
      source: 'manual',
      paymentId: null,
      reason: input.reason ?? 'Ручная корректировка даты продления',
      actor: input.actor ?? 'vendor-admin',
      paidTill: newPaidTill,
    });
    this.log.log(`Ручное продление аккаунт ${accountId} → ${newPaidTill.toISOString()} (${input.reason ?? '—'})`);
    return { paidTill: newPaidTill.toISOString() };
  }

  /** Приостановка: доступ закрыт (status=canceled), дата сохраняется. */
  async suspend(accountId: string, input: { reason?: string; actor?: string }): Promise<void> {
    const sub = await this.ensure(accountId);
    await this.repo.update(accountId, { status: 'canceled' });
    await this.repo.insertPayment({
      accountId,
      amount: null,
      users: sub.users,
      months: null,
      source: 'manual',
      paymentId: null,
      reason: `Приостановка: ${input.reason ?? '—'}`,
      actor: input.actor ?? 'vendor-admin',
      paidTill: sub.paid_till ? new Date(sub.paid_till) : null,
    });
    this.log.log(`Приостановка аккаунт ${accountId} (${input.reason ?? '—'})`);
  }

  /** Снятие приостановки: active, если paid_till в будущем, иначе past_due. */
  async resume(accountId: string, input: { actor?: string }): Promise<{ status: SubscriptionStatus }> {
    const sub = await this.ensure(accountId);
    const now = new Date();
    const future = sub.paid_till != null && new Date(sub.paid_till) > now;
    const status: SubscriptionStatus = future ? 'active' : 'past_due';
    await this.repo.update(accountId, { status });
    await this.repo.insertPayment({
      accountId,
      amount: null,
      users: sub.users,
      months: null,
      source: 'manual',
      paymentId: null,
      reason: 'Снятие приостановки',
      actor: input.actor ?? 'vendor-admin',
      paidTill: sub.paid_till ? new Date(sub.paid_till) : null,
    });
    this.log.log(`Снятие приостановки аккаунт ${accountId} → ${status}`);
    return { status };
  }

  /** Список подписок для вендор-панели (фильтры + пагинация + дней до конца). */
  async list(f: {
    query?: string;
    status?: SubscriptionStatus;
    expiringInDays?: number;
    limit?: number;
    offset?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const now = new Date();
    const limit = Math.min(200, Math.max(1, f.limit ?? 50));
    const offset = Math.max(0, f.offset ?? 0);
    const rows = await this.repo.list({
      query: f.query,
      status: f.status,
      expiringInDays: f.expiringInDays,
      limit,
      offset,
      now,
    });
    const trialDays = this.config.billingTrialDays;
    return rows.map((r) => {
      const paidTill = r.paid_till ? new Date(r.paid_till) : null;
      const graceUntil = r.grace_until ? new Date(r.grace_until) : null;
      const trialEndsAt = r.trial_ends_at
        ? new Date(r.trial_ends_at)
        : trialDays > 0 && r.installed_at
          ? new Date(new Date(r.installed_at).getTime() + trialDays * DAY_MS)
          : null;
      const horizon = this.latest(paidTill, graceUntil, trialEndsAt);
      const daysLeft = horizon ? Math.ceil((horizon.getTime() - now.getTime()) / DAY_MS) : null;
      return {
        subdomain: r.subdomain,
        accountId: String(r.account_id),
        status: r.status ?? 'trial',
        paymentMethod: r.payment_method ?? 'none',
        users: r.users,
        months: r.months,
        paidTill: paidTill ? paidTill.toISOString() : null,
        graceUntil: graceUntil ? graceUntil.toISOString() : null,
        trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
        lastAmount: r.last_amount != null ? Number(r.last_amount) : null,
        daysLeft,
      };
    });
  }

  /** Карточка подписки по субдомену + история платежей. */
  async getBySubdomain(subdomain: string): Promise<Record<string, unknown>> {
    const accountId = await this.resolveAccountId(subdomain);
    const access = await this.access(accountId);
    const acc = await this.accounts.findById(accountId);
    const payments = await this.repo.listPayments(accountId);
    const invoices = await this.repo.listInvoices(accountId);
    return {
      subdomain: acc?.subdomain ?? subdomain,
      accountId,
      ...access,
      payments: payments.map(this.paymentDto),
      invoices: invoices.map((i) => ({
        number: i.number,
        amount: i.amount != null ? Number(i.amount) : null,
        periodMonths: i.period_months,
        status: i.status,
        vendorDealId: i.vendor_deal_id,
        issuedAt: i.issued_at ? new Date(i.issued_at).toISOString() : null,
        paidAt: i.paid_at ? new Date(i.paid_at).toISOString() : null,
      })),
    };
  }

  /** subdomain → account_id (для vendor-эндпоинтов, которые адресуются субдоменом). */
  async resolveAccountId(subdomain: string): Promise<string> {
    const acc = await this.accounts.findBySubdomain(subdomain);
    if (!acc?.account_id) throw new NotFoundException(`Аккаунт не найден: ${subdomain}`);
    return String(acc.account_id);
  }

  private paymentDto(p: PaymentRow): Record<string, unknown> {
    return {
      at: p.created_at ? new Date(p.created_at).toISOString() : null,
      amount: p.amount != null ? Number(p.amount) : null,
      users: p.users,
      months: p.months,
      source: p.source,
      reason: p.reason,
      actor: p.actor,
      paidTill: p.paid_till ? new Date(p.paid_till).toISOString() : null,
    };
  }

  /** База отсчёта продления: текущая дата, если подписка ещё активна, иначе now. */
  private baseFrom(paidTill: Date | string | null): Date {
    const now = new Date();
    if (paidTill) {
      const d = new Date(paidTill);
      if (d > now) return d;
    }
    return now;
  }

  private addMonths(base: Date, months: number): Date {
    const d = new Date(base.getTime());
    d.setMonth(d.getMonth() + months);
    return d;
  }
}
