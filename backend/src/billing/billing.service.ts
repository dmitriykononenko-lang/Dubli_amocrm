import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AmocrmService } from '../amocrm/amocrm.service';
import { AccountsService } from '../accounts/accounts.service';
import { computeQuote, type Quote } from './billing.pricing';

/**
 * Ведение клиента виджета в НАШЕЙ (Ko:agency) amoCRM по этапам:
 * установил виджет → запросил оплату → оплатил. Одна сделка на клиента,
 * её id храним в настройках клиентского аккаунта (vendor_lead_id).
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');

  constructor(
    private readonly config: AppConfigService,
    private readonly amocrm: AmocrmService,
    private readonly accounts: AccountsService,
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
    const patch: Record<string, unknown> = { price: q.sum };
    const requested = this.config.vendorAmocrmStatusRequested;
    if (requested) patch.status_id = requested;
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
    _clientAccountId: string,
    users: number,
    months: number,
  ): Promise<{ confirmation_url: string; sum: number }> {
    this.quote(users, months);
    if (!this.config.yookassaShopId || !this.config.yookassaSecretKey) {
      throw new ServiceUnavailableException(
        'Онлайн-оплата будет включена после настройки ЮKassa (YOOKASSA_SHOP_ID/SECRET_KEY)',
      );
    }
    throw new ServiceUnavailableException('Онлайн-оплата ЮKassa ещё не подключена');
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
    const installed = this.config.vendorAmocrmStatusInstalled;
    if (pipelineId) payload.pipeline_id = pipelineId;
    if (installed) payload.status_id = installed;

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
