import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BillingService } from '../billing.service';
import type { AppConfigService } from '../../config/app-config.service';
import type { AmocrmService } from '../../amocrm/amocrm.service';
import type { AccountsService } from '../../accounts/accounts.service';
import type { YookassaClient } from '../yookassa.client';

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
    yookassaFiscal: false,
    yookassaVatCode: 1,
    billingReturnUrl: undefined,
    ...configOverrides,
  } as unknown as AppConfigService;
  const amocrm = {
    create: jest.fn().mockResolvedValue('55501'),
    update: jest.fn().mockResolvedValue(undefined),
    addNote: jest.fn().mockResolvedValue(undefined),
    createTask: jest.fn().mockResolvedValue(undefined),
    getPipelineStatuses: jest.fn().mockResolvedValue([]),
  } as unknown as AmocrmService;
  const accounts = {
    getSettings: jest.fn().mockResolvedValue({ ...settings }),
    updateSettings: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({ subdomain: 'clientco' }),
    findBySubdomain: jest.fn(),
  } as unknown as AccountsService;
  const ykEnabled = Boolean(configOverrides.yookassaShopId && configOverrides.yookassaSecretKey);
  const yookassa = {
    enabled: ykEnabled,
    createPayment: jest.fn().mockResolvedValue({
      id: 'pay_1',
      status: 'pending',
      confirmation: { confirmation_url: 'https://yookassa.ru/checkout/pay_1' },
    }),
    getPayment: jest.fn(),
  } as unknown as YookassaClient;
  return { svc: new BillingService(config, amocrm, accounts, yookassa), amocrm, accounts, yookassa };
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

  it('с долгосрочным токеном работает через vendor-ключ (без БД/установки)', async () => {
    const { svc, amocrm } = make({
      vendorAmocrmToken: 'longlived',
      vendorAmocrmSubdomain: 'koagency.amocrm.ru',
    });
    await svc.onClientInstalled('778');
    expect(amocrm.create).toHaveBeenCalledWith('vendor', 'lead', expect.any(Object));
  });
});

