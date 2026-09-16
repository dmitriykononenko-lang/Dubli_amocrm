import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  product: string;
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

  /** Гарантирует строку подписки на продукт (idempotent). Триал — от установки; paid_till — из legacy settings. */
  async ensure(accountId: string, product = 'dubli'): Promise<SubscriptionRow> {
    const existing = await this.repo.find(accountId, product);
    if (existing) return existing;

    const acc = await this.accounts.findById(accountId);
    const installedAt = acc?.installed_at ? new Date(acc.installed_at) : new Date();
    const trialDays = this.config.billingTrialDays;
    const trialEndsAt = trialDays > 0 ? new Date(installedAt.getTime() + trialDays * DAY_MS) : null;

    // Не терять оплату клиентов, у кого дата хранилась в settings.paid_until (до этой таблицы).
    // Legacy paid_until относится к Дубли — на другие продукты его не переносим.
    const settings = product === 'dubli' ? await this.accounts.getSettings(accountId) : {};
    const paidTill = settings.paid_until ? new Date(String(settings.paid_until)) : null;

    const now = new Date();
    const status: SubscriptionStatus =
      paidTill && paidTill > now ? 'active' : trialEndsAt && trialEndsAt > now ? 'trial' : 'past_due';

    await this.repo.ensure(accountId, { status, trialEndsAt, paidTill }, product);
    return (await this.repo.find(accountId, product)) as SubscriptionRow;
  }

  /**
   * Состояние доступа: разрешён, если не приостановлен и now ≤ paid_till ИЛИ now ≤ grace_until
   * (льгота для банковского перевода по счёту) ИЛИ now ≤ trial_ends_at.
   */
  async access(accountId: string, product = 'dubli'): Promise<AccessState> {
    const sub = await this.ensure(accountId, product);
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
      product: sub.product ?? 'dubli',
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
    product?: string;
    users?: number | null;
    months: number;
    source: PaymentSource;
    paymentId?: string | null;
    amount?: number | null;
    actor?: string | null;
    reason?: string | null;
    ykPaymentMethodId?: string | null;
  }): Promise<{ paidTill: string; duplicate: boolean }> {
    const product = input.product ?? 'dubli';
    const sub = await this.ensure(input.accountId, product);
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
      patch.dunning_attempts = 0; // успешное списание сбрасывает счётчик неудач
      patch.next_charge_at = null;
      if (input.ykPaymentMethodId) patch.yk_payment_method_id = input.ykPaymentMethodId;
    } else if (input.source === 'invoice') {
      patch.payment_method = 'invoice';
      patch.grace_until = new Date(newPaidTill.getTime() + this.config.billingInvoiceGraceDays * DAY_MS);
    }
    await this.repo.update(input.accountId, patch, product);
    await this.repo.insertPayment({
      accountId: input.accountId,
      product,
      amount: input.amount ?? null,
      users: input.users ?? sub.users,
      months,
      source: input.source,
      paymentId: input.paymentId ?? null,
      reason: input.reason ?? null,
      actor: input.actor ?? input.source,
      paidTill: newPaidTill,
    });
    this.log.log(
      `Оплата (${input.source}) аккаунт ${input.accountId}/${product}: +${months} мес → ${newPaidTill.toISOString()}`,
    );
    return { paidTill: newPaidTill.toISOString(), duplicate: false };
  }

  /**
   * Выставление счёта (трек invoice): создаём запись invoices с уникальным номером и
   * переводим подписку в awaiting_invoice_payment. Авто-списания нет — ждём подтверждения.
   */
  async issueInvoice(
    accountId: string,
    input: {
      users?: number | null;
      months: number;
      amount?: number | null;
      number: string;
      vendorDealId?: string | null;
      product?: string;
    },
  ): Promise<{ number: string }> {
    const product = input.product ?? 'dubli';
    await this.ensure(accountId, product);
    await this.repo.createInvoice({
      accountId,
      product,
      number: input.number,
      amount: input.amount ?? null,
      periodMonths: input.months,
      users: input.users ?? null,
      vendorDealId: input.vendorDealId ?? null,
    });
    await this.repo.update(accountId, { status: 'awaiting_invoice_payment' }, product);
    this.log.log(`Счёт ${input.number} выставлен аккаунту ${accountId}/${product} (${input.months} мес)`);
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
      product: inv.product ?? 'dubli',
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
    input: {
      paidTill?: string;
      addMonths?: number;
      reason?: string;
      actor?: string;
      product?: string;
      paymentId?: string | null;
      amount?: number | null;
      source?: PaymentSource;
    },
  ): Promise<{ paidTill: string; duplicate: boolean }> {
    const product = input.product ?? 'dubli';
    const sub = await this.ensure(accountId, product);
    // Идемпотентность (для ingest): повторный payment_id не сдвигает дату второй раз.
    if (input.paymentId && (await this.repo.paymentExists(input.paymentId))) {
      this.log.log(`Продление ${input.paymentId} уже учтено — пропуск (идемпотентность)`);
      return { paidTill: sub.paid_till ? new Date(sub.paid_till).toISOString() : '', duplicate: true };
    }
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
    await this.repo.update(accountId, { paid_till: newPaidTill, status }, product);
    await this.repo.insertPayment({
      accountId,
      product,
      amount: input.amount ?? null,
      users: sub.users,
      months: input.addMonths ?? null,
      source: input.source ?? 'manual',
      paymentId: input.paymentId ?? null,
      reason: input.reason ?? 'Ручная корректировка даты продления',
      actor: input.actor ?? 'vendor-admin',
      paidTill: newPaidTill,
    });
    this.log.log(
      `Ручное продление аккаунт ${accountId}/${product} → ${newPaidTill.toISOString()} (${input.reason ?? '—'})`,
    );
    return { paidTill: newPaidTill.toISOString(), duplicate: false };
  }

  /** Подписки, которым пора напомнить об истечении (в окне BILLING_NOTIFY_LEAD_DAYS). */
  async listDueReminders(): Promise<
    Array<{ accountId: string; product: string; subdomain: string; paymentMethod: string; paidTill: string; daysLeft: number }>
  > {
    const lead = this.config.billingNotifyLeadDays;
    if (lead <= 0) return [];
    const now = new Date();
    const rows = await this.repo.dueForReminder(now, lead);
    return rows.map((r) => {
      const paidTill = new Date(r.paid_till);
      return {
        accountId: String(r.account_id),
        product: r.product ?? 'dubli',
        subdomain: r.subdomain,
        paymentMethod: r.payment_method,
        paidTill: paidTill.toISOString(),
        daysLeft: Math.ceil((paidTill.getTime() - now.getTime()) / DAY_MS),
      };
    });
  }

  /** Отметить, что напоминание отправлено (гасит повтор в этом окне). */
  async markNotified(accountId: string, product = 'dubli'): Promise<void> {
    await this.repo.setNotified(accountId, new Date(), product);
  }

  /** Пометить просроченные подписки past_due. Возвращает число помеченных. */
  async markOverdue(): Promise<number> {
    return this.repo.markOverdue(new Date());
  }

  /** Включить/выключить авто-продление карты (рекуррент). */
  async setAutoRenew(accountId: string, enabled: boolean, actor?: string, product = 'dubli'): Promise<{ autoRenew: boolean }> {
    await this.ensure(accountId, product);
    await this.repo.update(accountId, { auto_renew: enabled }, product);
    await this.repo.insertPayment({
      accountId,
      product,
      amount: null,
      users: null,
      months: null,
      source: 'manual',
      paymentId: null,
      reason: `auto_renew = ${enabled}`,
      actor: actor ?? 'vendor-admin',
      paidTill: null,
    });
    return { autoRenew: enabled };
  }

  /** Приостановка: доступ закрыт (status=canceled), дата сохраняется. */
  async suspend(accountId: string, input: { reason?: string; actor?: string; product?: string }): Promise<void> {
    const product = input.product ?? 'dubli';
    const sub = await this.ensure(accountId, product);
    await this.repo.update(accountId, { status: 'canceled' }, product);
    await this.repo.insertPayment({
      accountId,
      product,
      amount: null,
      users: sub.users,
      months: null,
      source: 'manual',
      paymentId: null,
      reason: `Приостановка: ${input.reason ?? '—'}`,
      actor: input.actor ?? 'vendor-admin',
      paidTill: sub.paid_till ? new Date(sub.paid_till) : null,
    });
    this.log.log(`Приостановка аккаунт ${accountId}/${product} (${input.reason ?? '—'})`);
  }

  /** Снятие приостановки: active, если paid_till в будущем, иначе past_due. */
  async resume(accountId: string, input: { actor?: string; product?: string }): Promise<{ status: SubscriptionStatus }> {
    const product = input.product ?? 'dubli';
    const sub = await this.ensure(accountId, product);
    const now = new Date();
    const future = sub.paid_till != null && new Date(sub.paid_till) > now;
    const status: SubscriptionStatus = future ? 'active' : 'past_due';
    await this.repo.update(accountId, { status }, product);
    await this.repo.insertPayment({
      accountId,
      product,
      amount: null,
      users: sub.users,
      months: null,
      source: 'manual',
      paymentId: null,
      reason: 'Снятие приостановки',
      actor: input.actor ?? 'vendor-admin',
      paidTill: sub.paid_till ? new Date(sub.paid_till) : null,
    });
    this.log.log(`Снятие приостановки аккаунт ${accountId}/${product} → ${status}`);
    return { status };
  }

  /** Список подписок для вендор-панели (фильтры + пагинация + дней до конца). */
  async list(f: {
    query?: string;
    status?: SubscriptionStatus;
    product?: string;
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
      product: f.product,
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
        product: r.product ?? 'dubli',
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

  /** Реестр продуктов (виджетов) для панели/хаба. */
  listProducts(): Promise<Array<{ code: string; name: string; enabled: boolean }>> {
    return this.repo.listProducts();
  }

  /**
   * Ingest из бэкендов других наших виджетов: регистрация/продление подписки в хабе.
   * Один аккаунт может иметь несколько продуктов (подписка адресуется account_id+product).
   *  - account_id задан → upsert аккаунта (регистрация внешнего виджета); иначе матчим по субдомену.
   *  - action=ensure → только гарантируем подписку (триал), без платежа.
   *  - action=extend/paid → продление (по paid_till ЛИБО months). Идемпотентно по payment_id
   *    (payments.payment_id UNIQUE — повтор не продлевает дважды), всё пишется в payments (аудит).
   */
  async ingest(input: {
    subdomain?: string | null;
    accountId?: string | number | null;
    product?: string | null;
    action: 'ensure' | 'extend' | 'paid';
    users?: number | null;
    months?: number | null;
    paidTill?: string | null;
    amount?: number | null;
    paymentId?: string | null;
    source?: string | null;
  }): Promise<{
    ok: true;
    accountId: string;
    product: string;
    action: 'ensure' | 'extend' | 'paid';
    paidTill: string | null;
    duplicate: boolean;
  }> {
    const product = (input.product ?? 'dubli').toString().trim() || 'dubli';
    const subdomain = (input.subdomain ?? '').toString().trim();
    const action = input.action;
    if (!['ensure', 'extend', 'paid'].includes(action)) {
      throw new BadRequestException(`Некорректный action: ${action}`);
    }

    // Аккаунт: пришёл account_id → регистрируем/обновляем; иначе матчим по субдомену.
    let accountId: string;
    if (input.accountId != null && String(input.accountId).trim() !== '') {
      accountId = String(input.accountId).trim();
      if (!subdomain) throw new BadRequestException('Для регистрации аккаунта нужен subdomain');
      await this.accounts.upsert({ accountId, subdomain });
    } else {
      if (!subdomain) throw new BadRequestException('Укажите subdomain или account_id');
      accountId = await this.resolveAccountId(subdomain);
    }

    const sub = await this.ensure(accountId, product);
    if (action === 'ensure') {
      return {
        ok: true,
        accountId,
        product,
        action,
        paidTill: sub.paid_till ? new Date(sub.paid_till).toISOString() : null,
        duplicate: false,
      };
    }

    // enum-источник платежа для аудита: валидные значения как есть, остальное → manual (метка в actor).
    const src: PaymentSource = input.source === 'yookassa' || input.source === 'invoice' ? input.source : 'manual';
    const actor = input.source ? `ingest:${input.source}` : 'ingest';
    const reason = `Ingest ${action} (${input.source ?? 'external'})`;

    // Продление по точной дате (paid_till) — через extend; иначе по количеству месяцев — через recordPayment.
    if (input.paidTill) {
      const res = await this.extend(accountId, {
        paidTill: input.paidTill,
        product,
        paymentId: input.paymentId ?? null,
        amount: input.amount ?? null,
        source: src,
        actor,
        reason,
      });
      return { ok: true, accountId, product, action, paidTill: res.paidTill || null, duplicate: res.duplicate };
    }

    const months = Math.max(1, Math.floor(Number(input.months ?? 0)) || 1);
    const res = await this.recordPayment({
      accountId,
      product,
      months,
      users: input.users ?? null,
      source: src,
      paymentId: input.paymentId ?? null,
      amount: input.amount ?? null,
      actor,
      reason,
    });
    return { ok: true, accountId, product, action, paidTill: res.paidTill || null, duplicate: res.duplicate };
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
