# Вендор-управление подписками (`/vendor/billing/*`)

Виджет «Дубли» в amoМаркете — **«Внешняя оплата»**: amoCRM не хранит «оплачено до».
Источник истины — наш бэкенд (`subscriptions.paid_till`). Эти эндпоинты дают вендору
(Ko:agency) посмотреть/продлить/приостановить подписки клиентов.

## Мульти-продуктовый хаб
Бэкенд ведёт подписки по нескольким нашим виджетам. Реестр — таблица `products`
(`code`/`name`/`price_per_user`/`min_users`/`pipeline_id`/`enabled`), сид — `dubli` («Дубли»).
У `subscriptions`/`payments`/`invoices` есть поле `product` (по умолчанию `dubli`). Панель
показывает колонку и фильтр «Продукт». Список продуктов: `GET /vendor/billing/products`.
Один аккаунт может иметь **несколько** продуктов — подписка адресуется составным ключом
**`(account_id, product)`** (PK `subscriptions`). Методы биллинга принимают `product`
с дефолтом `dubli`, поэтому существующие вызовы Дубли не меняются.

**Пер-продуктовый прайсинг.** Эффективный тариф продукта берётся из строки `products`
(`price_per_user`/`min_users`). Если значение `NULL` или продукт — `dubli`, действует фолбэк
на глобальный `BILLING_PRICE_PER_USER`/`BILLING_MIN_USERS`. По этому тарифу считается сумма
счёта и рекуррентное списание карты для подписки соответствующего продукта.

## Панель оператора (`/vendor/panel`)
Веб-панель для оператора: список подписок с фильтрами (продукт, статус, срок ≤ 7/14/30 дн,
поиск по субдомену, «ожидают оплаты по счёту»), карточка с историей платежей/счетов, кнопки
продлить / стоп / снять / отметить счёт оплаченным / auto-renew.

Вход: `BILLING_ADMIN_USER` / `BILLING_ADMIN_PASSWORD` (в `.env`). После логина ставится
HttpOnly-cookie (подписана `BILLING_ADMIN_SESSION_SECRET`, фолбэк — `VENDOR_ADMIN_TOKEN`),
роль `billing_admin`. `VENDOR_ADMIN_TOKEN` в браузер не попадает — панель ходит на
`/vendor/billing/*` по cookie. Открыть: `https://dubli.koagency.ru/vendor/panel`.

## Доступ к API
`/vendor/billing/*` принимает **либо** заголовок `X-Vendor-Token: $VENDOR_ADMIN_TOKEN`
(curl/автоматизация), **либо** сессионную cookie панели (браузер). Иначе — `401`.

```bash
BASE=https://dubli.koagency.ru
TOK='X-Vendor-Token: <VENDOR_ADMIN_TOKEN>'
```

## Модель
Два трека продления в одной модели (`subscriptions.payment_method`):
- **card** (ЮKassa: карта/СБП/ЮMoney) — рекуррент: карта сохраняется при первом онлайн-платеже (`save_payment_method`), затем планировщик за `BILLING_RENEW_LEAD_DAYS` дней до `paid_till` делает безакцептное списание. При неудаче — dunning (ретраи `BILLING_DUNNING_RETRIES`, напр. 1/3/5 дней, статус `past_due` с grace до следующего ретрая; по исчерпании — `canceled`, `auto_renew` off).
- **invoice** (счёт юрлицу, банковский перевод) — авто-списания нет; продление после подтверждения поступления, с льготным периодом `grace_until = paid_till + BILLING_INVOICE_GRACE_DAYS`.

Списание идемпотентно: `Idempotence-Key = recur:<accountId>:<paid_till>:<attempt>` на стороне ЮKassa + `payments.payment_id` UNIQUE — двойного списания/продления нет.

`status`: `trial` (пробный) · `active` (оплачено) · `awaiting_invoice_payment` (счёт выставлен, ждём оплату) · `past_due` (истекло) · `canceled` (приостановлено вендором).

**Гейтинг доступа**: разрешён, если подписка не `canceled` И (`now ≤ paid_till` ИЛИ `now ≤ grace_until` ИЛИ `now ≤ trial_ends_at`).

**Продление**: `paid_till = max(now, paid_till) + months` (от текущей даты, если активна, иначе от `now`). Идемпотентно по `payment_id` (для счёта — `invoice:<number>`).

## Эндпоинты

### Список подписок
Фильтры: `query` (по субдомену), `status`, `expiring_in_days` (истекают в ближайшие N дней), `limit`, `offset`. Сортировка по `paid_till`.
```bash
curl -s -H "$TOK" "$BASE/vendor/billing/subscriptions?status=active&expiring_in_days=14&limit=50"
# → [{ subdomain, accountId, status, users, months, paidTill, trialEndsAt, lastAmount, daysLeft }, ...]
```