describe('BillingService.requestInvoice', () => {
  it('двигает существующую сделку на этап, пишет сумму и ставит задачу', async () => {
    const { svc, amocrm } = make(
      { vendorAmocrmPipelineId: 11130042, vendorAmocrmStatusRequested: 222 },
      { vendor_lead_id: '55501' },
    );
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

  it('кладёт телефон/email клиента в примечание и задачу', async () => {
    const { svc, amocrm } = make({ vendorAmocrmPipelineId: 11130042 }, { vendor_lead_id: '55501' });
    await svc.requestInvoice('778', 5, 6, { phone: '+79990001122', email: 'c@x.ru' });
    const note = (amocrm.addNote as jest.Mock).mock.calls.find((c) => /Запросил счёт/.test(c[3]));
    expect(note[3]).toContain('+79990001122');
    expect(note[3]).toContain('c@x.ru');
    expect((amocrm.createTask as jest.Mock).mock.calls[0][1].text).toContain('+79990001122');
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

describe('BillingService — этапы воронки по названию', () => {
  const STAGES = [
    { id: 101, name: 'ВИДЖЕТ УСТАНОВАЛЕН' },
    { id: 102, name: 'КВАЛИФИЦИРОВАН' },
    { id: 103, name: 'ЗАПРОШЕН СЧЕТ' },
    { id: 104, name: 'ОПЛАЧЕН' },
  ];

  it('установка кладёт сделку на этап «установлен» (по названию, нужен только pipeline_id)', async () => {
    const { svc, amocrm } = make({ vendorAmocrmPipelineId: 11130042 });
    (amocrm.getPipelineStatuses as jest.Mock).mockResolvedValue(STAGES);
    await svc.onClientInstalled('778');
    expect(amocrm.create).toHaveBeenCalledWith(
      '900',
      'lead',
      expect.objectContaining({ pipeline_id: 11130042, status_id: 101 }),
    );
  });

  it('запрос счёта двигает сделку на этап «Запрошен счёт» (id 103)', async () => {
    const { svc, amocrm } = make({ vendorAmocrmPipelineId: 11130042 }, { vendor_lead_id: '55501' });
    (amocrm.getPipelineStatuses as jest.Mock).mockResolvedValue(STAGES);
    await svc.requestInvoice('778', 5, 6);
    expect(amocrm.update).toHaveBeenCalledWith(
      '900',
      'lead',
      '55501',
      expect.objectContaining({ status_id: 103 }),
    );
  });

  it('явные ID из .env имеют приоритет над названиями', async () => {
    const { svc, amocrm } = make(
      { vendorAmocrmPipelineId: 11130042, vendorAmocrmStatusRequested: 777 },
      { vendor_lead_id: '55501' },
    );
    (amocrm.getPipelineStatuses as jest.Mock).mockResolvedValue(STAGES);
    await svc.requestInvoice('778', 5, 6);
    expect(amocrm.getPipelineStatuses).not.toHaveBeenCalled();
    expect(amocrm.update).toHaveBeenCalledWith(
      '900',
      'lead',
      '55501',
      expect.objectContaining({ status_id: 777 }),
    );
  });
});

describe('BillingService.createCheckout', () => {
  it('503, пока ЮKassa не настроена', async () => {
    const { svc } = make();
    await expect(svc.createCheckout('778', 5, 6)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('создаёт платёж ЮKassa и возвращает ссылку на оплату (без фискализации)', async () => {
    const { svc, yookassa } = make({ yookassaShopId: 's', yookassaSecretKey: 'k' });
    const res = await svc.createCheckout('778', 5, 6);
    expect(res).toEqual({ confirmation_url: 'https://yookassa.ru/checkout/pay_1', sum: 11970 });
    expect(yookassa.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 11970,
        metadata: expect.objectContaining({ accountId: '778', months: 6 }),
      }),
    );
  });

  it('с фискализацией добавляет чек (receipt) с email и суммой позиции = сумме', async () => {
    const { svc, yookassa } = make({
      yookassaShopId: 's',
      yookassaSecretKey: 'k',
      yookassaFiscal: true,
      yookassaVatCode: 1,
    });
    await svc.createCheckout('778', 5, 6, 'buyer@example.com');
    const arg = (yookassa.createPayment as jest.Mock).mock.calls[0][0];
    expect(arg.receipt.customer.email).toBe('buyer@example.com');
    expect(arg.receipt.items[0].amount).toEqual({ value: '11970.00', currency: 'RUB' });
    expect(arg.receipt.items[0].vat_code).toBe(1);
  });

  it('с фискализацией без email → 400 (нужен email для чека)', async () => {
    const { svc } = make({ yookassaShopId: 's', yookassaSecretKey: 'k', yookassaFiscal: true });
    await expect(svc.createCheckout('778', 5, 6)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('BillingService.handlePaymentNotification', () => {
  it('успешный платёж → продлевает подписку и двигает сделку на «Оплачен»', async () => {
    const { svc, amocrm, accounts, yookassa } = make(
      { yookassaShopId: 's', yookassaSecretKey: 'k', vendorAmocrmPipelineId: 11130042 },
      { vendor_lead_id: '55501' },
    );
    (yookassa.getPayment as jest.Mock).mockResolvedValue({
      id: 'pay_1',
      status: 'succeeded',
      metadata: { accountId: '778', months: 6 },
    });
    (amocrm.getPipelineStatuses as jest.Mock).mockResolvedValue([{ id: 104, name: 'ОПЛАЧЕН' }]);
    await svc.handlePaymentNotification('pay_1');
    expect(accounts.updateSettings).toHaveBeenCalledWith(
      '778',
      expect.objectContaining({ paid_until: expect.any(String) }),
    );
    expect(amocrm.update).toHaveBeenCalledWith('900', 'lead', '55501', { status_id: 104 });
    expect(amocrm.addNote).toHaveBeenCalledWith('900', 'lead', '55501', expect.stringContaining('Оплата'));
  });

  it('неуспешный платёж → ничего не меняет', async () => {
    const { svc, accounts, yookassa } = make({ yookassaShopId: 's', yookassaSecretKey: 'k' });
    (yookassa.getPayment as jest.Mock).mockResolvedValue({ id: 'pay_1', status: 'pending', metadata: { accountId: '778' } });
    await svc.handlePaymentNotification('pay_1');
    expect(accounts.updateSettings).not.toHaveBeenCalled();
  });
});
