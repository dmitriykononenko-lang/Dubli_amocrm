import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, type Selectable } from 'kysely';
import { KYSELY } from '../common/db/kysely.tokens';
import { requireAccountId } from '../common/db/account-scope';
import type {
  DB,
  PaymentSource,
  PaymentsTable,
  SubscriptionStatus,
  SubscriptionsTable,
} from '../common/db/database.types';

export type SubscriptionRow = Selectable<SubscriptionsTable>;
export type PaymentRow = Selectable<PaymentsTable>;

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
    }>,
  ): Promise<void> {
    requireAccountId(accountId);
    await this.db
      .updateTable('subscriptions')
      .set({ ...patch, updated_at: new Date() })
      .where('account_id', '=', accountId)
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
