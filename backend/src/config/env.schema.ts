import { z } from 'zod';

/**
 * Булев флаг из окружения. `z.coerce.boolean()` использовать НЕЛЬЗЯ: он приводит через
 * `Boolean(v)`, где любая непустая строка (в т.ч. "false", "0") даёт true — так DATABASE_SSL=false
 * молча включал бы TLS. Здесь строки разбираются по значению; настоящие boolean пропускаются как есть.
 */
const envBool = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
  }
  return v; // прочее — отдать z.boolean(), пусть падает с понятной ошибкой
}, z.boolean());

/**
 * Пустая строка из .env / docker-compose (напр. `VAR=`) → undefined, чтобы сработал
 * .default() и не падала .optional()-валидация (z.coerce.number('') = 0 иначе ломает).
 */
function emptyable<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema);
}

/** Схема переменных окружения. Приложение не стартует при невалидной конфигурации. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'verbose', 'debug', 'log', 'warn', 'error', 'fatal']).default('log'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  DATABASE_SSL: envBool.default(true),

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

  // Публичная (маркетплейс amoМаркет) интеграция — необязательна. Когда заданы оба
  // ключа, бэкенд принимает установки и с публичного OAuth-клиента (эндпоинт
  // /oauth/callback/public), не ломая приватную интеграцию.
  PUBLIC_AMOCRM_CLIENT_ID: z.string().optional(),
  PUBLIC_AMOCRM_CLIENT_SECRET: z.string().optional(),
  PUBLIC_AMOCRM_REDIRECT_URI: emptyable(z.string().url().optional()),

  WEBHOOK_SECURITY_KEY: z.string().optional(),
  AMOCRM_RATE_LIMIT_RPS: z.coerce.number().positive().default(7),
  // Период опроса очереди фоновых сканов (мс). 0 — фоновый процессор выключен.
  SCAN_POLL_MS: z.coerce.number().int().min(0).default(2000),

  // --- Биллинг / оплата (Этап 2) ---
  BILLING_PRICE_PER_USER: emptyable(z.coerce.number().positive().default(399)),
  BILLING_MIN_USERS: emptyable(z.coerce.number().int().positive().default(5)),
  // Аккаунт amoCRM Ko:agency, куда падают счёт-сделки. Достаточно указать один из:
  VENDOR_AMOCRM_ACCOUNT_ID: z.string().optional(),
  VENDOR_AMOCRM_SUBDOMAIN: z.string().optional(),
  // Долгосрочный токен доступа vendor-аккаунта (надёжнее OAuth: не зависит от
  // переустановки виджета). Задаётся вместе с VENDOR_AMOCRM_SUBDOMAIN.
  VENDOR_AMOCRM_TOKEN: z.string().optional(),
  // Выделенная воронка «Дубли — клиенты» и её этапы (необязательно; без них — сделка
  // создаётся в главной воронке без переходов по этапам, но примечания/задачи пишутся).
  VENDOR_AMOCRM_PIPELINE_ID: emptyable(z.coerce.number().int().positive().optional()),
  VENDOR_AMOCRM_STATUS_INSTALLED: emptyable(z.coerce.number().int().positive().optional()),
  VENDOR_AMOCRM_STATUS_REQUESTED: emptyable(z.coerce.number().int().positive().optional()),
  VENDOR_AMOCRM_STATUS_PAID: emptyable(z.coerce.number().int().positive().optional()),
  // ID кастом-поля КОМПАНИИ «ID аккаунта amo|kommo» клиента (у koagency = 1173679).
  VENDOR_AMOCRM_ACCOUNT_FIELD_ID: emptyable(z.coerce.number().int().positive().optional()),
  // ID кастом-поля КОМПАНИИ «Ссылка на аккаунт» (у koagency = 1195091) — пишем URL аккаунта клиента.
  VENDOR_AMOCRM_ACCOUNT_LINK_FIELD_ID: emptyable(z.coerce.number().int().positive().optional()),
  // ЮKassa (онлайн-оплата) — включается, когда заданы оба.
  YOOKASSA_SHOP_ID: z.string().optional(),
  YOOKASSA_SECRET_KEY: z.string().optional(),
  // Куда ЮKassa вернёт пользователя после оплаты.
  BILLING_RETURN_URL: emptyable(z.string().url().optional()),
  // Фискализация (54-ФЗ): при true в платёж добавляется чек (receipt) с позицией и
  // email покупателя. Магазины с онлайн-кассой без чека возвращают 400.
  YOOKASSA_FISCAL: emptyable(envBool.default(true)),
  // Ставка НДС в чеке: 1 = без НДС (УСН), 2 = 0%, 3 = 10%, 4 = 20%, 5 = 10/110, 6 = 20/120.
  YOOKASSA_VAT_CODE: emptyable(z.coerce.number().int().min(1).max(6).default(1)),

  // Вендор-админ: доступ к /vendor/billing/* (управление подписками клиентов).
  // Обязателен для vendor-роутов — без него они закрыты (401). Секрет, только в .env.
  VENDOR_ADMIN_TOKEN: z.string().optional(),
  // Пробный период виджета (дней от установки) — требование маркетплейса дать триал.
  BILLING_TRIAL_DAYS: emptyable(z.coerce.number().int().min(0).default(7)),
  // Льготный период после paid_till для трека «счёт» (банковский перевод юрлица идёт 1–3 дня).
  BILLING_INVOICE_GRACE_DAYS: emptyable(z.coerce.number().int().min(0).default(5)),
  // За сколько дней до paid_till пытаться списать карту (рекуррент, фаза 4).
  BILLING_RENEW_LEAD_DAYS: emptyable(z.coerce.number().int().min(0).default(3)),
  // Дни ретраев списания карты при неудаче (dunning, фаза 4). Список через запятую.
  BILLING_DUNNING_RETRIES: emptyable(z.string().default('1,3,5')),
  // За сколько дней до paid_till слать напоминание (фаза 3).
  BILLING_NOTIFY_LEAD_DAYS: emptyable(z.coerce.number().int().min(0).default(5)),
  // Вебхук уведомлений вендору (Telegram/incoming webhook) — опционально (фаза 3).
  BILLING_NOTIFY_TELEGRAM_WEBHOOK: z.string().optional(),

  // Вендор-панель /vendor/panel: логин оператора (роль billing_admin). Отдельно от
  // VENDOR_ADMIN_TOKEN (его в браузер не кладём). Пусто → вход по паролю выключен.
  BILLING_ADMIN_USER: z.string().optional(),
  BILLING_ADMIN_PASSWORD: z.string().optional(),
  // Секрет подписи сессионной cookie панели. Пусто → берём VENDOR_ADMIN_TOKEN.
  BILLING_ADMIN_SESSION_SECRET: z.string().optional(),

  // Авто-сверка поступлений по счетам (фаза 5, за фича-флагом). Провайдер-агностик:
  // банк/Adesk шлёт входящие платежи на /vendor/billing/webhook/bank-incoming, матчинг по
  // номеру счёта (DUB-…) из назначения. Выкл по умолчанию — старт с ручного/стадийного.
  BILLING_BANK_RECONCILE: emptyable(envBool.default(false)),

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
