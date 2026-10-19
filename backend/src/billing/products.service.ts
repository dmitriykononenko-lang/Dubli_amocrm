import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SubscriptionsRepository } from './subscriptions.repository';
import { computeQuote, type PricingConfig, type Quote } from './billing.pricing';

/** Код продукта по умолчанию — виджет «Дубли» (все старые вызовы без product). */
export const DEFAULT_PRODUCT = 'dubli';

/** Разрешённый продукт (строка реестра products или встроенный 'dubli'). */
export interface ResolvedProduct {
  code: string;
  name: string;
  /** Воронка сделок продукта в koagency (products.pipeline_id); null → глобальная VENDOR_AMOCRM_PIPELINE_ID. */
  pipelineId: number | null;
}

/**
 * Тарификация по продукту (мульти-продуктовый хаб). Эффективный тариф — из строки products
 * (price_per_user/min_users). Для продукта 'dubli' или когда значение в products = NULL —
 * фолбэк на глобальные BILLING_PRICE_PER_USER/BILLING_MIN_USERS (обратная совместимость Дубли).
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly repo: SubscriptionsRepository,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Нормализация кода продукта из внешнего ввода (тело запроса, metadata платежа ЮKassa):
   * trim + lower-case; пусто → 'dubli'. Валидность по реестру НЕ проверяется — см. resolve().
   */
  static normalizeCode(product?: string | null): string {
    const code = String(product ?? '')
      .trim()
      .toLowerCase();
    return code || DEFAULT_PRODUCT;
  }

  /**
   * Продукт для платёжного потока (checkout / счёт): 'dubli' всегда валиден (даже без строки
   * в реестре — сид может отсутствовать), остальные — только если есть в products и enabled.
   * Неизвестный/выключенный → 400, чтобы платёж не ушёл в ЮKassa с кодом, который некуда отнести.
   */
  async resolve(product?: string | null): Promise<ResolvedProduct> {
    const code = ProductsService.normalizeCode(product);
    const row = await this.repo.findProduct(code);
    if (code === DEFAULT_PRODUCT) {
      return { code, name: row?.name ?? 'Дубли', pipelineId: ProductsService.pipelineOf(row) };
    }
    if (!row) throw new BadRequestException(`Неизвестный продукт: ${code}`);
    if (!row.enabled) throw new BadRequestException(`Продукт отключён: ${code}`);
    return { code, name: row.name, pipelineId: ProductsService.pipelineOf(row) };
  }

  /**
   * Продукт из metadata уже проведённого платежа (вебхук ЮKassa). Деньги получены — платёж
   * надо учесть в любом случае, поэтому неизвестный код не отбрасываем: возвращаем его как есть
   * (имя = код, воронки нет), а вызывающая сторона пишет предупреждение в лог.
   */
  async resolveLenient(product?: string | null): Promise<ResolvedProduct & { known: boolean }> {
    const code = ProductsService.normalizeCode(product);
    const row = await this.repo.findProduct(code);
    if (row)
      return { code, name: row.name, pipelineId: ProductsService.pipelineOf(row), known: true };
    return {
      code,
      name: code === DEFAULT_PRODUCT ? 'Дубли' : code,
      pipelineId: null,
      known: code === DEFAULT_PRODUCT,
    };
  }

  private static pipelineOf(row?: { pipeline_id?: string | number | null } | null): number | null {
    if (row?.pipeline_id == null || row.pipeline_id === '') return null;
    const n = Number(row.pipeline_id);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Эффективный тариф продукта (с фолбэком на глобальный env). */
  async pricing(product?: string | null): Promise<PricingConfig> {
    const global: PricingConfig = {
      pricePerUser: this.config.billingPricePerUser,
      minUsers: this.config.billingMinUsers,
    };
    const code = ProductsService.normalizeCode(product);
    // 'dubli' всегда считается по глобальному тарифу — как до появления хаба.
    if (code === DEFAULT_PRODUCT) return global;
    const row = await this.repo.findProduct(code);
    if (!row) return global;
    return {
      pricePerUser: row.price_per_user != null ? Number(row.price_per_user) : global.pricePerUser,
      minUsers: row.min_users != null ? Number(row.min_users) : global.minUsers,
    };
  }

  /** Котировка суммы по тарифу продукта. */
  async quote(users: number, months: number, product?: string | null): Promise<Quote> {
    return computeQuote(users, months, await this.pricing(product));
  }
}
