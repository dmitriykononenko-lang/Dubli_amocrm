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
import { computeQuote, type Quote } from './billing.pricing';
import { YookassaClient } from './yookassa.client';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Ведение клиента виджета в НАШЕЙ (Ko:agency) amoCRM по этапам:
 * установил виджет → запросил оплату → оплатил. Одна сделка на клиента,
 * её id храним в настройках клиентского аккаунта (vendor_lead_id).
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');
  private stagesCache: { installed?: number; requested?: number; paid?: number } | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly amocrm: AmocrmService,
    private readonly accounts: AccountsService,
    private readonly yookassa: YookassaClient,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  quote(users: number, months: number): Quote {
    return computeQuote(users, months, {
      pricePerUser: this.config.billingPricePerUser,
      minUsers: this.config.billingMinUsers,
    });
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
  ): Promise<{ ok: true; leadId: string; sum: number; invoiceNumber: string }> {
    const q = this.quote(users, months);
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) {
      throw new ServiceUnavailableException(
        'Аккаунт для счетов не настроен (VENDOR_AMOCRM_ACCOUNT_ID или VENDOR_AMOCRM_SUBDOMAIN)',
      );
    }
    const dealId = await this.ensureClientDeal(clientAccountId);
    if (!dealId) throw new ServiceUnavailableException('Не удалось создать сделку клиента');

    const clientSub = await this.clientSubdomain(clientAccountId);
    const stages = await this.resolveStages(vendorId);
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
          `Запросил счёт: ${q.sum} ₽ (${q.users} польз. × ${q.months} мес)` +
            (contactLine ? `\nКонтакт: ${contactLine}` : ''),
        ),
      'addNote(requested)',
    );
    await this.best(
      () =>
        this.amocrm.createTask(vendorId, {
          entityType: 'lead',
          entityId: dealId,
          text: `Выставить счёт клиенту ${clientSub}: ${q.sum} ₽` + (phone ? ` · тел ${phone}` : ''),
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
    const invoiceNumber = this.invoiceNumber(clientAccountId);
    await this.best(
      () =>
        this.subscriptions.issueInvoice(clientAccountId, {
          users: q.users,
          months: q.months,
          amount: q.sum,
          number: invoiceNumber,
          vendorDealId: dealId,
        }),
      'issueInvoice',
    );

    this.log.log(`Клиент ${clientSub}: счёт ${invoiceNumber} на ${q.sum} ₽ → сделка #${dealId}`);
    return { ok: true, leadId: dealId, sum: q.sum, invoiceNumber };
  }

  /** Уникальный номер счёта (референс в назначении платежа): DUB-<accountId>-<base36 времени>. */
  private invoiceNumber(clientAccountId: string): string {
    return `DUB-${clientAccountId}-${Date.now().toString(36).toUpperCase()}`;
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
  ): Promise<{ confirmation_url: string; sum: number }> {
    const q = this.quote(users, months);
    if (!this.yookassa.enabled) {
      throw new ServiceUnavailableException(
        'Онлайн-оплата будет включена после настройки ЮKassa (YOOKASSA_SHOP_ID/SECRET_KEY)',
      );
    }
    const clientSub = await this.clientSubdomain(clientAccountId);
    const returnUrl = this.config.billingReturnUrl ?? 'https://dubli.koagency.ru';
    const description = `Подписка «Дубли»: ${q.users} польз. × ${q.months} мес`;

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
      metadata: { accountId: clientAccountId, users: q.users, months: q.months },
      receipt,
    });
    const url = payment.confirmation?.confirmation_url;
    if (!url) throw new ServiceUnavailableException('ЮKassa не вернула ссылку на оплату');
    this.log.log(`Клиент ${clientSub}: платёж ЮKassa ${payment.id} на ${q.sum} ₽`);
    return { confirmation_url: url, sum: q.sum };
  }

  /**
   * Уведомление ЮKassa о платеже. Тело не доверяем — перепроверяем платёж по id.
   * При успехе продлеваем подписку и двигаем сделку клиента на «Оплачен».
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
    // Продление через подписку — идемпотентно по payment_id (повторный вебхук не удвоит).
    const res = await this.subscriptions.recordPayment({
      accountId,
      months,
      users,
      source: 'yookassa',
      paymentId: p.id,
      amount,
    });
    if (res.duplicate) {
      this.log.log(`Повторный вебхук платежа ${p.id} — уже учтён`);
      return;
    }
    await this.syncLegacyPaidUntil(accountId, res.paidTill);
    await this.moveDealToPaid(accountId);
    this.log.log(`Оплата подтверждена: аккаунт ${accountId}, +${months} мес (платёж ${p.id})`);
  }

  /** Зеркалим дату продления в settings.paid_until — для существующих читателей (виджет «Оплачено до»). */
  private async syncLegacyPaidUntil(clientAccountId: string, paidTillIso: string): Promise<void> {
    if (!paidTillIso) return;
    const settings = await this.accounts.getSettings(clientAccountId);
    await this.accounts.updateSettings(clientAccountId, { ...settings, paid_until: paidTillIso });
  }

  private async moveDealToPaid(clientAccountId: string): Promise<void> {
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) return;
    const dealId = await this.ensureClientDeal(clientAccountId);
    if (!dealId) return;
    const stages = await this.resolveStages(vendorId);
    if (stages.paid) await this.amocrm.update(vendorId, 'lead', dealId, { status_id: stages.paid });
    await this.best(
      () => this.amocrm.addNote(vendorId, 'lead', dealId, 'Оплата получена (ЮKassa)'),
      'addNote(paid)',
    );
  }

  /**
   * Гарантирует сделку клиента в нашей amoCRM (идемпотентно по vendor_lead_id).
   * Возвращает id сделки или null, если vendor-аккаунт не настроен.
   */
  private async ensureClientDeal(clientAccountId: string): Promise<string | null> {
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) return null;

    const settings = await this.accounts.getSettings(clientAccountId);
    const name = await this.clientName(clientAccountId, settings);

    let leadId: string;
    if (settings.vendor_lead_id && (await this.entityExists(vendorId, 'lead', String(settings.vendor_lead_id)))) {
      leadId = String(settings.vendor_lead_id);
    } else {
      if (settings.vendor_lead_id) {
        this.log.warn(`Сделка ${settings.vendor_lead_id} клиента ${clientAccountId} не найдена — создаю заново`);
      }
      const payload: Record<string, unknown> = { name: `Дубли: ${name}` };
      const pipelineId = this.config.vendorAmocrmPipelineId;
      if (pipelineId) payload.pipeline_id = pipelineId;
      const stages = await this.resolveStages(vendorId);
      if (stages.installed) payload.status_id = stages.installed;
      leadId = await this.amocrm.create(vendorId, 'lead', payload);
      await this.accounts.updateSettings(clientAccountId, {
        ...settings,
        vendor_lead_id: leadId,
        client_name: name,
      });
      await this.best(
        () => this.amocrm.addNote(vendorId, 'lead', leadId, `Клиент установил виджет «Дубли»: ${name}`),
        'addNote(installed)',
      );
      this.log.log(`Клиент ${name} (${clientAccountId}) → сделка #${leadId} в vendor ${vendorId}`);
    }

    // Компания с полем «ID аккаунта amo» — привязываем один раз (пока не сохранён id).
    const fresh = await this.accounts.getSettings(clientAccountId);
    if (!fresh.vendor_company_id) {
      await this.best(() => this.attachCompany(vendorId, clientAccountId, leadId, name), 'attachCompany');
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
   * Этапы воронки для перехода сделки. Приоритет — явные ID из .env; иначе, если
   * задана воронка, находим этапы по названию (ключевые слова «установ»/«счет»/«оплач»),
   * чтобы достаточно было указать только VENDOR_AMOCRM_PIPELINE_ID.
   */
  private async resolveStages(
    vendorId: string,
  ): Promise<{ installed?: number; requested?: number; paid?: number }> {
    const pid = this.config.vendorAmocrmPipelineId;
    if (!pid) return {};
    const env = {
      installed: this.config.vendorAmocrmStatusInstalled,
      requested: this.config.vendorAmocrmStatusRequested,
      paid: this.config.vendorAmocrmStatusPaid,
    };
    if (env.installed || env.requested || env.paid) return env;
    if (this.stagesCache) return this.stagesCache;
    try {
      const statuses = await this.amocrm.getPipelineStatuses(vendorId, pid);
      const find = (kw: string): number | undefined =>
        statuses.find((s) => (s.name || '').toLowerCase().includes(kw))?.id;
      this.stagesCache = {
        installed: find('установ'),
        requested: find('счет') ?? find('счёт'),
        paid: find('оплач'),
      };
      return this.stagesCache;
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
