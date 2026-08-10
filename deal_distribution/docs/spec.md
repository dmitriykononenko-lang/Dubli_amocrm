# Распределение сделок — спецификация backend

Виджет (фронтенд) — это конфигуратор + панель в карточке. Само распределение делает
**backend**: принимает вебхук amoCRM на создание сделки, выбирает менеджера по стратегии
и проставляет `responsible_user_id` через API v4.

Backend переиспользует каркас из соседних проектов (NestJS + OAuth amoCRM + Postgres).

## 1. HTTP-контракт (виджет ↔ backend)

Общие правила (как в hidden_field):
- `account_id` — всегда в query, читается guard-ом.
- Ключ — в заголовке `X-Security-Key` (совпадает с `API_SECURITY_KEY`).
- Ответы — JSON.

| Метод | Путь | Назначение | Ответ |
|---|---|---|---|
| GET | `/api/meta` | справочники аккаунта | `{ users:[{id,name}], pipelines:[{id,name}] }` |
| GET | `/api/config` | текущие настройки | `{ pool, strategy, scope, skip_absent, rules, sla }` |
| POST | `/api/config` | сохранить настройки | `{ ok:true }` |
| GET | `/api/assignment?lead_id=` | инфо по назначению сделки | `{ user_id, user_name, assigned_at, reason, strategy }` или `404` |
| POST | `/api/assignment/reassign` `{lead_id}` | ручное переназначение | `{ user_id, user_name, ... }` |
| POST | `/api/webhooks/amocrm/:secret` | приём вебхуков amoCRM | `200` |

`config` (то, что шлёт виджет):
```json
{
  "pool": ["100","101"],
  "strategy": "round_robin",           // round_robin | by_load | by_rules
  "scope": ["7"],                       // id воронок; пусто = все
  "skip_absent": true,
  "rules": [                            // для by_rules; проверяются по порядку
    { "field": "source", "value": "Авито", "user_id": "100" },
    { "field": "budget_gt", "value": "100000", "user_id": "101" }
  ],
  "sla": { "enabled": true, "minutes": 15 }
}
```
Поля правил: `source` | `pipeline` | `budget_gt` | `tag`.

## 2. Алгоритм распределения

При создании сделки (вебхук `leads[add]`):

1. Если воронка сделки не входит в `scope` (и scope не пуст) → выход.
2. Собрать список кандидатов = `pool` ∩ активные пользователи; если `skip_absent` — убрать
   тех, кто вне рабочего графика/оффлайн (данные из amoCRM `users` + график, этап 2).
3. Выбрать менеджера по стратегии:
   - **round_robin** — курсор `rr_cursor` на аккаунт: следующий по кругу кандидат, курсор++
     (атомарно, транзакцией — не выдать двоим одну очередь при гонке).
   - **by_load** — для каждого кандидата посчитать число открытых сделок
     (`GET /leads?filter[responsible_user_id]=…&filter[statuses]` без закрытых), взять минимум;
     при равенстве — round_robin как tie-breaker.
   - **by_rules** — первое правило, чьё условие истинно (`source`=UTM/поле источника,
     `pipeline`=id воронки, `budget_gt`=цена сделки больше, `tag`=есть тег), назначает
     `user_id`; если ни одно не сработало — fallback на round_robin по `pool`.
4. `PATCH /api/v4/leads/{id}` c `{ responsible_user_id }`. Записать назначение в БД
   (`lead_id, user_id, strategy, reason, assigned_at`) — для панели карточки и SLA.

**SLA-переназначение** (если `sla.enabled`): отложенная задача через `sla.minutes`; если
статус сделки не изменился и ответственный тот же (не «взял») — переназначить следующему по
кругу и записать причину.

## 3. Безопасность вебхуков (важно!)

По документации amoCRM **обычные вебхуки и вебхуки Digital Pipeline НЕ подписываются**.
Поэтому:
- защищаем эндпойнт **секретным путём** `/api/webhooks/amocrm/:secret` (secret хранится в БД
  на аккаунт, генерится при установке);
- дополнительно проверяем `account[id]` из тела вебхука против известных аккаунтов;
- rate-limit и идемпотентность по `lead_id` (не переназначать одну сделку повторно на add).

Подпись (HMAC-SHA1) актуальна только для Chats API — здесь не используется.

## 4. Модель данных (Postgres)

```
dd_config(account_id PK, config JSONB, updated_at)
dd_assignment(account_id, lead_id, user_id, strategy, reason, assigned_at, PRIMARY KEY(account_id, lead_id))
dd_rr_cursor(account_id PK, cursor INT)          -- позиция round-robin
dd_webhook_secret(account_id PK, secret)         -- секретный путь вебхука
```

## 5. Ограничения amoCRM API (учесть)

- ~7 запросов/с **на IP**; батч максимум 250 (рекомендуется 50).
- OAuth: access 24 ч, refresh 3 мес, refresh ротирует обе токены.
- `by_load` может быть тяжёлым при большом пуле — кэшировать счётчики (TTL ~60 c).

## 6. Этапность

- **Этап 1 (этот виджет)** — фронтенд: конфигуратор + панель карточки + контракт. ✅
- **Этап 2** — backend: `/api/meta|config|assignment`, вебхук, round_robin + by_rules.
- **Этап 3** — by_load, SLA-переназначение, учёт графика/онлайна, аудит и откат.
