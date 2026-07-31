import { SubscriptionsService } from '../subscriptions.service';
import type { SubscriptionsRepository, SubscriptionRow } from '../subscriptions.repository';
import type { AccountsService } from '../../accounts/accounts.service';
import type { AppConfigService } from '../../config/app-config.service';

const DAY = 86400_000;
const iso = (d: Date) => d.toISOString();

function make(row: Partial<SubscriptionRow> | null, opts: { paymentExists?: boolean } = {}) {
  const found: SubscriptionRow | undefined = row
    ? ({ account_id: '1', status: 'trial', users: null, months: null, paid_till: null, trial_ends_at: null, created_at: new Date(), updated_at: new Date(), ...row } as SubscriptionRow)
    : undefined;
  const repo = {
    find: jest.fn().mockResolvedValue(found),
    ensure: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    paymentExists: jest.fn().mockResolvedValue(Boolean(opts.paymentExists)),
    insertPayment: jest.fn().mockResolvedValue(undefined),
    listPayments: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue([]),
  } as unknown as SubscriptionsRepository;
  const accounts = {
    findById: jest.fn().mockResolvedValue({ account_id: '1', subdomain: 'clientco', installed_at: new Date() }),
    getSettings: jest.fn().mockResolvedValue({}),
    findBySubdomain: jest.fn().mockResolvedValue({ account_id: '1' }),
  } as unknown as AccountsService;
  const config = { billingTrialDays: 7 } as unknown as AppConfigService;
  return { svc: new SubscriptionsService(repo, accounts, config), repo };
}

describe('SubscriptionsService.recordPayment', () => {
  it('продлевает от текущей даты, если подписка активна (paid_till в будущем)', async () => {
    const future = new Date(Date.now() + 10 * DAY);
    const { svc, repo } = make({ status: 'active', paid_till: future });
    const res = await svc.recordPayment({ accountId: '1', months: 6, source: 'yookassa', paymentId: 'p1', amount: 11970 });
    expect(res.duplicate).toBe(false);
    const patch = (repo.update as jest.Mock).mock.calls[0][1];
    // база = future → +6 мес позже, чем future
    expect(new Date(patch.paid_till).getTime()).toBeGreaterThan(future.getTime());
    expect(patch.status).toBe('active');
    expect(repo.insertPayment).toHaveBeenCalledWith(expect.objectContaining({ source: 'yookassa', paymentId: 'p1' }));
  });

  it('продлевает от now, если подписка истекла', async () => {
    const past = new Date(Date.now() - 10 * DAY);
    const { svc, repo } = make({ status: 'past_due', paid_till: past });
    await svc.recordPayment({ accountId: '1', months: 6, source: 'yookassa', paymentId: 'p2' });
    const patch = (repo.update as jest.Mock).mock.calls[0][1];
    // база = now (не past) → paid_till в будущем, примерно now+6мес
    expect(new Date(patch.paid_till).getTime()).toBeGreaterThan(Date.now() + 150 * DAY);
  });

  it('идемпотентно: повторный payment_id не продлевает второй раз', async () => {
    const future = new Date(Date.now() + 10 * DAY);
    const { svc, repo } = make({ status: 'active', paid_till: future }, { paymentExists: true });
    const res = await svc.recordPayment({ accountId: '1', months: 6, source: 'yookassa', paymentId: 'dup' });
    expect(res.duplicate).toBe(true);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.insertPayment).not.toHaveBeenCalled();
  });
});

describe('SubscriptionsService.extend (вендор)', () => {
  it('устанавливает точную дату paid_till', async () => {
    const { svc, repo } = make({ status: 'past_due', paid_till: null });
    await svc.extend('1', { paidTill: '2027-12-31T23:59:59.000Z', reason: 'промо' });
    const patch = (repo.update as jest.Mock).mock.calls[0][1];
    expect(iso(new Date(patch.paid_till))).toBe('2027-12-31T23:59:59.000Z');
    expect(patch.status).toBe('active');
    expect(repo.insertPayment).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual', reason: 'промо' }));
  });

  it('сдвигает на add_months от текущей даты', async () => {
    const future = new Date(Date.now() + 5 * DAY);
    const { svc, repo } = make({ status: 'active', paid_till: future });
    await svc.extend('1', { addMonths: 3 });
    const patch = (repo.update as jest.Mock).mock.calls[0][1];
    expect(new Date(patch.paid_till).getTime()).toBeGreaterThan(future.getTime());
  });

  it('без paid_till и add_months → ошибка', async () => {
    const { svc } = make({ status: 'active', paid_till: null });
    await expect(svc.extend('1', {})).rejects.toThrow();
  });
});

describe('SubscriptionsService.suspend/resume', () => {
  it('suspend закрывает доступ (status=canceled)', async () => {
    const future = new Date(Date.now() + 10 * DAY);
    const { svc, repo } = make({ status: 'active', paid_till: future });
    await svc.suspend('1', { reason: 'неоплата' });
    expect(repo.update).toHaveBeenCalledWith('1', expect.objectContaining({ status: 'canceled' }));
    expect(repo.insertPayment).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual' }));
  });

  it('resume → active, если paid_till в будущем', async () => {
    const future = new Date(Date.now() + 10 * DAY);
    const { svc, repo } = make({ status: 'canceled', paid_till: future });
    const res = await svc.resume('1', {});
    expect(res.status).toBe('active');
    expect(repo.update).toHaveBeenCalledWith('1', { status: 'active' });
  });

  it('resume → past_due, если paid_till в прошлом', async () => {
    const past = new Date(Date.now() - 10 * DAY);
    const { svc } = make({ status: 'canceled', paid_till: past });
    const res = await svc.resume('1', {});
    expect(res.status).toBe('past_due');
  });
});

describe('SubscriptionsService.access (гейтинг)', () => {
  it('оплачено (paid_till в будущем) → доступ есть', async () => {
    const { svc } = make({ status: 'active', paid_till: new Date(Date.now() + DAY) });
    expect((await svc.access('1')).allowed).toBe(true);
  });

  it('триал ещё идёт → доступ есть', async () => {
    const { svc } = make({ status: 'trial', paid_till: null, trial_ends_at: new Date(Date.now() + DAY) });
    expect((await svc.access('1')).allowed).toBe(true);
  });

  it('всё в прошлом → доступа нет (демо)', async () => {
    const past = new Date(Date.now() - DAY);
    const { svc } = make({ status: 'past_due', paid_till: past, trial_ends_at: past });
    expect((await svc.access('1')).allowed).toBe(false);
  });

  it('приостановлен → доступа нет, даже если paid_till в будущем', async () => {
    const { svc } = make({ status: 'canceled', paid_till: new Date(Date.now() + 100 * DAY) });
    expect((await svc.access('1')).allowed).toBe(false);
  });
});
