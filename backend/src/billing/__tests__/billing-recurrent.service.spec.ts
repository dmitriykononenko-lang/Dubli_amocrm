import { BillingRecurrentService } from '../billing-recurrent.service';
import type { SubscriptionsService } from '../subscriptions.service';
import type { SubscriptionsRepository } from '../subscriptions.repository';
import type { YookassaClient } from '../yookassa.client';
import type { AppConfigService } from '../../config/app-config.service';

type DueCard = Awaited<ReturnType<SubscriptionsRepository['dueForCharge']>>[number];

function make(due: DueCard[], paymentStatus = 'succeeded', ykEnabled = true) {
  const subs = { recordPayment: jest.fn().mockResolvedValue({ paidTill: 'x', duplicate: false }) } as unknown as SubscriptionsService;
  const repo = {
    dueForCharge: jest.fn().mockResolvedValue(due),
    update: jest.fn().mockResolvedValue(undefined),
  } as unknown as SubscriptionsRepository;
  const yookassa = {
    enabled: ykEnabled,
    chargeSaved: jest.fn().mockResolvedValue({ id: 'rp_1', status: paymentStatus }),
  } as unknown as YookassaClient;
  const config = {
    billingRenewLeadDays: 3,
    billingPricePerUser: 399,
    billingMinUsers: 5,
    billingDunningRetries: [1, 3, 5],
  } as unknown as AppConfigService;
  return { svc: new BillingRecurrentService(subs, repo, yookassa, config), subs, repo, yookassa };
}

const card = (over: Partial<DueCard> = {}): DueCard =>
  ({ account_id: '1', users: 5, months: 12, paid_till: new Date(), dunning_attempts: 0, yk_payment_method_id: 'pm_1', ...over }) as DueCard;

describe('BillingRecurrentService.chargeDueCards', () => {
  it('успешное списание → recordPayment (source yookassa)', async () => {
    const { svc, subs, yookassa } = make([card()]);
    const res = await svc.chargeDueCards();
    expect(yookassa.chargeSaved).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethodId: 'pm_1', idempotenceKey: expect.stringMatching(/^recur:1:/) }),
    );
    expect(subs.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'yookassa', paymentId: 'rp_1', months: 12 }),
    );
    expect(res.charged).toBe(1);
  });

  it('неудача списания → dunning: past_due + следующий ретрай', async () => {
    const { svc, subs, repo } = make([card({ dunning_attempts: 0 })], 'canceled');
    const res = await svc.chargeDueCards();
    expect(subs.recordPayment).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ status: 'past_due', dunning_attempts: 1, next_charge_at: expect.any(Date), grace_until: expect.any(Date) }),
    );
    expect(res.failed).toBe(1);
  });

  it('исчерпаны ретраи → canceled + auto_renew off', async () => {
    const { svc, repo } = make([card({ dunning_attempts: 3 })], 'canceled'); // retries=[1,3,5] → attempt 4 > 3
    const res = await svc.chargeDueCards();
    expect(repo.update).toHaveBeenCalledWith('1', expect.objectContaining({ status: 'canceled', auto_renew: false }));
    expect(res.canceled).toBe(1);
  });

  it('исключение при списании → тоже dunning (не роняет цикл)', async () => {
    const { svc, repo, yookassa } = make([card()]);
    (yookassa.chargeSaved as jest.Mock).mockRejectedValue(new Error('yk 500'));
    const res = await svc.chargeDueCards();
    expect(repo.update).toHaveBeenCalledWith('1', expect.objectContaining({ status: 'past_due' }));
    expect(res.failed).toBe(1);
  });

  it('ЮKassa выключена → ничего не делает', async () => {
    const { svc, yookassa } = make([card()], 'succeeded', false);
    const res = await svc.chargeDueCards();
    expect(yookassa.chargeSaved).not.toHaveBeenCalled();
    expect(res).toEqual({ charged: 0, failed: 0, canceled: 0 });
  });
});
