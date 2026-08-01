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
    getById: jest.fn().mockResolvedValue({ id: 55501 }),
    getAccountName: jest.fn().mockResolvedValue(null),
    search: jest.fn().mockResolvedValue([]),
    link: jest.fn().mockResolvedValue(undefined),
  } as unknown as AmocrmService;
  const accounts = {
    getSettings: jest.fn().mockResolvedValue({ ...settings }),
    updateSettings: jest.fn().mockResolvedValue(undefined),
    findById: jest.fn().mockResolvedValue({ subdomain: 'clientco' }),
    findBySubdomain: jest.fn(),
    listAll: jest.fn().mockResolvedValue([]),
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
  const subscriptions = {
    ensure: jest.fn().mockResolvedValue({ status: 'trial', paid_till: null }),
    recordPayment: jest.fn().mockResolvedValue({ paidTill: '2027-01-01T00:00:00.000Z', duplicate: false }),
    issueInvoice: jest.fn().mockResolvedValue({ number: 'DUB-778-TEST' }),
    markInvoicePaid: jest.fn().mockResolvedValue({ ok: true, paidTill: '2027-01-01T00:00:00.000Z', alreadyPaid: false }),
  } as unknown as import('../subscriptions.service').SubscriptionsService;
  return {
    svc: new BillingService(config, amocrm, accounts, yookassa, subscriptions),
    amocrm,
    accounts,
    yookassa,
    subscriptions,
  };
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

  const leadCreates = (amocrm: AmocrmService) =>
    (amocrm.create as jest.Mock).mock.calls.filter((c) => c[1] === 'lead');

  it('не создаёт вторую СДЕЛКУ, если vendor_lead_id есть и сделка существует', async () => {
    const { svc, amocrm } = make({}, { vendor_lead_id: '999', vendor_company_id: '5' });
    await svc.onClientInstalled('778');
    expect(leadCreates(amocrm).length).toBe(0);
  });

  it('оживление: если сделка по vendor_lead_id удалена (404) — создаёт заново', async () => {
    const { svc, amocrm } = make({}, { vendor_lead_id: '999', vendor_company_id: '5' });
    (amocrm.getById as jest.Mock).mockImplementation((_v: string, type: string) =>
      type === 'lead' ? Promise.reject(new Error('amoCRM API 404: not found')) : Promise.resolve({ id: 5 }),
    );
    await svc.onClientInstalled('778');
    expect(leadCreates(amocrm).length).toBe(1);
  });

  it('транзиентная ошибка проверки сделки — НЕ пересоздаёт сделку (без дублей)', async () => {
    const { svc, amocrm } = make({}, { vendor_lead_id: '999', vendor_company_id: '5' });
    (amocrm.getById as jest.Mock).mockRejectedValue(new Error('amoCRM API 500'));
    await svc.onClientInstalled('778');
    expect(leadCreates(amocrm).length).toBe(0);
  });

  it('кастом-поле «ID аккаунта» ставится на КОМПАНИЮ (число), а не на сделку', async () => {
    const { svc, amocrm } = make({ vendorAmocrmAccountFieldId: 1173679 });
    await svc.onClientInstalled('778');
    const companyCall = (amocrm.create as jest.Mock).mock.calls.find((c) => c[1] === 'company');
    expect(companyCall).toBeTruthy();
    expect(companyCall[2].custom_fields_values).toEqual([
      { field_id: 1173679, values: [{ value: 778 }] },
    ]);
    expect(leadCreates(amocrm)[0][2].custom_fields_values).toBeUndefined();
    expect(amocrm.link).toHaveBeenCalledWith(
      expect.anything(),
      'lead',
      '55501',
      [{ to_entity_id: 55501, to_entity_type: 'companies' }],
    );
  });

  it('находит существующую компанию по ID аккаунта и прикрепляет её (без создания новой)', async () => {
    const { svc, amocrm } = make({ vendorAmocrmAccountFieldId: 1173679 });
    (amocrm.search as jest.Mock).mockImplementation((_v: string, type: string) =>
      type === 'company'
        ? Promise.resolve([
            { id: 6001, custom_fields_values: [{ field_id: 1173679, values: [{ value: 778 }] }] },
          ])
        : Promise.resolve([]),
    );
    await svc.onClientInstalled('778');
    const companyCreate = (amocrm.create as jest.Mock).mock.calls.find((c) => c[1] === 'company');
    expect(companyCreate).toBeUndefined(); // нашли существующую — новую не создаём
    expect(amocrm.link).toHaveBeenCalledWith(expect.anything(), 'lead', '55501', [
      { to_entity_id: 6001, to_entity_type: 'companies' },
    ]);
  });

  it('пишет «Ссылку на аккаунт» (URL) в компанию, если поле задано', async () => {
    const { svc, amocrm } = make({
      vendorAmocrmAccountFieldId: 1173679,
      vendorAmocrmAccountLinkFieldId: 1195091,
    });
    await svc.onClientInstalled('778');
    const companyCall = (amocrm.create as jest.Mock).mock.calls.find((c) => c[1] === 'company');
    expect(companyCall[2].custom_fields_values).toEqual([
      { field_id: 1173679, values: [{ value: 778 }] },
      { field_id: 1195091, values: [{ value: 'https://clientco.amocrm.ru' }] },
    ]);
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
      { vendor_lead_id: '55501', vendor_company_id: '5' },
    );
    const res = await svc.requestInvoice('778', 8, 12);
    expect(res).toEqual({
      ok: true,
      leadId: '55501',
      sum: 399 * 8 * 10,
      invoiceNumber: expect.stringMatching(/^DUB-778-/),
    });
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

describe('BillingService.saveContact', () => {
  it('создаёт контакт (телефон/email), привязывает к сделке и запоминает телефон', async () => {
    const { svc, amocrm, accounts } = make(
      { vendorAmocrmSubdomain: 'koagency.amocrm.ru', vendorAmocrmToken: 't' },
      { vendor_lead_id: '55501', vendor_company_id: '5' },
    );
    await svc.saveContact('778', { phone: '+79990001122', email: 'c@x.ru' });
    const contactCall = (amocrm.create as jest.Mock).mock.calls.find((c) => c[1] === 'contact');
    expect(contactCall).toBeTruthy();
    expect(contactCall[2].custom_fields_values).toEqual([
      { field_code: 'PHONE', values: [{ value: '+79990001122' }] },
      { field_code: 'EMAIL', values: [{ value: 'c@x.ru' }] },
    ]);
    expect(amocrm.link).toHaveBeenCalledWith(
      'vendor',
      'lead',
      '55501',
      [{ to_entity_id: 55501, to_entity_type: 'contacts' }],
    );
    expect(accounts.updateSettings).toHaveBeenCalledWith(
      '778',
      expect.objectContaining({ contact_phone: '+79990001122' }),
    );
  });

  it('не дублирует контакт при том же телефоне (контакт уже привязан)', async () => {
    const { svc, amocrm } = make(
      { vendorAmocrmSubdomain: 'koagency.amocrm.ru', vendorAmocrmToken: 't' },
      { vendor_lead_id: '55501', contact_phone: '+79990001122', vendor_contact_id: '333' },
    );
    await svc.saveContact('778', { phone: '+79990001122' });
    expect(amocrm.create).not.toHaveBeenCalled();
    expect(amocrm.link).not.toHaveBeenCalled();
  });
});

describe('BillingService.backfillVendorDeals', () => {
  it('создаёт сделки без vendor_lead_id, пропускает существующие', async () => {
    const { svc, amocrm, accounts } = make({
      vendorAmocrmSubdomain: 'koagency.amocrm.ru',
      vendorAmocrmToken: 't',
    });
    (accounts.listAll as jest.Mock).mockResolvedValue([{ account_id: '1' }, { account_id: '2' }]);
    (accounts.getSettings as jest.Mock).mockImplementation((id: string) =>
      Promise.resolve(id === '2' ? { vendor_lead_id: '55501' } : {}),
    );
    const res = await svc.backfillVendorDeals();
    expect(res).toEqual({ created: 1, skipped: 1, failed: 0 });
    // один новый лид (для acct без vendor_lead_id); компании могут создаваться отдельно
    expect((amocrm.create as jest.Mock).mock.calls.filter((c) => c[1] === 'lead').length).toBe(1);
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

  it('сохраняет карту при первом онлайн-платеже (payment_method.saved)', async () => {
    const { svc, subscriptions, yookassa } = make(
      { yookassaShopId: 's', yookassaSecretKey: 'k' },
      { vendor_lead_id: '55501' },
    );
    (yookassa.getPayment as jest.Mock).mockResolvedValue({
      id: 'pay_1',
      status: 'succeeded',
      metadata: { accountId: '778', months: 6, users: 5 },
      payment_method: { id: 'pm_9', saved: true },
    });
    await svc.handlePaymentNotification('pay_1');
    expect(subscriptions.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'yookassa', ykPaymentMethodId: 'pm_9' }),
    );
  });

  it('неуспешный платёж → ничего не меняет', async () => {
    const { svc, accounts, yookassa } = make({ yookassaShopId: 's', yookassaSecretKey: 'k' });
    (yookassa.getPayment as jest.Mock).mockResolvedValue({ id: 'pay_1', status: 'pending', metadata: { accountId: '778' } });
    await svc.handlePaymentNotification('pay_1');
    expect(accounts.updateSettings).not.toHaveBeenCalled();
  });
});
