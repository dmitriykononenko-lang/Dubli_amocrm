import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AmocrmService } from '../amocrm/amocrm.service';
import { AccountsService } from '../accounts/accounts.service';
import { computeQuote, type Quote } from './billing.pricing';
import { YookassaClient } from './yookassa.client';

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
  ): Promise<{ ok: true; leadId: string; sum: number }> {
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

    await this.amocrm.addNote(
      vendorId,
      'lead',
      dealId,
      `Запросил счёт: ${q.sum} ₽ (${q.users} польз. × ${q.months} мес)`,
    );
    await this.amocrm.createTask(vendorId, {
      entityType: 'lead',
      entityId: dealId,
      text: `Выставить счёт клиенту ${clientSub}: ${q.sum} ₽`,
    });

    this.log.log(`Клиент ${clientSub}: запрос счёта на ${q.sum} ₽ → сделка #${dealId}`);
    return { ok: true, leadId: dealId, sum: q.sum };
  }

  /**
   * Онлайн-оплата через ЮKassa. Пока ключи магазина не заданы — 503 с понятным
   * сообщением. Полная реализация (Create Payment → confirmation_url + webhook) — далее.
   */
  async createCheckout(
    clientAccountId: string,
    users: number,
    months: number,
  ): Promise<{ confirmation_url: string; sum: number }> {
    const q = this.quote(users, months);
    if (!this.yookassa.enabled) {
      throw new ServiceUnavailableException(
        'Онлайн-оплата будет включена после настройки ЮKassa (YOOKASSA_SHOP_ID/SECRET_KEY)',
      );
    }
    const clientSub = await this.clientSubdomain(clientAccountId);
    const returnUrl = this.config.billingReturnUrl ?? 'https://dubli.koagency.ru';
    const payment = await this.yookassa.createPayment({
      amount: q.sum,
      description: `Дубли: подписка ${q.users} польз. × ${q.months} мес (${clientSub})`,
      returnUrl,
      metadata: { accountId: clientAccountId, users: q.users, months: q.months },
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
    if (!accountId) return;
    await this.markPaid(accountId, months);
    await this.moveDealToPaid(accountId);
    this.log.log(`Оплата подтверждена: аккаунт ${accountId}, +${months} мес (платёж ${p.id})`);
  }

  /** Продление подписки: paid_until = max(сейчас, текущий paid_until) + months. */
  private async markPaid(clientAccountId: string, months: number): Promise<void> {
    const settings = await this.accounts.getSettings(clientAccountId);
    const now = new Date();
    const base =
      settings.paid_until && new Date(String(settings.paid_until)) > now
        ? new Date(String(settings.paid_until))
        : now;
    base.setMonth(base.getMonth() + Math.max(1, months));
    await this.accounts.updateSettings(clientAccountId, {
      ...settings,
      paid_until: base.toISOString(),
    });
  }

  private async moveDealToPaid(clientAccountId: string): Promise<void> {
    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) return;
    const dealId = await this.ensureClientDeal(clientAccountId);
    if (!dealId) return;
    const stages = await this.resolveStages(vendorId);
    if (stages.paid) await this.amocrm.update(vendorId, 'lead', dealId, { status_id: stages.paid });
    await this.amocrm.addNote(vendorId, 'lead', dealId, 'Оплата получена (ЮKassa)');
  }

  /**
   * Гарантирует сделку клиента в нашей amoCRM (идемпотентно по vendor_lead_id).
   * Возвращает id сделки или null, если vendor-аккаунт не настроен.
   */
  private async ensureClientDeal(clientAccountId: string): Promise<string | null> {
    const settings = await this.accounts.getSettings(clientAccountId);
    if (settings.vendor_lead_id) return String(settings.vendor_lead_id);

    const vendorId = await this.resolveVendorAccountId();
    if (!vendorId) return null;

    const clientSub = await this.clientSubdomain(clientAccountId);
    const payload: Record<string, unknown> = { name: `Дубли: ${clientSub}` };
    const pipelineId = this.config.vendorAmocrmPipelineId;
    if (pipelineId) payload.pipeline_id = pipelineId;
    const stages = await this.resolveStages(vendorId);
    if (stages.installed) payload.status_id = stages.installed;

    const leadId = await this.amocrm.create(vendorId, 'lead', payload);
    await this.accounts.updateSettings(clientAccountId, { ...settings, vendor_lead_id: leadId });
    await this.amocrm.addNote(
      vendorId,
      'lead',
      leadId,
      `Клиент установил виджет «Дубли»: ${clientSub}`,
    );
    this.log.log(`Клиент ${clientSub} установил виджет → сделка #${leadId} в vendor ${vendorId}`);
    return leadId;
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

  private async clientSubdomain(clientAccountId: string): Promise<string> {
    const acc = await this.accounts.findById(clientAccountId);
    return acc?.subdomain ?? clientAccountId;
  }

  private async resolveVendorAccountId(): Promise<string | null> {
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
