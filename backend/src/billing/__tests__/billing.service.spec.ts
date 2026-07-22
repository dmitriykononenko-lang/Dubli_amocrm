import { ServiceUnavailableException } from '@nestjs/common';
import { BillingService } from '../billing.service';
import type { AppConfigService } from '../../config/app-config.service';
import type { AmocrmService } from '../../amocrm/amocrm.service';
import type { AccountsService } from '../../accounts/accounts.service';

function make(
  configOverrides: Partial<Record<string, unknown>> = {},
  settings: Record<string, unknown> = {},
) {
  const config = {
    billingPricePerUser: 399,
    billingMinUsers: 5,
    vendorAmocrmAccountId: '900',
    vendorAmocrmSubdomain: undefined,
    vendorAmocrmPipelineId: undefined,
    vendorAmocrmStatusInstalled: undefined,
    vendorAmocrmStatusRequested: undefined,
    vendorAmocrmStatusPaid: undefined,
    yookassaShopId: undefined,
    yookassaSecretKey: undefined,
    ...configOverrides,
  } as unknown as AppConfigService;
  const amocrm = {
    create: jest.fn().mockResolvedValue('55501'),
    update: jest.fn().mockResolvedValue(undefined),
    addNote: jest.fn().mockResolvedValue(undefined),
    createTask: jest.fn().mockResolvedValue(undefined),
  } as unknown as AmocrmService;
  const accounts = {
    getSettings: jest.fn().mockResolvedValue({ ...settings }),
    updateSettings: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({ subdomain: 'clientco' }),
    findBySubdomain: jest.fn(),
  } as unknown as AccountsService;
  return { svc: new BillingService(config, amocrm, accounts), amocrm, accounts };
}

describe('BillingService — установка клиента', () => {
  it('создаёт сделку, сохраняет vendor_lead_id и пишет примечание', async () => {
    const { svc, amocrm, accounts } = make();
    await svc.onClientInstalled('778');
    expect(amocrm.create).toHaveBeenCalledWith(
      '900',
      'lead',
      expect.objectContaining({ name: 'Дубли: clientco' }),
    );
    expect(accounts.updateSettings).toHaveBeenCalledWith(
      '778',
      expect.objectContaining({ vendor_lead_id: '55501' }),
    );
    expect(amocrm.addNote).toHaveBeenCalledWith('900', 'lead', '55501', expect.stringContaining('установил'));
  });

  it('не создаёт вторую сделку, если vendor_lead_id уже есть', async () => {
    const { svc, amocrm } = make({}, { vendor_lead_id: '999' });
    await svc.onClientInstalled('778');
    expect(amocrm.create).not.toHaveBeenCalled();
  });

  it('не роняет установку при ошибке amoCRM', async () => {
    const { svc, amocrm } = make();
    (amocrm.create as jest.Mock).mockRejectedValue(new Error('amo down'));
    await expect(svc.onClientInstalled('778')).resolves.toBeUndefined();
  });
});

describe('BillingService.requestInvoice', () => {
  it('двигает существующую сделку на этап, пишет сумму и ставит задачу', async () => {
    const { svc, amocrm } = make({ vendorAmocrmStatusRequested: 222 }, { vendor_lead_id: '55501' });
    const res = await svc.requestInvoice('778', 8, 12);
    expect(res).toEqual({ ok: true, leadId: '55501', sum: 399 * 8 * 10 });
    expect(amocrm.create).not.toHaveBeenCalled();
    expect(amocrm.update).toHaveBeenCalledWith(
      '900',
      'lead',
      '55501',
      expect.objectContaining({ price: 399 * 8 * 10, status_id: 222 }),
    );
    expect(amocrm.addNote).toHaveBeenCalledWith('900', 'lead', '55501', expect.stringContaining('Запросил счёт'));
    expect(amocrm.createTask).toHaveBeenCalledWith(
      '900',
      expect.objectContaining({ entityId: '55501', entityType: 'lead' }),
    );
  });

  it('заводит сделку, если запрос счёта пришёл раньше факта установки', async () => {
    const { svc, amocrm } = make();
    await svc.requestInvoice('778', 5, 6);
    expect(amocrm.create).toHaveBeenCalled();
    expect(amocrm.update).toHaveBeenCalled();
  });

  it('резолвит vendor по субдомену, если account_id не задан', async () => {
    const { svc, amocrm, accounts } = make(
      { vendorAmocrmAccountId: undefined, vendorAmocrmSubdomain: 'koagency.amocrm.ru' },
      { vendor_lead_id: '55501' },
    );
    (accounts.findBySubdomain as jest.Mock).mockResolvedValue({ account_id: '900' });
    await svc.requestInvoice('778', 5, 6);
    expect(accounts.findBySubdomain).toHaveBeenCalledWith('koagency.amocrm.ru');
    expect(amocrm.update).toHaveBeenCalledWith('900', 'lead', '55501', expect.any(Object));
  });

  it('503, если vendor-аккаунт не настроен', async () => {
    const { svc } = make({ vendorAmocrmAccountId: undefined, vendorAmocrmSubdomain: undefined });
    await expect(svc.requestInvoice('778', 5, 6)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('BillingService.createCheckout', () => {
  it('503, пока ЮKassa не настроена', async () => {
    const { svc } = make();
    await expect(svc.createCheckout('778', 5, 6)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
