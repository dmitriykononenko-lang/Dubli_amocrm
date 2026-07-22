import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { BillingService } from '../billing/billing.service';

/**
 * Разовый бэкфилл vendor-сделок для уже установленных аккаунтов (у кого нет
 * сделки или она удалена). Идемпотентно. Запуск на сервере:
 *   docker compose exec backend node dist/scripts/backfill-vendor-deals.js
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const res = await app.get(BillingService).backfillVendorDeals();
    Logger.log(
      `Готово: создано ${res.created}, пропущено ${res.skipped}, ошибок ${res.failed}`,
      'Backfill',
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  Logger.error(e instanceof Error ? (e.stack ?? e.message) : String(e), undefined, 'Backfill');
  process.exit(1);
});
