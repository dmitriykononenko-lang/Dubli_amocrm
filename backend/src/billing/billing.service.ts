import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AmocrmService, VENDOR_ACCOUNT_KEY } from '../amocrm/amocrm.service';
import { AccountsService } from '../accounts/accounts.service';
import type { AccountSettings, EntityType } from '../common/db/database.types';
import { type Quote } from './billing.pricing';
import { YookassaClient } from './yookassa.client';
import { SubscriptionsService } from './subscriptions.service';
import { DEFAULT_PRODUCT, ProductsService, type ResolvedProduct } from './products.service';

/** Продукт по умолчанию для вызовов без product (установка/контакт/бэкфилл виджета «Дубли»). */
const DUBLI: ResolvedProduct = { code: DEFAULT_PRODUCT, name: 'Дубли', pipelineId: null };

/**
 * Ведение клиента виджета в НАШЕЙ (Ko:agency) amoCRM по этапам:
 * установил виджет → запросил оплату → оплатил. Одна сделка на клиента,
 * её id храним в настройках клиентского аккаунта (vendor_lead_id).
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');
  /** Кэш этапов по воронке (у каждого продукта может быть своя воронка в koagency). */
  private readonly stagesCache = new Map<
    number,
    { installed?: number; requested?: number; paid?: number }
  >();

  constructor(
    private readonly config: AppConfigService,
    private readonly amocrm: AmocrmService,
    private readonly accounts: AccountsService,
    private readonly yookassa: YookassaClient,
    private readonly subscriptions: SubscriptionsService,
    private readonly products: ProductsService,
  ) {}

  /** Котировка суммы. Виджет Дубли считается по тарифу продукта 'dubli' (фолбэк — глобальный env). */
  quote(users: number, months: number, product: string = DEFAULT_PRODUCT): Promise<Quote> {
    return this.products.quote(users, months, product);
  }

  /**
   * Событие «клиент установил виджет» (вызывается из OAuth-установки).
   * Best-effort: сбой в нашей amoCRM НЕ должен ломать установку у клиента.
   */
  async onClientInstalled(clientAccountId: string): Promise<void> {
    // Пробная подписка (триал от установки) — источник истины по доступу.
    await this.best(() => this.subscriptions.ensure(clientAccountId), 'ensureSubscription');
    try {
      await this.ensureClientDeal(clientAccountId);
    } catch (e) {
      this.log.warn(`Не удалось завести сделку клиента ${clientAccountId} при установке: ${String(e)}`);
    }
  }

  /**
   * Заявка на счёт: двигаем сделку клиента на этап «Запросил оплату»,
   * пишем сумму примечанием и ставим задачу менеджеру выставить счёт.
   */
  async requestInvoice(
    clientAccountId: string,
    users: number,
    months: number,
    contact?: { phone?: string; email?: string },
    product?: string,
  ): Promise<{ ok: true; leadId: string; sum: number; invoiceNumber: string; product: string }> {
    // Продукт — из тела запроса (виджет хаба) или 'dubli'; неизвестный/выключенный → 400.
    const prod = await this.products.resolve(product);
    const q = await this.quote(users, months, prod.code);
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) {
      throw new ServiceUnavailableException(
        'Аккаунт для счетов не настроен (VENDOR_AMOCRM_ACCOUNT_ID или VENDOR_AMOCRM_SUBDOMAIN)',
      );
    }
    const dealId = await this.ensureClientDeal(clientAccountId, prod);
    if (!dealId) throw new ServiceUnavailableException('Не удалось создать сделку клиента');

    const clientSub = await this.clientSubdomain(clientAccountId);
    const stages = await this.resolveStages(vendorId, prod.pipelineId);
    // Для продуктов хаба (не «Дубли») помечаем продукт в примечании/задаче — у клиента их может быть несколько.
    const productTag = prod.code === DEFAULT_PRODUCT ? '' : ` · ${prod.name}`;
    const patch: Record<string, unknown> = { price: q.sum };
    if (stages.requested) patch.status_id = stages.requested;
    await this.amocrm.update(vendorId, 'lead', dealId, patch);

    // Контакт клиента (телефон/email — amoCRM их не отдаёт автоматически, приходят из виджета).
    const phone = (contact?.phone ?? '').trim();
    const email = (contact?.email ?? '').trim();
    const contactLine = [phone && `тел: ${phone}`, email && `email: ${email}`]
      .filter(Boolean)
      .join(' · ');

    // Примечание и задача — обогащение, не должны ронять запрос счёта.
    await this.best(
      () =>
        this.amocrm.addNote(
          vendorId,
          'lead',
          dealId,
          `Запросил счёт: ${q.sum} ₽ (${q.users} польз. × ${q.months} мес)${productTag}` +
            (contactLine ? `\nКонтакт: ${contactLine}` : ''),
        ),
      'addNote(requested)',
    );
    await this.best(
      () =>
        this.amocrm.createTask(vendorId, {
          entityType: 'lead',
          entityId: dealId,
          text:
            `Выставить счёт клиенту ${clientSub}: ${q.sum} ₽${productTag}` +
            (phone ? ` · тел ${phone}` : ''),
        }),
      'createTask(invoice)',
    );

    // Привязать контакт клиента (телефон/email, с дедупом) к сделке.
    if (phone || email) {
      const name = await this.clientName(clientAccountId, await this.accounts.getSettings(clientAccountId));
      await this.best(
        () => this.attachContact(vendorId, clientAccountId, dealId, { phone, email, name }),
        'attachContact(invoice)',
      );
    }

    // Трек «счёт»: регистрируем счёт с уникальным номером (в назначение платежа) и
    // переводим подписку в awaiting_invoice_payment. Идёт после сделки, чтобы знать её id.
    const invoiceNumber = this.invoiceNumber(clientAccountId, prod.code);
    await this.best(
      () =>
        this.subscriptions.issueInvoice(clientAccountId, {
          users: q.users,
          months: q.months,
          amount: q.sum,
          number: invoiceNumber,
          vendorDealId: dealId,
          product: prod.code,
        }),
      'issueInvoice',
    );

    this.log.log(
      `Клиент ${clientSub}/${prod.code}: счёт ${invoiceNumber} на ${q.sum} ₽ → сделка #${dealId}`,
    );
    return { ok: true, leadId: dealId, sum: q.sum, invoiceNumber, product: prod.code };
  }

  /**
   * Уникальный номер счёта (референс в назначении платежа): <PREFIX>-<accountId>-<base36 времени>.
   * Префикс — платёжный код продукта (см. invoicePrefix): по нему сверка/оператор видят,
   * к какому виджету относится поступление, ещё до поиска счёта в базе.
   */
  private invoiceNumber(clientAccountId: string, product: string = DEFAULT_PRODUCT): string {
    const prefix = BillingService.invoicePrefix(product);
    return `${prefix}-${clientAccountId}-${Date.now().toString(36).toUpperCase()}`;
  }

  /**
   * Платёжный код продукта в номере счёта: 'dubli' → DUB (как было), иначе первые 3 латинские
   * буквы кода продукта в верхнем регистре ('raspredelenie' → RAS); без латиницы → INV.
   */
  static invoicePrefix(product: string): string {
    if (product === DEFAULT_PRODUCT) return 'DUB';
    const letters = product
      .replace(/[^a-z]/gi, '')
      .toUpperCase()
      .slice(0, 3);
    return letters.length === 3 ? letters : 'INV';
  }

  /**
   * Контакт клиента (телефон/email из виджета) — создаём/находим контакт в vendor CRM и
   * привязываем к сделке. Идемпотентно: пропускаем, если телефон не менялся и контакт уже есть.
   */
  async saveContact(
    clientAccountId: string,
    contact: { phone?: string; email?: string },
  ): Promise<{ ok: true }> {
    const phone = (contact.phone ?? '').trim();
    const email = (contact.email ?? '').trim();
    if (!phone && !email) return { ok: true };

    const settings = await this.accounts.getSettings(clientAccountId);
    if (settings.contact_phone === phone && settings.vendor_contact_id) return { ok: true };

    const vendorId = await this.resolveVendorAccountId();
    if (vendorId) {
      const dealId = await this.ensureClientDeal(clientAccountId);
      if (dealId) {
        const name = await this.clientName(clientAccountId, settings);
        await this.best(
          () => this.attachContact(vendorId, clientAccountId, dealId, { phone, email, name }),
          'attachContact',
        );
      }
    }
    // Перечитываем настройки: под-методы могли записать vendor_*_id — не затираем их.
    const latest = await this.accounts.getSettings(clientAccountId);
    await this.accounts.updateSettings(clientAccountId, { ...latest, contact_phone: phone });
    return { ok: true };
  }

  /**
   * Онлайн-оплата через ЮKassa. Пока ключи магазина не заданы — 503 с понятным
   * сообщением. Полная реализация (Create Payment → confirmation_url + webhook) — далее.
   */
  async createCheckout(
    clientAccountId: string,
    users: number,
    months: number,
    email?: string,
    product?: string,
  ): Promise<{ confirmation_url: string; sum: number; product: string }> {
    // Продукт — платёжный код: уходит в metadata платежа ЮKassa и возвращается в вебхуке,
    // по нему оплата относится к подписке (account_id, product). Неизвестный → 400 до создания платежа.
    const prod = await this.products.resolve(product);
    const q = await this.quote(users, months, prod.code);
    if (!this.yookassa.enabled) {
      throw new ServiceUnavailableException(
        'Онлайн-оплата будет включена после настройки ЮKassa (YOOKASSA_SHOP_ID/SECRET_KEY)',
      );
    }
    const clientSub = await this.clientSubdomain(clientAccountId);
    const returnUrl = this.config.billingReturnUrl ?? 'https://dubli.koagency.ru';
    const description = `Подписка «${prod.name}»: ${q.users} польз. × ${q.months} мес`;

    // Чек (54-ФЗ): при фискализации ЮKassa обязателен объект receipt с позицией и email.
    let receipt: Record<string, unknown> | undefined;
    if (this.config.yookassaFiscal) {
      const em = (email ?? '').trim();
      if (!em) throw new BadRequestException('Для чека (54-ФЗ) нужен email покупателя');
      receipt = {
        customer: { email: em },
        items: [
          {
            description: description.slice(0, 128),
            quantity: '1.00',
            amount: { value: q.sum.toFixed(2), currency: 'RUB' },
            vat_code: this.config.yookassaVatCode,
            payment_subject: 'service',
            payment_mode: 'full_payment',
          },
        ],
      };
    }

    const payment = await this.yookassa.createPayment({
      amount: q.sum,
      description: `${description} (${clientSub})`,
      returnUrl,
      metadata: { accountId: clientAccountId, product: prod.code, users: q.users, months: q.months },
      receipt,
      savePaymentMethod: true, // сохраняем карту для авто-продления (рекуррент)
    });
    const url = payment.confirmation?.confirmation_url;
    if (!url) throw new ServiceUnavailableException('ЮKassa не вернула ссылку на оплату');
    this.log.log(`Клиент ${clientSub}/${prod.code}: платёж ЮKassa ${payment.id} на ${q.sum} ₽`);
    return { confirmation_url: url, sum: q.sum, product: prod.code };
  }

  /**
   * Уведомление ЮKassa о платеже. Тело не доверяем — перепроверяем платёж по id.
   * Распределение по продукту: код продукта берём из metadata.product платежа (его кладут
   * createCheckout и рекуррент); без кода — 'dubli' (платежи, созданные до хаба).
   * При успехе продлеваем подписку (account_id, product) и двигаем сделку клиента на «Оплачен»
   * в воронке продукта.
   */
  async handlePaymentNotification(paymentId: string): Promise<void> {
    if (!this.yookassa.enabled || !paymentId) return;
    const p = await this.yookassa.getPayment(paymentId);
    if (p.status !== 'succeeded') return;
    const accountId = String((p.metadata?.accountId as string | number | undefined) ?? '');
    const months = Number(p.metadata?.months ?? 0);
    const users = Number(p.metadata?.users ?? 0) || null;
    const amount = p.amount?.value != null ? Number(p.amount.value) : null;
    if (!accountId) return;
    // Деньги уже получены — учитываем платёж даже с неизвестным кодом (в панели виден по product),
    // но сделку в koagency для неизвестного продукта не трогаем: воронки у него нет.
    const prod = await this.products.resolveLenient(p.metadata?.product as string | undefined);
    if (!prod.known) {
      this.log.warn(
        `Платёж ${p.id}: неизвестный код продукта «${prod.code}» в metadata — учтён как есть, нужен ручной разбор`,
      );
    }
    // Токен сохранённой карты (для будущих безакцептных списаний рекуррентом).
    const ykPaymentMethodId = p.payment_method?.saved ? (p.payment_method.id ?? null) : null;
    // Продление через подписку — идемпотентно по payment_id (повторный вебхук не удвоит).
    const res = await this.subscriptions.recordPayment({
      accountId,
      product: prod.code,
      months,
      users,
      source: 'yookassa',
      paymentId: p.id,
      amount,
      ykPaymentMethodId,
    });
    if (res.duplicate) {
      this.log.log(`Повторный вебхук платежа ${p.id} — уже учтён`);
      return;
    }
    // settings.paid_until читает только виджет «Дубли» — для других продуктов не зеркалим.
    if (prod.code === DEFAULT_PRODUCT) await this.syncLegacyPaidUntil(accountId, res.paidTill);
    if (prod.known) await this.moveDealToPaid(accountId, prod);
    this.log.log(
      `Оплата подтверждена: аккаунт ${accountId}/${prod.code}, +${months} мес (платёж ${p.id})`,
    );
  }

  /** Зеркалим дату продления в settings.paid_until — для существующих читателей (виджет «Оплачено до»). */
  private async syncLegacyPaidUntil(clientAccountId: string, paidTillIso: string): Promise<void> {
    if (!paidTillIso) return;
    const settings = await this.accounts.getSettings(clientAccountId);
    await this.accounts.updateSettings(clientAccountId, { ...settings, paid_until: paidTillIso });
  }

  private async moveDealToPaid(
    clientAccountId: string,
    prod: ResolvedProduct = DUBLI,
  ): Promise<void> {
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) return;
    const dealId = await this.ensureClientDeal(clientAccountId, prod);
    if (!dealId) return;
    const stages = await this.resolveStages(vendorId, prod.pipelineId);
    if (stages.paid) await this.amocrm.update(vendorId, 'lead', dealId, { status_id: stages.paid });
    const note =
      prod.code === DEFAULT_PRODUCT
        ? 'Оплата получена (ЮKassa)'
        : `Оплата получена (ЮKassa) · ${prod.name}`;
    await this.best(() => this.amocrm.addNote(vendorId, 'lead', dealId, note), 'addNote(paid)');
  }

  /** id сделки продукта в vendor CRM из настроек клиента: «Дубли» — vendor_lead_id, остальные — vendor_leads[code]. */
  private static storedLeadId(settings: AccountSettings, product: string): string | null {
    if (product === DEFAULT_PRODUCT) {
      return settings.vendor_lead_id ? String(settings.vendor_lead_id) : null;
    }
    const id = settings.vendor_leads?.[product];
    return id ? String(id) : null;
  }

  /**
   * Гарантирует сделку клиента по продукту в нашей amoCRM (идемпотентно по сохранённому id:
   * vendor_lead_id для «Дубли», vendor_leads[<product>] для остальных виджетов хаба).
   * Сделка создаётся в воронке продукта (products.pipeline_id), фолбэк — VENDOR_AMOCRM_PIPELINE_ID.
   * Возвращает id сделки или null, если vendor-аккаунт не настроен.
   */
  private async ensureClientDeal(
    clientAccountId: string,
    prod: ResolvedProduct = DUBLI,
  ): Promise<string | null> {
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) return null;

    const settings = await this.accounts.getSettings(clientAccountId);
    const name = await this.clientName(clientAccountId, settings);
    const stored = BillingService.storedLeadId(settings, prod.code);

    let leadId: string;
    let created = false;
    if (stored && (await this.entityExists(vendorId, 'lead', stored))) {
      leadId = stored;
    } else {
      if (stored) {
        this.log.warn(
          `Сделка ${stored} клиента ${clientAccountId}/${prod.code} не найдена — создаю заново`,
        );
      }
      const payload: Record<string, unknown> = { name: `${prod.name}: ${name}` };
      const pipelineId = prod.pipelineId ?? this.config.vendorAmocrmPipelineId;
      if (pipelineId) payload.pipeline_id = pipelineId;
      const stages = await this.resolveStages(vendorId, prod.pipelineId);
      if (stages.installed) payload.status_id = stages.installed;
      leadId = await this.amocrm.create(vendorId, 'lead', payload);
      created = true;
      const leadPatch: Partial<AccountSettings> =
        prod.code === DEFAULT_PRODUCT
          ? { vendor_lead_id: leadId }
          : { vendor_leads: { ...(settings.vendor_leads ?? {}), [prod.code]: leadId } };
      await this.accounts.updateSettings(clientAccountId, {
        ...settings,
        ...leadPatch,
        client_name: name,
      });
      await this.best(
        () =>
          this.amocrm.addNote(
            vendorId,
            'lead',
            leadId,
            `Клиент установил виджет «${prod.name}»: ${name}`,
          ),
        'addNote(installed)',
      );
      this.log.log(
        `Клиент ${name} (${clientAccountId}/${prod.code}) → сделка #${leadId} в vendor ${vendorId}`,
      );
    }

    // Компания с полем «ID аккаунта amo» — создаём один раз на аккаунт (пока не сохранён id);
    // к новой сделке другого продукта уже существующую компанию просто привязываем.
    const fresh = await this.accounts.getSettings(clientAccountId);
    if (!fresh.vendor_company_id) {
      await this.best(() => this.attachCompany(vendorId, clientAccountId, leadId, name), 'attachCompany');
    } else if (created && prod.code !== DEFAULT_PRODUCT) {
      const companyId = Number(fresh.vendor_company_id);
      await this.best(
        () =>
          this.amocrm.link(vendorId, 'lead', leadId, [
            { to_entity_id: companyId, to_entity_type: 'companies' },
          ]),
        'linkCompany',
      );
    }
    return leadId;
  }

  /** Имя клиента: из GET /api/v4/account (кэшируется в settings), фолбэк — субдомен. */
  private async clientName(clientAccountId: string, settings: AccountSettings): Promise<string> {
    if (settings.client_name) return String(settings.client_name);
    const name = await this.amocrm.getAccountName(clientAccountId);
    return name || (await this.clientSubdomain(clientAccountId));
  }

  /**
   * Компания клиента в vendor CRM с кастом-полем «ID аккаунта amo» (1173679, поле КОМПАНИИ,
   * не сделки). Дедуп: сохранённый vendor_company_id → поиск по account_id → создание. Привязка к сделке.
   */
  private async attachCompany(
    vendorId: string,
    clientAccountId: string,
    leadId: string,
    name: string,
  ): Promise<void> {
    const settings = await this.accounts.getSettings(clientAccountId);
    let companyId =
      settings.vendor_company_id &&
      (await this.entityExists(vendorId, 'company', String(settings.vendor_company_id)))
        ? String(settings.vendor_company_id)
        : null;
    if (!companyId) companyId = await this.findCompanyByAccount(vendorId, clientAccountId);
    if (!companyId) {
      const cfv: Array<Record<string, unknown>> = [];
      const fieldId = this.config.vendorAmocrmAccountFieldId;
      if (fieldId) cfv.push({ field_id: fieldId, values: [{ value: Number(clientAccountId) }] });
      // «Ссылка на аккаунт» — URL amoCRM клиента (по субдомену).
      const linkFieldId = this.config.vendorAmocrmAccountLinkFieldId;
      if (linkFieldId) {
        const sub = await this.clientSubdomain(clientAccountId);
        cfv.push({ field_id: linkFieldId, values: [{ value: `https://${sub}.amocrm.ru` }] });
      }
      const payload: Record<string, unknown> = { name };
      if (cfv.length) payload.custom_fields_values = cfv;
      companyId = await this.amocrm.create(vendorId, 'company', payload);
    }
    await this.accounts.updateSettings(clientAccountId, { ...settings, vendor_company_id: companyId });
    await this.amocrm.link(vendorId, 'lead', leadId, [
      { to_entity_id: Number(companyId), to_entity_type: 'companies' },
    ]);
  }

  /** Поиск компании в vendor CRM по значению поля «ID аккаунта amo» = clientAccountId. */
  private async findCompanyByAccount(vendorId: string, clientAccountId: string): Promise<string | null> {
    const fieldId = this.config.vendorAmocrmAccountFieldId;
    const found = await this.amocrm.search(vendorId, 'company', clientAccountId);
    for (const c of found) {
      const cfv = (c.custom_fields_values as Array<{ field_id?: number; values?: Array<{ value?: unknown }> }>) ?? [];
      const cf = cfv.find((f) => f.field_id === fieldId);
      if (cf && String(cf.values?.[0]?.value) === String(clientAccountId)) return String(c.id);
    }
    return null;
  }

  /**
   * Контакт клиента в vendor CRM (телефон/email) с дедупом: сохранённый id → поиск по
   * телефону/email → создание. Привязка к сделке. Best-effort вызывается из invoice/saveContact.
   */
  private async attachContact(
    vendorId: string,
    clientAccountId: string,
    leadId: string,
    contact: { phone?: string; email?: string; name: string },
  ): Promise<void> {
    const phone = (contact.phone ?? '').trim();
    const email = (contact.email ?? '').trim();
    if (!phone && !email) return;

    const settings = await this.accounts.getSettings(clientAccountId);
    let contactId =
      settings.vendor_contact_id &&
      (await this.entityExists(vendorId, 'contact', String(settings.vendor_contact_id)))
        ? String(settings.vendor_contact_id)
        : null;
    if (!contactId) {
      let hits = phone ? await this.amocrm.search(vendorId, 'contact', phone) : [];
      if (!hits.length && email) hits = await this.amocrm.search(vendorId, 'contact', email);
      if (hits.length) contactId = String(hits[0].id);
    }
    if (!contactId) {
      const cfv: Array<Record<string, unknown>> = [];
      if (phone) cfv.push({ field_code: 'PHONE', values: [{ value: phone }] });
      if (email) cfv.push({ field_code: 'EMAIL', values: [{ value: email }] });
      contactId = await this.amocrm.create(vendorId, 'contact', {
        name: contact.name,
        custom_fields_values: cfv,
      });
    }
    await this.accounts.updateSettings(clientAccountId, { ...settings, vendor_contact_id: contactId });
    await this.amocrm.link(vendorId, 'lead', leadId, [
      { to_entity_id: Number(contactId), to_entity_type: 'contacts' },
    ]);
  }

  /** Существует ли сущность в vendor CRM. false только при явном 404 (удалена). */
  private async entityExists(vendorId: string, entityType: EntityType, id: string): Promise<boolean> {
    try {
      await this.amocrm.getById(vendorId, entityType, id);
      return true;
    } catch (e) {
      if (/amoCRM API 404/.test(String(e))) return false;
      return true; // транзиентная ошибка — не пересоздаём, чтобы не плодить дубли
    }
  }

  /**
   * Бэкфилл: для всех аккаунтов без сделки (или с удалённой) создаёт сделку «установлен».
   * Идемпотентно (ensureClientDeal + dealExists). Запускается разово скриптом.
   */
  async backfillVendorDeals(): Promise<{ created: number; skipped: number; failed: number }> {
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) throw new ServiceUnavailableException('Vendor-аккаунт не настроен (нет токена/субдомена)');
    const accounts = await this.accounts.listAll();
    let created = 0;
    let skipped = 0;
    let failed = 0;
    for (const a of accounts) {
      const id = String(a.account_id);
      try {
        const s = await this.accounts.getSettings(id);
        const had = Boolean(s.vendor_lead_id);
        const dealId = await this.ensureClientDeal(id);
        if (!dealId) skipped++;
        else if (had) skipped++;
        else created++;
      } catch (e) {
        failed++;
        this.log.warn(`Бэкфилл: аккаунт ${id} — ${String(e)}`);
      }
    }
    this.log.log(`Бэкфилл vendor-сделок: создано ${created}, пропущено ${skipped}, ошибок ${failed}`);
    return { created, skipped, failed };
  }

  /**
   * Этапы воронки для перехода сделки. Воронка — продукта (products.pipeline_id), иначе
   * глобальная VENDOR_AMOCRM_PIPELINE_ID. Явные ID этапов из .env относятся к глобальной
   * воронке и применяются только для неё; иначе этапы ищутся по названию (ключевые слова
   * «установ»/«счет»/«оплач»), чтобы достаточно было указать только id воронки.
   */
  private async resolveStages(
    vendorId: string,
    pipelineId?: number | null,
  ): Promise<{ installed?: number; requested?: number; paid?: number }> {
    const globalPid = this.config.vendorAmocrmPipelineId;
    const pid = pipelineId ?? globalPid;
    if (!pid) return {};
    if (pid === globalPid) {
      const env = {
        installed: this.config.vendorAmocrmStatusInstalled,
        requested: this.config.vendorAmocrmStatusRequested,
        paid: this.config.vendorAmocrmStatusPaid,
      };
      if (env.installed || env.requested || env.paid) return env;
    }
    const cached = this.stagesCache.get(pid);
    if (cached) return cached;
    try {
      const statuses = await this.amocrm.getPipelineStatuses(vendorId, pid);
      const find = (kw: string): number | undefined =>
        statuses.find((s) => (s.name || '').toLowerCase().includes(kw))?.id;
      const stages = {
        installed: find('установ'),
        requested: find('счет') ?? find('счёт'),
        paid: find('оплач'),
      };
      this.stagesCache.set(pid, stages);
      return stages;
    } catch (e) {
      this.log.warn(`Не удалось получить этапы воронки ${pid}: ${String(e)}`);
      return {};
    }
  }

  /** Выполнить необязательное действие, не роняя основной поток (лог при ошибке). */
  private async best(fn: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.warn(`${what} не выполнено: ${String(e)}`);
    }
  }

  private async clientSubdomain(clientAccountId: string): Promise<string> {
    const acc = await this.accounts.findById(clientAccountId);
    return acc?.subdomain ?? clientAccountId;
  }

  private async resolveVendorAccountId(): Promise<string | null> {
    // Долгосрочный токен → работаем через vendor-ключ, БД/установка не нужны.
    if (this.config.vendorAmocrmToken && this.config.vendorAmocrmSubdomain) return VENDOR_ACCOUNT_KEY;
    const byId = this.config.vendorAmocrmAccountId;
    if (byId) return byId;
    const sub = this.config.vendorAmocrmSubdomain;
    if (sub) {
      const acc = await this.accounts.findBySubdomain(sub);
      return acc?.account_id != null ? String(acc.account_id) : null;
    }
    return null;
  }
}
