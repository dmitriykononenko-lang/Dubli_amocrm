import { BankReconcileService } from '../bank-reconcile.service';
import type { SubscriptionsService } from '../subscriptions.service';
import type { AppConfigService } from '../../config/app-config.service';

function make(enabled = true) {
  const subs = {
    markInvoicePaid: jest.fn().mockResolvedValue({ ok: true, paidTill: 'x', alreadyPaid: false }),
  } as unknown as SubscriptionsService;
  const config = { billingBankReconcile: enabled } as unknown as AppConfigService;
  return { svc: new BankReconcileService(subs, config), subs };
}

describe('BankReconcileService', () => {
  it('extractNumber находит номер счёта в назначении', () => {
    const { svc } = make();
    expect(svc.extractNumber('Оплата по счёту DUB-33022710-ABC1 за виджет')).toBe('DUB-33022710-ABC1');
    expect(svc.extractNumber('перевод без номера')).toBeNull();
  });

  it('матчит по номеру → markInvoicePaid', async () => {
    const { svc, subs } = make();
    const res = await svc.reconcile([{ purpose: 'DUB-1-AA оплата', amount: 11970 }]);
    expect(subs.markInvoicePaid).toHaveBeenCalledWith('DUB-1-AA', { actor: 'bank-reconcile' });
    expect(res.matched).toEqual(['DUB-1-AA']);
    expect(res.unmatched).toEqual([]);
  });

  it('без номера → в ручной разбор (unmatched)', async () => {
    const { svc, subs } = make();
    const res = await svc.reconcile([{ purpose: 'просто перевод', amount: 100 }]);
    expect(subs.markInvoicePaid).not.toHaveBeenCalled();
    expect(res.matched).toEqual([]);
    expect(res.unmatched).toHaveLength(1);
  });

  it('неизвестный счёт (mark-paid бросает) → unmatched, цикл не падает', async () => {
    const { svc, subs } = make();
    (subs.markInvoicePaid as jest.Mock).mockRejectedValue(new Error('Счёт не найден'));
    const res = await svc.reconcile([{ purpose: 'DUB-9-ZZ' }, { purpose: 'мусор' }]);
    expect(res.matched).toEqual([]);
    expect(res.unmatched).toHaveLength(2);
  });
});
