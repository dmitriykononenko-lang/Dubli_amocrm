import { z } from 'zod';

/** Схема переменных окружения. Приложение не стартует при невалидной конфигурации. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'verbose', 'debug', 'log', 'warn', 'error', 'fatal']).default('log'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  DATABASE_SSL: z.coerce.boolean().default(true),

  // Мастер-ключ AES-256-GCM: ровно 32 байта в base64.
  TOKEN_ENC_KEY: z.string().refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'TOKEN_ENC_KEY должен декодироваться из base64 ровно в 32 байта'),
  KMS_PROVIDER: z.enum(['env', 'selectel']).default('env'),

  AMOCRM_CLIENT_ID: z.string().min(1, 'AMOCRM_CLIENT_ID обязателен'),
  AMOCRM_CLIENT_SECRET: z.string().min(1, 'AMOCRM_CLIENT_SECRET обязателен'),
  AMOCRM_REDIRECT_URI: z.string().url('AMOCRM_REDIRECT_URI должен быть URL'),

  WEBHOOK_SECURITY_KEY: z.string().optional(),
  AMOCRM_RATE_LIMIT_RPS: z.coerce.number().positive().default(7),
  // Период опроса очереди фоновых сканов (мс). 0 — фоновый процессор выключен.
  SCAN_POLL_MS: z.coerce.number().int().min(0).default(2000),

  DATABASE_URL_TEST: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Валидатор для @nestjs/config. Бросает понятную ошибку при невалидном окружении. */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Невалидная конфигурация окружения:\n${issues}`);
  }
  return parsed.data;
}