### Карточка клиента + история платежей
```bash
curl -s -H "$TOK" "$BASE/vendor/billing/subscriptions/clientco"
# → { subdomain, accountId, allowed, status, paidTill, trialEndsAt, daysLeft, payments:[...] }
```

### Продлить / выставить дату вручную
Тело — одно из двух: точная дата `paid_till` ИЛИ `add_months`. `reason` попадает в историю.
Опц. `product` (дефолт `dubli`) — для аккаунтов с несколькими продуктами. То же (`product`)
принимают `suspend`/`resume`/`auto-renew`.
```bash
# Точная дата
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' \
  -d '{"paid_till":"2026-12-31T23:59:59Z","reason":"промо-продление"}' \
  "$BASE/vendor/billing/subscriptions/clientco/extend"

# Добавить N месяцев (от текущей даты продления)
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' \
  -d '{"add_months":3,"reason":"оплата по счёту №123"}' \
  "$BASE/vendor/billing/subscriptions/clientco/extend"
# → { paidTill, duplicate }
```

### Приостановить (закрыть доступ)
```bash
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' \
  -d '{"reason":"неоплата"}' \
  "$BASE/vendor/billing/subscriptions/clientco/suspend"
# → { ok: true }   (status=canceled, доступ виджета закрыт)
```

### Снять приостановку
`active`, если `paid_till` в будущем, иначе `past_due`.
```bash
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' -d '{}' \
  "$BASE/vendor/billing/subscriptions/clientco/resume"
# → { status }
```

### Авто-продление карты (вкл/выкл)
```bash
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' -d '{"enabled":false}' \
  "$BASE/vendor/billing/subscriptions/clientco/auto-renew"
# → { autoRenew }
```

## Распределение платежей ЮKassa по продукту (платёжный код)
Один магазин ЮKassa обслуживает все виджеты хаба. Платёж относится к подписке `(account_id, product)`
по **коду продукта в `metadata.product`** платежа — это и есть платёжный код:

- `POST /api/billing/checkout` и `POST /api/billing/invoice-request` принимают `product` (код из
  реестра `products`; пусто → `dubli`). Код нормализуется (trim, нижний регистр) и проверяется по
  реестру: неизвестный или `enabled=false` → `400`, платёж в ЮKassa не создаётся. Сумма считается по
  тарифу продукта (`price_per_user`/`min_users`, для `dubli` — глобальный env), в описании платежа —
  имя продукта. `GET /api/billing?users=&months=&product=` — предварительный расчёт по тому же тарифу.
- В платёж ЮKassa уходит `metadata: { accountId, product, users, months }`; рекуррент кладёт тот же
  `product` (плюс `recurrent: true`).
- Вебхук `POST /api/billing/yookassa/webhook` перепроверяет платёж по API и читает `metadata.product`:
  продление идёт в подписку этого продукта (`recordPayment({ product })`), платёж пишется в `payments`
  с `product`. Без `metadata.product` (платежи, созданные до хаба) → `dubli`. Неизвестный код → платёж
  **всё равно учитывается** (деньги получены; в панели виден по `product`) с предупреждением в логе,
  но сделку в koagency для него не трогаем — ручной разбор.
- `settings.paid_until` («Оплачено до» в виджете «Дубли») зеркалится только для `dubli`.
- Сделка клиента в koagency — **своя на каждый продукт**: у «Дублей» id хранится в
  `settings.vendor_lead_id` (как раньше), у остальных — в `settings.vendor_leads[<product>]`. Сделка
  создаётся в воронке продукта `products.pipeline_id` (фолбэк — `VENDOR_AMOCRM_PIPELINE_ID`), этапы
  «установлен / запрошен счёт / оплачен» ищутся по названию; явные `VENDOR_AMOCRM_STATUS_*` из `.env`
  относятся только к глобальной воронке. Компания клиента (с полем «ID аккаунта amo») одна на аккаунт и
  привязывается к сделке каждого продукта.
- Номер счёта (трек invoice) начинается с платёжного кода продукта: `DUB-…` для «Дублей», для остальных —
  первые три латинские буквы кода (`raspredelenie` → `RAS-…`). Авто-сверка по банку матчит номера вида
  `XXX-<account_id>-<суффикс>` для любого продукта.

Чтобы подключить продукт к оплате: добавить строку в `products` (`code`, `name`, тариф, `pipeline_id`
воронки в koagency, `enabled=true`) и передавать `product` из виджета в `/api/billing/*`. Ничего в `.env`
менять не нужно — магазин и вебхук ЮKassa общие.

## Ingest для бэкендов других виджетов
`POST /vendor/billing/ingest` — единая точка, которой бэкенды других наших виджетов
регистрируют/продлевают подписку в хабе. Авторизация — тот же `X-Vendor-Token`.

