import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type {
  DB,
  InvoiceStatus,
  InvoicesTable,
  PaymentMethodType,
  PaymentSource,
  PaymentsTable,
  SubscriptionStatus,
  SubscriptionsTable,
} from '../common/db/database.types';

export type SubscriptionRow = Selectable<SubscriptionsTable>;
export type PaymentRow = Selectable<PaymentsTable>;
export type InvoiceRow = Selectable<InvoicesTable>;

/** Строка листинга подписок для вендор-панели (аккаунт + подписка + последний платёж). */
export interface SubscriptionListRow {
  account_id: string;
  subdomain: string;
  installed_at: Date;
  status: SubscriptionStatus | null;
  users: number | null;
  months: number | null;
  paid_till: Date | null;
  trial_ends_at: Date | null;
  grace_until: Date | null;
  payment_method: PaymentMethodType | null;
  last_amount: string | null;
}

export interface ListFilter {
  query?: string;
  status?: SubscriptionStatus;
  expiringInDays?: number;
  limit: number;
  offset: number;
  now: Date;
}

@Injectable()
export class SubscriptionsRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  find(accountId: string): Promise<SubscriptionRow | undefined> {
    requireAccountId(accountId);
    return this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  }

  /** Создаёт подписку, если её ещё нет (idempotent). */
  async ensure(
    accountId: string,
    seed: { status: SubscriptionStatus; trialEndsAt: Date | null; paidTill: Date | null },
  ): Promise<void> {
    requireAccountId(accountId);
    await this.db
      .insertInto('subscriptions')
      .values({
        account_id: accountId,
        status: seed.status,
        trial_ends_at: seed.trialEndsAt,
        paid_till: seed.paidTill,
      })
      .onConflict((oc) => oc.column('account_id').doNothing())
      .execute();
  }

  async update(
    accountId: string,
    patch: Partial<{
      status: SubscriptionStatus;
      users: number | null;
      months: number | null;
      paid_till: Date | null;
      trial_ends_at: Date | null;
      grace_until: Date | null;
      payment_method: PaymentMethodType;
      yk_payment_method_id: string | null;
      auto_renew: boolean;
      dunning_attempts: number;
      next_charge_at: Date | null;
    }>,
  ): Promise<void> {
    requireAccountId(accountId);
    await this.db
      .updateTable('subscriptions')
      .set({ ...patch, updated_at: new Date() })
      .where('account_id', '=', accountId)
      .execute();
  }

  /**
   * Карты к безакцептному списанию: payment_method=card, auto_renew, есть сохранённый метод,
   * и либо близко к paid_till (окно leadDays), либо наступил срок dunning-повтора (next_charge_at).
   */
  dueForCharge(
    now: Date,
    leadDays: number,
  ): Promise<
    Array<{
      account_id: string;
      users: number | null;
      months: number | null;
      paid_till: Date | null;
      dunning_attempts: number;
      yk_payment_method_id: string;
    }>
  > {
    const soon = new Date(now.getTime() + leadDays * 86400_000);
    return this.db
      .selectFrom('subscriptions')
      .select(['account_id', 'users', 'months', 'paid_till', 'dunning_attempts', 'yk_payment_method_id'])
      .where('payment_method', '=', 'card')
      .where('auto_renew', '=', true)
      .where('yk_payment_method_id', 'is not', null)
      .where('status', 'in', ['active', 'past_due'])
      .where((eb) =>
        eb.or([
          eb.and([eb('paid_till', 'is not', null), eb('paid_till', '<=', soon)]),
          eb.and([eb('next_charge_at', 'is not', null), eb('next_charge_at', '<=', now)]),
        ]),
      )
      .execute() as Promise<
      Array<{
        account_id: string;
        users: number | null;
        months: number | null;
        paid_till: Date | null;
        dunning_attempts: number;
        yk_payment_method_id: string;
      }>
    >;
  }

  // --- Счета (трек оплаты по счёту) ---

  async createInvoice(inv: {
    accountId: string;
    number: string;
    amount: number | null;
    periodMonths: number | null;
    users: number | null;
    vendorDealId: string | null;
  }): Promise<void> {
    requireAccountId(inv.accountId);
    await this.db
      .insertInto('invoices')
      .values({
        account_id: inv.accountId,
        number: inv.number,
        amount: inv.amount,
        period_months: inv.periodMonths,
        users: inv.users,
        vendor_deal_id: inv.vendorDealId,
      })
      .execute();
  }

  findInvoiceByNumber(number: string): Promise<InvoiceRow | undefined> {
    return this.db.selectFrom('invoices').selectAll().where('number', '=', number).executeTakeFirst();
  }

  findInvoiceByDeal(vendorDealId: string): Promise<InvoiceRow | undefined> {
    return this.db
      .selectFrom('invoices')
      .selectAll()
      .where('vendor_deal_id', '=', vendorDealId)
      .orderBy('issued_at', 'desc')
      .executeTakeFirst();
  }

  async updateInvoice(
    id: string,
    patch: Partial<{ status: InvoiceStatus; paid_at: Date | null; vendor_deal_id: string | null }>,
  ): Promise<void> {
    await this.db.updateTable('invoices').set(patch).where('id', '=', id).execute();
  }

  listInvoices(accountId: string, limit = 50): Promise<InvoiceRow[]> {
    requireAccountId(accountId);
    return this.db
      .selectFrom('invoices')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('issued_at', 'desc')
      .limit(limit)
      .execute();
  }

  /** Есть ли уже платёж с таким payment_id (идемпотентность вебхуков ЮKassa). */
  async paymentExists(paymentId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('payments')
      .select('id')
      .where('payment_id', '=', paymentId)
      .executeTakeFirst();
    return Boolean(row);
  }

  async insertPayment(p: {
    accountId: string;
    amount: number | null;
    users: number | null;
    months: number | null;
    source: PaymentSource;
    paymentId: string | null;
    reason: string | null;
    actor: string | null;
    paidTill: Date | null;
  }): Promise<void> {
    requireAccountId(p.accountId);
    await this.db
      .insertInto('payments')
      .values({
        account_id: p.accountId,
        amount: p.amount,
        users: p.users,
        months: p.months,
        source: p.source,
        payment_id: p.paymentId,
        reason: p.reason,
        actor: p.actor,
        paid_till: p.paidTill,
      })
      .execute();
  }

  /**
   * Подписки, которым пора напомнить об истечении: paid_till в окне (now, now+leadDays] и
   * в этом предыстечном окне ещё не напоминали (notified_at пуст или раньше paid_till−leadDays).
   */
  async dueForReminder(
    now: Date,
    leadDays: number,
  ): Promise<Array<{ account_id: string; subdomain: string; payment_method: PaymentMethodType; paid_till: Date }>> {
    const until = new Date(now.getTime() + leadDays * 86400_000);
    return this.db
      .selectFrom('subscriptions as s')
      .innerJoin('accounts as a', 'a.account_id', 's.account_id')
      .select([
        's.account_id as account_id',
        'a.subdomain as subdomain',
        's.payment_method as payment_method',
        's.paid_till as paid_till',
      ])
      .where('s.status', 'in', ['active', 'awaiting_invoice_payment'])
      .where('s.paid_till', 'is not', null)
      .where('s.paid_till', '>', now)
      .where('s.paid_till', '<=', until)
      .where((eb) =>
        eb.or([
          eb('s.notified_at', 'is', null),
          eb('s.notified_at', '<', sql<Date>`s.paid_till - make_interval(days => ${leadDays})`),
        ]),
      )
      .execute() as Promise<
      Array<{ account_id: string; subdomain: string; payment_method: PaymentMethodType; paid_till: Date }>
    >;
  }

  async setNotified(accountId: string, at: Date): Promise<void> {
    requireAccountId(accountId);
    await this.db.updateTable('subscriptions').set({ notified_at: at }).where('account_id', '=', accountId).execute();
  }

  /** Просроченные (paid_till/grace/trial в прошлом) → past_due. Возвращает число помеченных. */
  async markOverdue(now: Date): Promise<number> {
    const res = await this.db
      .updateTable('subscriptions')
      .set({ status: 'past_due', updated_at: now })
      .where('status', 'in', ['trial', 'active', 'awaiting_invoice_payment'])
      .where((eb) => eb.or([eb('paid_till', 'is', null), eb('paid_till', '<', now)]))
      .where((eb) => eb.or([eb('grace_until', 'is', null), eb('grace_until', '<', now)]))
      .where((eb) => eb.or([eb('trial_ends_at', 'is', null), eb('trial_ends_at', '<', now)]))
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  }

  listPayments(accountId: string, limit = 50): Promise<PaymentRow[]> {
    requireAccountId(accountId);
    return this.db
      .selectFrom('payments')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
  }

  /** Листинг клиентов: все аккаунты LEFT JOIN подписки + сумма последнего платежа. */
  list(f: ListFilter): Promise<SubscriptionListRow[]> {
    let q = this.db
      .selectFrom('accounts as a')
      .leftJoin('subscriptions as s', 's.account_id', 'a.account_id')
      .select((eb) => [
        'a.account_id as account_id',
        'a.subdomain as subdomain',
        'a.installed_at as installed_at',
        's.status as status',
        's.users as users',
        's.months as months',
        's.paid_till as paid_till',
        's.trial_ends_at as trial_ends_at',
        's.grace_until as grace_until',
        's.payment_method as payment_method',
        eb
          .selectFrom('payments as p')
          .select('p.amount')
          .whereRef('p.account_id', '=', 'a.account_id')
          .orderBy('p.created_at', 'desc')
          .limit(1)
          .as('last_amount'),
      ]);

    if (f.query) q = q.where('a.subdomain', 'ilike', `%${f.query}%`);
    if (f.status) q = q.where('s.status', '=', f.status);
    if (f.expiringInDays != null) {
      const until = new Date(f.now.getTime() + f.expiringInDays * 86400_000);
      q = q.where('s.paid_till', '<=', until).where('s.paid_till', '>', f.now);
    }
    return q
      .orderBy('s.paid_till', 'asc')
      .limit(f.limit)
      .offset(f.offset)
      .execute() as Promise<SubscriptionListRow[]>;
  }
}
