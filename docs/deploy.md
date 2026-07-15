# Развёртывание Dubli

Система из трёх частей: **бэкенд** (NestJS + PostgreSQL), **виджет** (статические файлы
в amoCRM) и **приватная интеграция** amoCRM, связывающая их. Ниже — путь «с нуля до прод».

> **152-ФЗ.** Персональные данные должны храниться в РФ в защищённом сегменте. Для прода
> берите хостинг/БД в РФ (в ТЗ — Selectel «Облако ФЗ-152»): либо VM в РФ + managed
> PostgreSQL, либо ваш аттестованный сегмент. Встроенный контейнер PostgreSQL из
> `docker-compose.yml` — для стенда/демо.

## 0. Что нужно
- Сервер с публичным доменом и **HTTPS** (amoCRM ходит на бэкенд только по HTTPS).
- Docker + Docker Compose **или** Node.js ≥ 20 и PostgreSQL 16.
- Аккаунт amoCRM с правами администратора.

## 1. amoCRM: приватная интеграция
1. **амоМаркет → Разработчикам → Создать интеграцию** → тип **приватная**.
2. Доступ к API включён (у виджета `oauth: "Y"`).
3. **Ссылка для перенаправления (redirect_uri)** = `https://<домен>/oauth/callback`.
4. Сохранить, скопировать **ID интеграции** (`client_id`) и **секретный ключ** (`client_secret`).

## 2. Бэкенд — вариант A: Docker Compose (быстро)
```bash
git clone <repo> dubli && cd dubli
cp .env.example .env
# заполнить .env: POSTGRES_PASSWORD, TOKEN_ENC_KEY (openssl rand -base64 32),
#   AMOCRM_CLIENT_ID/SECRET, AMOCRM_REDIRECT_URI, WEBHOOK_SECURITY_KEY
docker compose up -d --build
```
Контейнер бэкенда при старте **идемпотентно применяет схему** (`db/schema.sql`) и слушает
`127.0.0.1:3000` (наружу — через nginx/TLS, шаг 4). Проверка: `curl http://127.0.0.1:3000/health`.

Для прод-БД: уберите сервис `db` из `docker-compose.yml`, задайте `DATABASE_URL`
(managed PostgreSQL) и `DATABASE_SSL=true`.

## 2. Бэкенд — вариант B: без Docker (systemd)
```bash
cd /opt/dubli/backend
npm ci && npm run build
cp .env.example .env    # заполнить (см. backend/.env.example)
DATABASE_URL='postgres://...' npm run db:apply       # или npm run db:apply:node (без psql)
# сервис:
sudo cp ../deploy/dubli-backend.service.example /etc/systemd/system/dubli-backend.service
sudo systemctl daemon-reload && sudo systemctl enable --now dubli-backend
```

### Переменные окружения (главное)
| Переменная | Значение |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL` | подключение к PostgreSQL; на проде SSL включён |
| `TOKEN_ENC_KEY` | `openssl rand -base64 32`; **не менять после запуска** (иначе токены не расшифруются) |
| `AMOCRM_CLIENT_ID` / `AMOCRM_CLIENT_SECRET` | из шага 1 |
| `AMOCRM_REDIRECT_URI` | `https://<домен>/oauth/callback` (точно как в интеграции) |
| `WEBHOOK_SECURITY_KEY` | длинный общий ключ; им авторизуются вебхуки и запросы виджета |
| `SCAN_POLL_MS` | период фонового сканера (2000; `0` — выключить) |

> **Ключ безопасности.** Бэкенд принимает `security_key` per-account
> (`accounts.settings.security_key`, приоритет) или общий `WEBHOOK_SECURITY_KEY` (фолбэк).
> Отдельного UI для per-account ключа пока нет — используйте один общий
> `WEBHOOK_SECURITY_KEY` и его же вписывайте в настройки виджета.

## 3. TLS / reverse-proxy
Поставьте nginx перед бэкендом (`deploy/nginx.conf.example`), сертификат — Let's Encrypt:
```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/dubli
# заменить dubli.example.com на ваш домен; включить сайт
sudo certbot --nginx -d <домен>
```

## 4. Вебхуки в amoCRM
В интеграции добавьте вебхуки на URL:
```
https://<домен>/webhooks/amo?security_key=<WEBHOOK_SECURITY_KEY>
```
События: **добавление / изменение / удаление** для **контактов, компаний, сделок**
(индекс дублей в реальном времени + авто-слияние по правилам).

## 5. Виджет: сборка и загрузка
```bash
python3 scripts/make_logos.py            # если папка widget/images пуста (нужен Pillow)
cd widget && zip -r ../dubli-widget.zip . && cd ..   # manifest.json должен быть в корне архива
```
Загрузите `dubli-widget.zip` на вкладке виджета интеграции и **установите** в аккаунт.

## 6. Настройки виджета
В окне настроек виджета заполните:
- **URL бэкенда** = `https://<домен>`
- **Ключ безопасности** = тот же `WEBHOOK_SECURITY_KEY`

## 7. Авторизация (OAuth)
Установка интеграции запускает OAuth: amoCRM редиректит на `/oauth/callback`, бэкенд
обменивает `code` на токены, **создаёт аккаунт** и шифрованно сохраняет токены (авто-refresh).
Это должно пройти **до** работы вебхуков/сканирования (они требуют существующий аккаунт).

## 8. Проверка
1. `GET https://<домен>/health` → ok.
2. Карточка контакта → плашка «Проверка дублей» показывает статус.
3. Настройки → **Массовая чистка** → «Сканировать»: прогресс идёт, база индексируется.
4. Два контакта с одним телефоном → в списке дублей видно совпадение; при правиле с
   `auto_merge` они сольются автоматически.

## Прод-эксплуатация
- **Бэкапы PostgreSQL** (данные + журнал объединений/снимки для отката).
- **`TOKEN_ENC_KEY`** хранить в секрет-менеджере; ротация — только с перевыдачей токенов.
- **Обновления схемы**: `db/schema.sql` идемпотентна — применяется повторно при деплое
  (в Docker — автоматически при старте бэкенда).
- Логи бэкенда: `docker compose logs -f backend` (или `journalctl -u dubli-backend`).
