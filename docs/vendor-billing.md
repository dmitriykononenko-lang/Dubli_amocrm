# Вендор-управление подписками (`/vendor/billing/*`)

Виджет «Дубли» в amoМаркете — **«Внешняя оплата»**: amoCRM не хранит «оплачено до».
Источник истины — наш бэкенд (`subscriptions.paid_till`). Эти эндпоинты дают вендору
(Ko:agency) посмотреть/продлить/приостановить подписки клиентов.

## Доступ
Все запросы — с заголовком `X-Vendor-Token: $VENDOR_ADMIN_TOKEN` (из `.env`, в git не
коммитится). Без валидного токена — `401`. Если `VENDOR_ADMIN_TOKEN` не задан, роуты закрыты.

```bash
BASE=https://dubli.koagency.ru
TOK='X-Vendor-Token: <VENDOR_ADMIN_TOKEN>'
```

## Модель
- `status`: `trial` (идёт пробный период) · `active` (оплачено) · `past_due` (истекло) · `canceled` (приостановлено вендором).
- Доступ виджета разрешён, если `now ≤ paid_till` ИЛИ `now ≤ trial_ends_at`, и подписка не `canceled`.
- Оплата (ЮKassa/счёт) продлевает `paid_till` от текущей даты, если подписка активна, иначе от `now`. Идемпотентно по `payment_id`.

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

## Заметки
- Все мутации пишутся в таблицу `payments` (источник `manual` для ручных, `yookassa`/`invoice` для оплат) с `reason`/`actor` — это аудит.
- Оплата по счёту подтверждается вручную через `extend` (`add_months` или точная дата) — так дата продления и история остаются в одном месте.
- `payments.payment_id` уникален → повторный вебхук ЮKassa не продлевает дважды.
