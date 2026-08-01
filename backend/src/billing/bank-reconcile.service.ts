import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SubscriptionsService } from './subscriptions.service';

/** Одно входящее поступление (нормализованное из формата банка/Adesk). */
export interface IncomingPayment {
  amount?: number;
  purpose?: string;
  externalId?: string;
}

export interface ReconcileResult {
  matched: string[];
  unmatched: Array<{ externalId?: string; purpose?: string; amount?: number; reason: string }>;
}

/**
 * Авто-сверка поступлений по счетам (фаза 5, за фича-флагом BILLING_BANK_RECONCILE).
 * Провайдер-агностик: банк/Adesk/выписка присылают входящие платежи, матчинг — ТОЛЬКО по
 * номеру счёта (DUB-…) из назначения (не по сумме: у разных клиентов суммы совпадают).
 * Непонятные/несматченные — в ручной разбор (возвращаем списком). Идемпотентно (mark-paid).
 */
@Injectable()
export class BankReconcileService {
  private readonly log = new Logger('BankReconcile');
  private static readonly NUM_RE = /DUB-\d+-[0-9A-Z]+/i;

  constructor(
    private readonly subs: SubscriptionsService,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.billingBankReconcile;
  }

  /** Извлечь номер счёта из назначения платежа. null, если не найден. */
  extractNumber(purpose: string): string | null {
    const m = BankReconcileService.NUM_RE.exec(purpose ?? '');
    return m ? m[0].toUpperCase() : null;
  }

  async reconcile(items: IncomingPayment[]): Promise<ReconcileResult> {
    const matched: string[] = [];
    const unmatched: ReconcileResult['unmatched'] = [];
    for (const it of items) {
      const number = this.extractNumber(it.purpose ?? '');
      if (!number) {
        unmatched.push({ ...it, reason: 'номер счёта не найден в назначении' });
        continue;
      }
      try {
        const res = await this.subs.markInvoicePaid(number, { actor: 'bank-reconcile' });
        matched.push(number);
        if (res.alreadyPaid) this.log.log(`Счёт ${number}: уже оплачен (повторное поступление)`);
        else this.log.log(`Счёт ${number}: подтверждён по банковскому поступлению`);
      } catch (e) {
        unmatched.push({ ...it, reason: `счёт ${number}: ${String(e)}` });
        this.log.warn(`Сверка: ${number} — ${String(e)}`);
      }
    }
    if (unmatched.length) this.log.warn(`Сверка: не сматчено ${unmatched.length} поступлений (ручной разбор)`);
    return { matched, unmatched };
  }
}
