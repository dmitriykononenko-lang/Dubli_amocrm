# Вендор-управление подписками (`/vendor/billing/*`)

Виджет «Дубли» в amoМаркете — **«Внешняя оплата»**: amoCRM не хранит «оплачено до».
Источник истины — наш бэкенд (`subscriptions.paid_till`). Эти эндпоинты дают вендору
(Ko:agency) посмотреть/продлить/приостановить подписки клиентов.

## Панель оператора (`/vendor/panel`)
Веб-панель для оператора: список подписок с фильтрами (статус, срок ≤ 7/14/30 дн, поиск по
субдомену, «ожидают оплаты по счёту»), карточка с историей платежей/счетов, кнопки
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
- **card** (ЮKassa: карта/СБП/ЮMoney) — рекуррент (авто-списание, фаза 4). Без grace.
- **invoice** (счёт юрлицу, банковский перевод) — авто-списания нет; продление после подтверждения поступления, с льготным периодом `grace_until = paid_till + BILLING_INVOICE_GRACE_DAYS`.

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
```bash
# Точная дата
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' \
  -d '{"paid_till":"2026-12-31T23:59:59Z","reason":"промо-продление"}' \
  "$BASE/vendor/billing/subscriptions/clientco/extend"

# Добавить N месяцев (от текущей даты продления)
curl -s -X POST -H "$TOK" -H 'Content-Type: application/json' \
  -d '{"add_months":3,"reason":"оплата по счёту №123"}' \
  "$BASE/vendor/billing/subscriptions/clientco/extend"
# → { paidTill }
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

## Трек «счёт» — подтверждение оплаты
«Запросить счёт» из виджета создаёт запись `invoices` с уникальным **номером** `DUB-<accountId>-<...>` (его клиент указывает в назначении платежа), сделку-счёт в koagency и переводит подписку в `awaiting_invoice_payment`. Продление — после подтверждения поступления.

**Основной путь — по стадии сделки (оператор только двигает стадию):**
в koagency настроить вебхук смены стадии сделки на
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

## Заметки
- Все мутации пишутся в `payments` (источник `manual`/`yookassa`/`invoice`) с `reason`/`actor` — аудит.
- `payments.payment_id` уникален → повторный вебхук (карта или стадия счёта) не продлевает дважды.
- Дальнейшие фазы: карта-рекуррент+dunning (фаза 4), авто-сверка по банку (фаза 5).