Тело:
```jsonc
{
  "subdomain": "clientco",         // обязателен для регистрации аккаунта / матчинга
  "account_id": "778",             // если задан — upsert аккаунта (account_id+subdomain+installed_at)
  "product": "raspredelenie",      // код продукта (дефолт 'dubli')
  "action": "ensure",              // ensure | extend | paid
  "users": 5,                      // опц.
  "months": 6,                     // для extend/paid без точной даты
  "paid_till": "2027-06-30T00:00:00Z", // для extend точной датой
  "amount": 17700,                 // опц., в аудит
  "payment_id": "ext-1",           // ключ идемпотентности (payments.payment_id UNIQUE)
  "source": "raspredelenie-backend" // метка источника → actor `ingest:<source>`
}
// → { ok, accountId, product, action, paidTill, duplicate }
```

Логика:
- `account_id` задан → `accounts` upsert (регистрация внешнего виджета); иначе аккаунт матчится по `subdomain`.
- Гарантируется подписка на `(account_id, product)` (триал от установки — как у Дубли).
- `action=ensure` — только подписка, без платежа.
- `action=extend`/`paid` — продление: по `paid_till` (точная дата) ЛИБО по `months`. Всё пишется
  в `payments` с `source`/`reason`/`actor` (аудит). **Идемпотентно** по `payment_id`: повтор с тем же
  `payment_id` не продлевает второй раз (`duplicate: true`).

```bash
# Регистрация + оплата на 6 мес (идемпотентно по payment_id)
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' \
  -d '{"subdomain":"clientco","account_id":"778","product":"raspredelenie","action":"paid","months":6,"amount":17700,"payment_id":"ext-1","source":"raspredelenie-backend"}' \
  "$BASE/vendor/billing/ingest"
# → { ok:true, accountId:"778", product:"raspredelenie", action:"paid", paidTill:"...", duplicate:false }
```

## Трек «счёт» — подтверждение оплаты
«Запросить счёт» из виджета создаёт запись `invoices` с уникальным **номером** `DUB-<accountId>-<...>` (его клиент указывает в назначении платежа), сделку-счёт в koagency и переводит подписку в `awaiting_invoice_payment`. Продление — после подтверждения поступления.

**Основной путь — по стадии сделки (оператор только двигает стадию):**
в koagency настроить вебхук смены стадии сделки (для каждой воронки продукта) на
`https://dubli.koagency.ru/vendor/billing/webhook/amocrm-paid?key=<WEBHOOK_SECURITY_KEY>`.
Когда сделка-счёт уходит в стадию «Оплачен» (`VENDOR_AMOCRM_STATUS_PAID`), бэкенд находит счёт по `vendor_deal_id`, помечает `paid`, продлевает `paid_till` и выставляет grace.

**Fallback — вручную по номеру:**
```bash
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' -d '{"actor":"operator"}' \
  "$BASE/vendor/billing/invoices/DUB-33022710-ABCDEF/mark-paid"
# → { ok, paidTill, alreadyPaid }   (повторный вызов на оплаченном счёте — alreadyPaid:true, без двойного продления)
```
Матчинг — только по номеру счёта (не по сумме: у разных клиентов суммы совпадают). Непонятное поступление/не тот номер → ручной разбор.

## Напоминания и статусы (планировщик)
Фоновый планировщик (каждые 6 ч, без внешнего cron) делает:
- помечает просроченные (`paid_till`/`grace_until`/`trial_ends_at` в прошлом) → `past_due`;
- шлёт напоминания об истечении за `BILLING_NOTIFY_LEAD_DAYS` дней до `paid_till`
  (карта: «спишем автоматически», счёт: «пришлём новый счёт»), по одному разу на
  предыстечное окно. Канал — `POST { text }` на `BILLING_NOTIFY_TELEGRAM_WEBHOOK`
  (или лог, если вебхук не задан).

## Авто-сверка по банку (фаза 5, за фича-флагом)
`BILLING_BANK_RECONCILE=true` включает провайдер-агностик приём поступлений: банк
(Т-Банк/Точка) или Adesk шлёт входящие платежи на
`POST /vendor/billing/webhook/bank-incoming?key=<WEBHOOK_SECURITY_KEY>`
(тело — массив, `{payments:[…]}` или один объект; поля `amount/purpose/id` в разных
именах поддержаны). Матчинг — **только по номеру счёта** `DUB-…` из назначения; найден →
`markInvoicePaid`; не найден/ошибка → возвращаются в `unmatched` для ручного разбора.
Идемпотентно (mark-paid по номеру). Выкл по умолчанию — старт с ручного/стадийного.

## Заметки
- Все мутации пишутся в `payments` (источник `manual`/`yookassa`/`invoice`) с `reason`/`actor` — аудит.
- `payments.payment_id` уникален → повторный вебхук (карта/стадия счёта/сверка) не продлевает дважды.
