import type { Provider } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigService } from '../../config/app-config.service';
import { PG_POOL } from './kysely.tokens';

// Примечание: node-postgres по умолчанию возвращает BIGINT (int8) строкой,
// поэтому точность account_id/amo_id сохраняется без доп. настройки парсеров.
export const pgPoolProvider: Provider = {
  provide: PG_POOL,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Pool =>
    new Pool({
      connectionString: config.databaseUrl,
      // Selectel managed PG требует TLS; локально выключаем флагом DATABASE_SSL=false.
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
      max: 10,
    }),
};
