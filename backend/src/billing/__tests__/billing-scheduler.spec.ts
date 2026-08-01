import { BillingScheduler } from '../billing-scheduler';
import type { SubscriptionsService } from '../subscriptions.service';
import type { BillingNotifier } from '../billing-notifier';
import type { AppConfigService } from '../../config/app-config.service';

type Due = Awaited<ReturnType<SubscriptionsService['listDueReminders']>>;

function make(due: Due = [], overdue = 0) {
  const subs = {
    markOverdue: jest.fn().mockResolvedValue(overdue),
    listDueReminders: jest.fn().mockResolvedValue(due),
    markNotified: jest.fn().mockResolvedValue(undefined),
  } as unknown as SubscriptionsService;
  const notifier = { send: jest.fn().mockResolvedValue(undefined) } as unknown as BillingNotifier;
  const config = { nodeEnv: 'test' } as unknown as AppConfigService;
  return { sched: new BillingScheduler(subs, notifier, config), subs, notifier };
}

describe('BillingScheduler.tick', () => {
  it('помечает past_due и шлёт напоминания (карта/счёт) + markNotified', async () => {
    const due: Due = [
      { accountId: '1', subdomain: 'a', paymentMethod: 'card', paidTill: '2026-09-01T00:00:00.000Z', daysLeft: 5 },
      { accountId: '2', subdomain: 'b', paymentMethod: 'invoice', paidTill: '2026-09-02T00:00:00.000Z', daysLeft: 3 },
    ];
    const { sched, subs, notifier } = make(due, 2);
    await sched.tick();
    expect(subs.markOverdue).toHaveBeenCalled();
    expect(notifier.send).toHaveBeenCalledTimes(2);
    expect((notifier.send as jest.Mock).mock.calls[0][0]).toContain('автоматически');
    expect((notifier.send as jest.Mock).mock.calls[1][0]).toContain('счёт');
    expect(subs.markNotified).toHaveBeenCalledWith('1');
    expect(subs.markNotified).toHaveBeenCalledWith('2');
  });

  it('нет истекающих → уведомления не шлём', async () => {
    const { sched, notifier } = make([], 0);
    await sched.tick();
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it('не перекрывает параллельные запуски (busy)', async () => {
    const { sched, subs } = make([], 0);
    (subs.markOverdue as jest.Mock).mockImplementation(
      () => new Promise((r) => setTimeout(() => r(0), 20)),
    );
    await Promise.all([sched.tick(), sched.tick()]); // второй должен выйти сразу
    expect(subs.markOverdue).toHaveBeenCalledTimes(1);
  });
});
