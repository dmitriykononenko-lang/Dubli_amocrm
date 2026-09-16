import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SubscriptionsRepository } from './subscriptions.repository';
import { computeQuote, type PricingConfig, type Quote } from './billing.pricing';

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

  /** Эффективный тариф продукта (с фолбэком на глобальный env). */
  async pricing(product?: string | null): Promise<PricingConfig> {
    const global: PricingConfig = {
      pricePerUser: this.config.billingPricePerUser,
      minUsers: this.config.billingMinUsers,
    };
    const code = product ?? 'dubli';
    // 'dubli' всегда считается по глобальному тарифу — как до появления хаба.
    if (code === 'dubli') return global;
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
