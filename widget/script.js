/**
 * Виджет «Поиск и объединение дублей» для amoCRM (Этап 3: проверка дублей).
 *
 * Назначение: находить и объединять дубликаты контактов, компаний и сделок.
 *   - в карточке сделки/контакта/компании рисуется плашка «Проверка дублей»:
 *     при настроенном бэкенде делает запрос GET {backend_url}/api/duplicates и
 *     показывает результат («проверяем…» → «найдено N» / «дублей не найдено»);
 *     кнопка «Открыть» показывает список возможных дублей в модалке;
 *   - экран настроек содержит статический скелет секций (сущности, правила
 *     поиска, нормализация, права на объединение, запрет дублей).
 *
 * Объединение дублей пока недоступно (кнопка «Объединить» неактивна): движок
 * слияния на бэкенде — следующий слой. Все строки берутся из i18n через t().
 *
 * UX-паттерны (AMD-конструктор, callbacks, render_template, модалки поверх
 * lib/components/base/modal, инлайн-стиль с меткой сборки) повторяют
 * отлаженный виджет «Шаблоны задач».
 */
define(['jquery', 'lib/components/base/modal'], function ($, Modal) {
  var CustomWidget = function () {
    var self = this;

    var STYLE_ID = 'dub-styles';
    // Метка сборки — видна в data-v элемента стилей, нужна для диагностики,
    // что в браузере загружена актуальная версия скрипта
    var WIDGET_BUILD = '2026-07-22.9';

    // Сопоставление области карточки (system().area) с типом сущности API v4
    var AREA_ENTITY = [
      { prefix: 'lcard', entity: 'leads' },
      { prefix: 'ccard', entity: 'contacts' },
      { prefix: 'comcard', entity: 'companies' }
    ];

    // Тариф (по умолчанию как у конкурентов; итог считает бэкенд, здесь — только показ).
    // months — срок подписки, pay — сколько месяцев оплачивается (разница = бонус).
    var BILLING = {
      pricePerUser: 399,
      minUsers: 5,
      plans: [
        { id: '6', months: 6, pay: 6 },
        { id: '12', months: 12, pay: 10 }
      ]
    };

    /* ------------------------------ локализация ------------------------------ */

    function t(key, fallback) {
      var node = self.langs || {};
      var parts = key.split('.');
      for (var i = 0; i < parts.length; i++) {
        if (node && typeof node === 'object' && parts[i] in node) {
          node = node[parts[i]];
        } else {
          return fallback;
        }
      }
      return typeof node === 'string' ? node : fallback;
    }

    /* --------------------------------- утилиты -------------------------------- */

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function safeArea() {
      try {
        return String((self.system() || {}).area || '');
      } catch (e) {
        return '';
      }
    }

    // Определяем сущность и id открытой карточки по area + URL-фолбэк.
    // lcard → leads, ccard → contacts, comcard → companies.
    function detectEntity() {
      var area = safeArea();

      var entity = null;
      for (var i = 0; i < AREA_ENTITY.length; i++) {
        if (area.indexOf(AREA_ENTITY[i].prefix) === 0) {
          entity = AREA_ENTITY[i].entity;
          break;
        }
      }

      var id = null;
      try {
        id = parseInt((AMOCRM.data.current_card || {}).id, 10) || null;
      } catch (e) { /* возьмём id из URL */ }

      var match = window.location.pathname.match(/\/(leads|contacts|companies)\/detail\/(\d+)/);
      if (match) {
        if (!entity) {
          entity = match[1];
        }
        if (!id) {
          id = parseInt(match[2], 10);
        }
      }

      return entity && id ? { type: entity, id: id } : null;
    }

    /* --------------------------------- стили --------------------------------- */

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) {
        return;
      }
      var css = [
        /* блок в карточке */
        '.dub{padding:4px 0}',
        /* полноширинный баннер в шапке блока: отрицательные поля компенсируют */
        /* паддинг тела виджета — полоса идёт во всю ширину */
        '.dub__banner{display:flex;align-items:center;justify-content:center;gap:8px;margin:0 -16px 12px;padding:12px 14px;background:#2b7de9;color:#fff;font-weight:bold;font-size:15px;letter-spacing:2px}',
        '.dub__banner svg{display:block;flex-shrink:0}',
        '.dub__status{display:flex;align-items:center;gap:8px;font-size:13px;color:#313942;margin-bottom:10px}',
        '.dub__status svg{flex-shrink:0}',
        '.dub__status_ok{color:#1f9d57}',
        '.dub__status_found{color:#e0a500}',
        '.dub__status_error{color:#e05c5c}',
        '.dub__actions{display:flex;gap:8px}',
        '.dub__btn{flex:1;box-sizing:border-box;padding:8px 10px;border:1px solid #d4d7da;border-radius:3px;background:#fff;color:#313942;font-size:13px;cursor:pointer;text-align:center}',
        '.dub__btn:hover:not(:disabled){background:#f5f6f7}',
        '.dub__btn:disabled{opacity:.5;cursor:default}',
        '.dub__btn_primary{background:#d22730;border-color:#d22730;color:#fff}',
        '.dub__btn_primary:hover:not(:disabled){background:#b31f27;border-color:#b31f27}',
        /* всплывающее уведомление */
        '.dub-toast{position:fixed;left:20px;bottom:20px;max-width:480px;z-index:999999;background:#313942;color:#fff;padding:10px 16px;border-radius:4px;font-size:13px;line-height:18px;opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}',
        '.dub-toast_visible{opacity:1;transform:translateY(0)}',
        '.dub-toast_error{background:#e05c5c}',
        /* модальные окна */
        '.dub-modal{padding:25px 30px;box-sizing:border-box}',
        '.dub-modal__title{font-size:18px;color:#313942;margin:0 0 18px;font-weight:normal}',
        /* список возможных дублей в модалке */
        '.dub-dups{max-height:50vh;overflow:auto}',
        '.dub-dups__item{padding:8px 0;border-bottom:1px solid #eef1f4}',
        '.dub-dups__item:last-child{border-bottom:none}',
        '.dub-dups__link{color:#2b7de9;text-decoration:none;font-size:14px}',
        '.dub-dups__link:hover{text-decoration:underline}',
        '.dub-dups__id{color:#92989b;font-size:12px;margin-left:6px}',
        '.dub-dups__keys{font-size:12px;color:#62696e;margin-top:3px}',
        '.dub-dups__head{display:flex;align-items:center;gap:8px}',
        '.dub-dups__merge{margin-left:auto;flex:0 0 auto;padding:5px 10px;font-size:12px}',
        /* подтверждение объединения */
        '.dub-confirm__text{font-size:13px;color:#313942;line-height:18px;margin-bottom:10px}',
        '.dub-confirm__opts{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}',
        '.dub-confirm__opt{display:flex;align-items:center;gap:8px;font-size:13px;color:#313942;padding:8px 10px;border:1px solid #e2e4e7;border-radius:4px;cursor:pointer}',
        '.dub-confirm__actions{margin-top:4px}',
        /* скелет настроек */
        '.dub-settings{margin:0 0 15px}',
        '.dub-settings__hint{font-size:13px;color:#92989b;margin-bottom:14px;line-height:17px}',
        '.dub-settings__section{border:1px solid #e2e4e7;border-radius:4px;padding:12px 15px;margin-bottom:12px;background:#fff}',
        '.dub-settings__section-title{font-size:14px;font-weight:bold;color:#313942;margin-bottom:8px}',
        '.dub-settings__row{display:flex;align-items:center;gap:8px;font-size:13px;color:#313942;margin-bottom:6px}',
        '.dub-settings__row:last-child{margin-bottom:0}',
        '.dub-settings__placeholder{font-size:12px;color:#92989b;font-style:italic}',
        '.dub-settings__badge{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:10px;background:#eef1f4;color:#92989b;font-size:11px;font-style:normal;vertical-align:middle}',
        /* правила в настройках */
        '.dub-rule{display:flex;align-items:center;gap:8px;font-size:13px;color:#313942;padding:6px 0;border-bottom:1px solid #eef1f4}',
        '.dub-rule__toggle{flex:0 0 auto;margin:0}',
        '.dub-rule__name{font-weight:bold}',
        '.dub-rule__meta{color:#92989b;font-size:12px}',
        '.dub-rule__del{margin-left:auto;flex:0 0 auto;padding:2px 9px;line-height:1.2;color:#e05c5c}',
        '.dub-rules__empty{padding:6px 0}',
        '.dub-rules__add{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px}',
        '.dub-rules__add input[type="text"],.dub-rules__add select{padding:5px 8px;border:1px solid #d4d7da;border-radius:3px;font-size:13px}',
        '.dub-rule__keys{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:#313942}',
        '.dub-rule__keyopt{display:flex;align-items:center;gap:4px}',
        '.dub-settings__foot{display:flex;align-items:center;gap:12px}',
        '.dub-settings__status{font-size:13px;color:#1f9d57}',
        '.dub-settings__status_error{color:#e05c5c}',
        /* массовая чистка */
        '.dub-scan__controls{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
        '.dub-scan__controls select{padding:5px 8px;border:1px solid #d4d7da;border-radius:3px;font-size:13px}',
        '.dub-scan__job{display:flex;align-items:center;gap:10px;font-size:13px;color:#313942;padding:6px 0;border-bottom:1px solid #eef1f4}',
        '.dub-scan__job:last-child{border-bottom:none}',
        '.dub-scan__entity-name{font-weight:bold;min-width:80px}',
        '.dub-scan__status{padding:1px 8px;border-radius:10px;background:#eef1f4;font-size:12px}',
        '.dub-scan__status_running{background:#e3f0ff;color:#2b7de9}',
        '.dub-scan__status_done{background:#e6f6ec;color:#1f9d57}',
        '.dub-scan__status_error{background:#fdecec;color:#e05c5c}',
        '.dub-scan__progress{color:#92989b;font-size:12px}',
        '.dub-scan__pause,.dub-scan__resume{margin-left:auto;flex:0 0 auto;padding:4px 10px;font-size:12px}',
        /* найденные дубли (группы) */
        '.dub-found__controls{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
        '.dub-found__controls select{padding:5px 8px;border:1px solid #d4d7da;border-radius:3px;font-size:13px}',
        '.dub-found__group{border:1px solid #eef1f4;border-radius:4px;padding:8px 10px;margin-bottom:8px}',
        '.dub-found__head{display:flex;align-items:center;gap:10px;margin-bottom:6px}',
        '.dub-found__key{font-weight:bold;font-size:13px;color:#313942}',
        '.dub-found__merge{margin-left:auto;flex:0 0 auto;padding:4px 10px;font-size:12px}',
        '.dub-found__rec{font-size:13px;color:#313942;padding:2px 0}',
        '.dub-found__rec-id{color:#92989b;font-size:12px}',
        '.dub-found__empty{padding:6px 0}',
        /* страница advanced_settings: держим контент в читаемой колонке, не даём уйти */
        /* под боковое меню настроек, в каком бы контейнере amoCRM мы ни оказались */
        '.dub-adv{box-sizing:border-box}',
        '.dub-adv_col{max-width:1080px;margin:32px 0 56px}',
        '.dub-adv_wide{max-width:1080px;margin:32px auto 56px;padding:0 20px}',
        /* ===== фирменная тема Ko:agency (красный акцент) ===== */
        '.dub-ko__head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 16px}',
        '.dub-ko__brand{font-size:13px;font-weight:700;color:#141414;letter-spacing:.2px}',
        '.dub-ko__brand span{color:#98a0a8;font-weight:400}',
        '.dub-ko__act{display:flex;align-items:center;gap:12px;flex:0 0 auto}',
        '.dub-ko__act .dub__btn{flex:0 0 auto;padding:8px 22px;font-weight:600}',
        /* верхние вкладки */
        '.dub-tabs{display:flex;gap:2px;border-bottom:1px solid #e7e9ec;margin-bottom:18px;flex-wrap:wrap}',
        '.dub-tab{-webkit-appearance:none;appearance:none;border:0;background:none;padding:10px 16px;font-size:14px;font-weight:600;color:#7b828b;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
        '.dub-tab:hover{color:#141414}',
        '.dub-tab_active{color:#d22730;border-bottom-color:#d22730}',
        '.dub-pane{display:none}',
        '.dub-pane_active{display:block}',
        /* под-вкладки (сегмент-контрол) */
        '.dub-subtabs{display:inline-flex;gap:3px;margin-bottom:16px;background:#f2f3f5;padding:3px;border-radius:9px}',
        '.dub-subtab{-webkit-appearance:none;appearance:none;border:0;background:none;padding:7px 14px;font-size:13px;font-weight:600;color:#7b828b;cursor:pointer;border-radius:6px}',
        '.dub-subtab:hover{color:#141414}',
        '.dub-subtab_active{background:#fff;color:#d22730;box-shadow:0 1px 2px rgba(38,49,62,.1)}',
        '.dub-subpane{display:none}',
        '.dub-subpane_active{display:block}',
        /* карточка-секция */
        '.dub-card{border:1px solid #e7e9ec;border-radius:10px;padding:16px 18px;margin-bottom:14px;background:#fff}',
        '.dub-card__title{font-size:15px;font-weight:700;color:#141414;margin-bottom:6px}',
        '.dub-card__hint{font-size:12px;color:#98a0a8;line-height:1.5;margin-bottom:12px}',
        /* тумблер-переключатель */
        '.dub-switch{display:flex;align-items:center;gap:14px;padding:11px 2px;cursor:pointer;font-size:14px;color:#141414;margin:0}',
        '.dub-switch+.dub-switch{border-top:1px solid #f0f1f3}',
        '.dub-switch__text{flex:1;min-width:0}',
        '.dub-switch__text b{font-weight:600}',
        '.dub-switch input{position:absolute;opacity:0;width:0;height:0}',
        '.dub-switch__track{position:relative;flex:0 0 auto;width:40px;height:23px;border-radius:23px;background:#cfd4da;transition:background .2s}',
        '.dub-switch__thumb{position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
        '.dub-switch input:checked+.dub-switch__track{background:#d22730}',
        '.dub-switch input:checked+.dub-switch__track .dub-switch__thumb{transform:translateX(17px)}',
        '.dub-auto__meta{color:#98a0a8;font-size:12px;font-weight:400}',
        /* вкладка «Оплата» */
        '.dub-pay__status{font-size:13px;font-weight:600;color:#8a919a;margin-bottom:6px}',
        '.dub-pay__status_ok{color:#1f9d57}',
        '.dub-pay__rate{font-size:13px;color:#98a0a8;flex:0 0 auto}',
        '.dub-pay__line{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;color:#141414;margin-bottom:16px;flex-wrap:wrap}',
        '.dub-pay__row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}',
        '.dub-pay__label{font-size:14px;color:#141414}',
        '.dub-pay__users{width:64px;padding:6px 8px;border:1px solid #d4d7da;border-radius:6px;font-size:14px;text-align:center;box-sizing:border-box;display:inline-block;vertical-align:middle;margin:0 4px}',
        '.dub-pay__plans{display:flex;gap:12px;margin-bottom:6px;flex-wrap:wrap}',
        '.dub-plan{flex:1 1 160px;min-width:150px;border:2px solid #e7e9ec;border-radius:10px;padding:14px;cursor:pointer;text-align:center;display:flex;flex-direction:column;gap:4px;position:relative}',
        '.dub-plan:hover{border-color:#cfd4da}',
        '.dub-plan_active{border-color:#d22730}',
        '.dub-plan input{position:absolute;opacity:0;width:0;height:0}',
        '.dub-plan__months{font-size:15px;font-weight:700;color:#141414}',
        '.dub-plan__bonus{font-size:12px;color:#d22730;min-height:16px}',
        '.dub-plan__sum{font-size:14px;color:#141414;margin-top:2px}',
        '.dub-pay__total{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid #f0f1f3;margin-top:8px;margin-bottom:14px}',
        '.dub-pay__total b{font-size:22px;color:#141414}',
        '.dub-pay__actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}',
        '.dub-pay__actions .dub-pay__sum{font-size:20px;font-weight:700;color:#141414;margin-right:auto}',
        '.dub-pay__actions .dub__btn{flex:0 0 auto;padding:10px 24px;font-weight:600}'
      ].join('');
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.setAttribute('data-v', WIDGET_BUILD);
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    }

    // Иконка темы «дубли/слияние»: две перекрывающиеся карточки
    var LOGO_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="1.5" y="1.5" width="8" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/>' +
      '<rect x="6.5" y="4.5" width="8" height="10" rx="1" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.3"/>' +
      '</svg>';

    var OK_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // Иконка «найдены возможные дубли»: восклицательный знак в круге
    var WARN_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M8 4.6v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
      '<circle cx="8" cy="11.2" r="0.9" fill="currentColor"/></svg>';

    function showToast(message, isError) {
      injectStyles();
      var $toast = $('<div class="dub-toast"></div>')
        .toggleClass('dub-toast_error', !!isError)
        .text(message)
        .appendTo(document.body);
      setTimeout(function () {
        $toast.addClass('dub-toast_visible');
      }, 10);
      setTimeout(function () {
        $toast.removeClass('dub-toast_visible');
        setTimeout(function () {
          $toast.remove();
        }, 300);
      }, 2600);
    }

    /* ------------------------------ модальные окна ------------------------------ */

    function openYpModal(className, html, onReady) {
      injectStyles();
      // init вызывается синхронно из конструктора Modal, поэтому экземпляр
      // окна берём из this, а не из ещё не присвоенной переменной
      var escHandler = null;
      return new Modal({
        class_name: 'dub-modal-holder',
        init: function ($modal_body) {
          var modalInstance = this;
          $modal_body
            .addClass('dub-modal ' + className)
            .css({ width: '650px' })
            .html(html)
            .trigger('modal:loaded')
            .trigger('modal:centrify');
          // закрытие по Esc
          escHandler = function (event) {
            if (event.key === 'Escape' || event.keyCode === 27) {
              closeYpModal(modalInstance);
            }
          };
          document.addEventListener('keydown', escHandler);
          if (onReady) {
            onReady($modal_body, modalInstance);
          }
        },
        destroy: function () {
          if (escHandler) {
            document.removeEventListener('keydown', escHandler);
            escHandler = null;
          }
        }
      });
    }

    function closeYpModal(modal) {
      try {
        modal.destroy();
      } catch (e) { /* окно уже закрыто */ }
    }

    /* ----------------------------- проверка дублей ----------------------------- */

    function getSettings() {
      try {
        return self.get_settings() || {};
      } catch (e) {
        return {};
      }
    }

    // account_id аккаунта amoCRM — нужен бэкенду для изоляции данных.
    function accountId() {
      try {
        var acc = AMOCRM.constant('account') || {};
        return acc.id != null ? String(acc.id) : '';
      } catch (e) {
        return '';
      }
    }

    // URL бэкенда всегда наш — зашит в код (поля в настройках нет). Значение из
    // настроек, если вдруг задано, имеет приоритет (для стенда/отладки).
    var DEFAULT_BACKEND = 'https://dubli.koagency.ru';
    function backendBase() {
      return String(getSettings().backend_url || DEFAULT_BACKEND).replace(/\/+$/, '');
    }

    // Проверять дубли можно, только когда заданы URL бэкенда, ключ и известен account_id.
    function isConfigured() {
      return !!(backendBase() && getSettings().security_key && accountId());
    }

    // Реальная проверка дублей: GET {backend_url}/api/duplicates (поиск по индексу бэкенда).
    function checkDuplicates(entity, callback) {
      if (!isConfigured()) {
        callback({ ok: false, reason: 'not_configured' });
        return;
      }
      $.ajax({
        url: backendBase() + '/api/duplicates',
        method: 'GET',
        dataType: 'json',
        data: { account_id: accountId(), entity_type: entity.type, amo_id: entity.id },
        headers: { 'X-Security-Key': getSettings().security_key }
      }).done(function (resp) {
        resp = resp || {};
        var items = resp.duplicates || [];
        var indexed = !resp.entity || resp.entity.indexed !== false;
        callback({
          ok: true,
          indexed: indexed,
          count: resp.count != null ? resp.count : items.length,
          items: items
        });
      }).fail(function () {
        callback({ ok: false, reason: 'error' });
      });
    }

    /* ---------------------------- блок в карточке ---------------------------- */

    // Текст, css-класс и иконка статуса по состоянию проверки.
    function statusFor(state) {
      switch (state.status) {
        case 'found':
          return {
            text: t('card.found', 'Найдены возможные дубли') + ' (' + state.count + ')',
            cls: 'dub__status_found',
            icon: WARN_SVG
          };
        case 'no_dups':
          return { text: t('card.no_dups', 'Дублей не найдено'), cls: 'dub__status_ok', icon: OK_SVG };
        case 'checking':
          return { text: t('card.checking', 'Проверяем дубли…'), cls: '', icon: '' };
        case 'not_indexed':
          return { text: t('card.not_indexed', 'Ещё не проиндексировано'), cls: '', icon: '' };
        case 'not_configured':
          return { text: t('card.not_configured', 'Бэкенд не настроен'), cls: '', icon: '' };
        case 'no_entity':
          return { text: t('card.no_entity', 'Не удалось определить карточку'), cls: '', icon: '' };
        default:
          return { text: t('card.check_failed', 'Не удалось проверить дубли'), cls: 'dub__status_error', icon: '' };
      }
    }

    function cardHtml(entity, state) {
      var st = statusFor(state);
      var statusHtml = '<div class="dub__status ' + st.cls + '">' + st.icon +
        '<span>' + escapeHtml(st.text) + '</span></div>';
      // «Открыть» и «Объединить» активны только при найденных дублях.
      var disabled = state.status === 'found' ? '' : ' disabled';
      return '<div class="dub" data-entity="' + escapeHtml(entity ? entity.type : '') + '">' +
        '<div class="dub__banner">' + LOGO_SVG + '<span>KO:AGENCY</span></div>' +
        statusHtml +
        '<div class="dub__actions">' +
          '<button type="button" class="dub__btn dub__open"' + disabled + '>' +
            escapeHtml(t('card.open', 'Открыть')) + '</button>' +
          '<button type="button" class="dub__btn dub__btn_primary dub__merge"' + disabled + '>' +
            escapeHtml(t('card.merge', 'Объединить')) + '</button>' +
        '</div>' +
        '</div>';
    }

    function renderCard(entity, state) {
      self.render_template({
        caption: { class_name: 'dub-card' },
        body: cardHtml(entity, state),
        render: ''
      });
    }

    function renderCardWidget() {
      injectStyles();
      var entity = detectEntity();
      self._dups = [];
      self._entity = entity;

      if (!entity) {
        renderCard(null, { status: 'no_entity' });
        return;
      }
      if (!isConfigured()) {
        renderCard(entity, { status: 'not_configured' });
        return;
      }

      // Сначала «проверяем…», затем обновляем плашку по ответу бэкенда.
      renderCard(entity, { status: 'checking' });
      checkDuplicates(entity, function (res) {
        var state;
        if (!res.ok) {
          state = { status: res.reason === 'not_configured' ? 'not_configured' : 'error' };
        } else if (!res.indexed) {
          state = { status: 'not_indexed' };
        } else if (res.count > 0) {
          self._dups = res.items;
          state = { status: 'found', count: res.count };
        } else {
          state = { status: 'no_dups' };
        }
        renderCard(entity, state);
      });
    }

    /* ------------------------- список дублей (модалка) ------------------------- */

    // Модалка со списком возможных дублей: имя-ссылка на карточку, совпавшие ключи
    // и кнопка «Объединить в текущую» (текущая карточка — главная запись).
    function openDuplicatesModal() {
      var items = self._dups || [];
      var entity = self._entity;
      if (!items.length) {
        return;
      }
      var rows = items.map(function (d) {
        var name = d.name || ('#' + d.amo_id);
        var href = '/' + (entity ? entity.type : '') + '/detail/' + encodeURIComponent(d.amo_id);
        var keys = (d.matched_keys || []).map(function (k) {
          return escapeHtml(k.key_type + ': ' + k.key_norm);
        }).join(', ');
        return '<div class="dub-dups__item">' +
          '<div class="dub-dups__head">' +
            '<a class="dub-dups__link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' +
              escapeHtml(name) + '</a>' +
            '<span class="dub-dups__id">#' + escapeHtml(d.amo_id) + '</span>' +
            '<button type="button" class="dub__btn dub-dups__merge" data-amo-id="' +
              escapeHtml(d.amo_id) + '" data-name="' + escapeHtml(name) + '">' +
              escapeHtml(t('card.merge_into', 'Объединить в текущую')) + '</button>' +
          '</div>' +
          (keys ? '<div class="dub-dups__keys">' +
            escapeHtml(t('card.matched_by', 'Совпадение по')) + ': ' + keys + '</div>' : '') +
          '</div>';
      }).join('');
      var html = '<div class="dub-modal__title">' +
        escapeHtml(t('card.dups_title', 'Возможные дубли')) + '</div>' +
        '<div class="dub-dups">' + rows + '</div>';
      self._listModal = openYpModal('dub-dups-modal', html);
    }

    /* ------------------------------ объединение ------------------------------ */

    function currentUserId() {
      try {
        var u = AMOCRM.constant('user') || {};
        return u.id != null ? u.id : undefined;
      } catch (e) {
        return undefined;
      }
    }

    function closeMergeModals() {
      if (self._confirmModal) {
        closeYpModal(self._confirmModal);
        self._confirmModal = null;
      }
      if (self._listModal) {
        closeYpModal(self._listModal);
        self._listModal = null;
      }
    }

    // Подтверждение слияния с выбором главной записи (её оставляем, вторую удаляем).
    function confirmMerge(duplicateAmoId, duplicateName) {
      var entity = self._entity;
      if (!entity) {
        return;
      }
      // Кандидаты: текущая карточка (a) и выбранный дубль (b).
      self._mergePair = {
        a: String(entity.id),
        aLabel: t('card.merge_current', 'текущая карточка'),
        b: String(duplicateAmoId),
        bLabel: duplicateName || ''
      };

      function option(id, label, checked) {
        return '<label class="dub-confirm__opt">' +
          '<input type="radio" name="dub-master" class="dub-confirm__master" value="' +
            escapeHtml(id) + '"' + (checked ? ' checked' : '') + '> ' +
          '#' + escapeHtml(id) + (label ? ' — ' + escapeHtml(label) : '') + '</label>';
      }

      var html = '<div class="dub-modal__title">' + escapeHtml(t('card.merge', 'Объединить')) + '</div>' +
        '<div class="dub-confirm__text">' +
          escapeHtml(t('card.merge_pick_master',
            'Выберите главную запись — её оставим, вторую объединим в неё и удалим (можно откатить).')) +
        '</div>' +
        '<div class="dub-confirm__opts">' +
          option(self._mergePair.a, self._mergePair.aLabel, true) +
          option(self._mergePair.b, self._mergePair.bLabel, false) +
        '</div>' +
        '<div class="dub__actions dub-confirm__actions">' +
          '<button type="button" class="dub__btn dub-confirm__cancel">' +
            escapeHtml(t('common.cancel', 'Отмена')) + '</button>' +
          '<button type="button" class="dub__btn dub__btn_primary dub-confirm__ok">' +
            escapeHtml(t('card.merge', 'Объединить')) + '</button>' +
        '</div>';
      self._confirmModal = openYpModal('dub-confirm-modal', html);
    }

    // Запуск слияния по выбранной в модалке главной записи.
    function submitMerge() {
      var pair = self._mergePair || {};
      var master = $('.dub-confirm__master:checked').val() || pair.a;
      var duplicate = String(master) === String(pair.a) ? pair.b : pair.a;
      if (master && duplicate) {
        performMerge(master, duplicate);
      }
    }

    // Общее ядро слияния: POST /api/merge (master остаётся, duplicate удаляется).
    // Переиспользуется и картой, и экраном настроек.
    function postMerge(entityType, masterAmoId, duplicateAmoId, onDone, onFail) {
      apiCall(
        'POST',
        '/api/merge',
        {
          entity_type: entityType,
          master_amo_id: masterAmoId,
          duplicate_amo_id: duplicateAmoId,
          author_user_id: currentUserId()
        },
        onDone,
        onFail
      );
    }

    // Слияние из карточки: master остаётся, duplicate объединяется в него.
    function performMerge(masterAmoId, duplicateAmoId) {
      var entity = self._entity;
      if (!entity || !isConfigured()) {
        return;
      }
      postMerge(entity.type, masterAmoId, duplicateAmoId, function () {
        closeMergeModals();
        showToast(t('card.merge_done', 'Дубль объединён'));
        renderCardWidget(); // перепроверяем дубли после объединения
      }, function () {
        showToast(t('card.merge_failed', 'Не удалось объединить'), true);
      });
    }

    /* ------------------------------ экран настроек ------------------------------ */

    // Типы ключей для конструктора правил.
    var KEY_LABELS = [
      { key: 'phone', i18n: 'settings.key_phone', fb: 'Телефон' },
      { key: 'email', i18n: 'settings.key_email', fb: 'Email' },
      { key: 'inn', i18n: 'settings.key_inn', fb: 'ИНН' },
      { key: 'name', i18n: 'settings.key_name', fb: 'Имя' }
    ];

    // Запрос к API бэкенда: account_id в query, ключ в заголовке.
    // Человекочитаемая ошибка из ответа бэкенда ({statusCode, error} — error строка или объект).
    function apiErrText(xhr, fallback) {
      try {
        var j = (xhr && (xhr.responseJSON || (xhr.responseText ? JSON.parse(xhr.responseText) : null))) || null;
        if (j) {
          var e = j.error;
          if (e && typeof e === 'object') return e.message || e.error || fallback;
          if (typeof e === 'string') return e;
          if (j.message) return j.message;
        }
      } catch (ignore) { /* нераспарсили — отдадим fallback */ }
      return (xhr && xhr.status ? '[' + xhr.status + '] ' : '') + fallback;
    }

    function apiCall(method, path, body, onDone, onFail) {
      var sep = path.indexOf('?') >= 0 ? '&' : '?';
      $.ajax({
        url: backendBase() + path + sep + 'account_id=' + encodeURIComponent(accountId()),
        method: method,
        contentType: 'application/json',
        dataType: 'json',
        data: body != null ? JSON.stringify(body) : undefined,
        headers: { 'X-Security-Key': getSettings().security_key }
      }).done(onDone || function () {}).fail(onFail || function () {});
    }

    function settingsStatus(text, isError) {
      $('.dub-settings__status').text(text).toggleClass('dub-settings__status_error', !!isError);
    }

    function section(titleKey, titleFallback, inner) {
      return '<div class="dub-settings__section">' +
        '<div class="dub-settings__section-title">' + escapeHtml(t(titleKey, titleFallback)) + '</div>' +
        inner + '</div>';
    }

    function entityCheckbox(ent, labelKey, labelFallback, checked) {
      return '<label class="dub-settings__row">' +
        '<input type="checkbox" class="dub-ent" data-ent="' + ent + '"' + (checked ? ' checked' : '') + '> ' +
        escapeHtml(t(labelKey, labelFallback)) + '</label>';
    }

    function ruleRowHtml(rule) {
      var fields = (rule.fields || []).map(function (f) { return f.key_type; }).join(', ');
      var meta = escapeHtml(rule.entity_type + ' · ' + (fields || '—') + ' · ' + rule.operator);
      return '<div class="dub-rule" data-id="' + escapeHtml(rule.id) + '">' +
        '<label class="dub-rule__toggle"><input type="checkbox" class="dub-rule__enabled"' +
          (rule.enabled ? ' checked' : '') + '></label>' +
        '<span class="dub-rule__name">' + escapeHtml(rule.name) + '</span>' +
        '<span class="dub-rule__meta">' + meta + '</span>' +
        '<button type="button" class="dub__btn dub-rule__del" title="' +
          escapeHtml(t('settings.delete', 'Удалить')) + '">×</button>' +
        '</div>';
    }

    // <option> сущностей для select'ов (правила, скан).
    function entityOptionsHtml() {
      return [
        ['contact', t('settings.contacts', 'Контакты')],
        ['company', t('settings.companies', 'Компании')],
        ['lead', t('settings.leads', 'Сделки')]
      ].map(function (o) {
        return '<option value="' + o[0] + '">' + escapeHtml(o[1]) + '</option>';
      }).join('');
    }

    function rulesSectionHtml(rules) {
      var list = rules.length
        ? rules.map(ruleRowHtml).join('')
        : '<div class="dub-rules__empty dub-settings__placeholder">' +
            escapeHtml(t('settings.no_rules', 'Правил пока нет')) + '</div>';

      var entityOptions = entityOptionsHtml();

      var opOptions =
        '<option value="AND">' + escapeHtml(t('settings.match_all', 'Все условия (AND)')) + '</option>' +
        '<option value="OR">' + escapeHtml(t('settings.match_any', 'Любое условие (OR)')) + '</option>';

      var keyChecks = KEY_LABELS.map(function (k) {
        return '<label class="dub-rule__keyopt"><input type="checkbox" class="dub-rule__newkey" value="' +
          k.key + '"> ' + escapeHtml(t(k.i18n, k.fb)) + '</label>';
      }).join('');

      var add = '<div class="dub-rules__add">' +
        '<input type="text" class="dub-rule__newname" placeholder="' +
          escapeHtml(t('settings.rule_name_ph', 'Название правила')) + '">' +
        '<select class="dub-rule__newentity">' + entityOptions + '</select>' +
        '<select class="dub-rule__newop">' + opOptions + '</select>' +
        '<div class="dub-rule__keys">' + keyChecks + '</div>' +
        '<button type="button" class="dub__btn dub__btn_primary dub-rule__add">' +
          escapeHtml(t('settings.add', 'Добавить правило')) + '</button>' +
        '</div>';

      return section('settings.rules', 'Правила поиска',
        '<div class="dub-rules__list">' + list + '</div>' + add);
    }

    function entitySwitch(ent, labelKey, labelFb, checked) {
      return '<label class="dub-switch">' +
        '<span class="dub-switch__text">' + escapeHtml(t(labelKey, labelFb)) + '</span>' +
        '<input type="checkbox" class="dub-ent" data-ent="' + ent + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="dub-switch__track"><span class="dub-switch__thumb"></span></span></label>';
    }

    function tabBtn(id, key, fb, active) {
      return '<button type="button" class="dub-tab' + (active ? ' dub-tab_active' : '') +
        '" data-tab="' + id + '">' + escapeHtml(t(key, fb)) + '</button>';
    }

    function subBtn(group, id, key, fb, active) {
      return '<button type="button" class="dub-subtab' + (active ? ' dub-subtab_active' : '') +
        '" data-subgroup="' + group + '" data-sub="' + id + '">' + escapeHtml(t(key, fb)) + '</button>';
    }

    // Строка правила во вкладке «Автоматическая очистка»: тумблер авто-объединения.
    function autoRuleRowHtml(rule) {
      var fields = (rule.fields || []).map(function (f) { return keyTypeLabel(f.key_type); }).join(', ');
      return '<label class="dub-switch">' +
        '<span class="dub-switch__text"><b>' + escapeHtml(rule.name) + '</b>' +
          '<span class="dub-auto__meta"> · ' + escapeHtml(fields || '—') + ' · ' + escapeHtml(rule.operator) + '</span></span>' +
        '<input type="checkbox" class="dub-auto__toggle" data-id="' + escapeHtml(rule.id) + '"' +
          (rule.auto_merge ? ' checked' : '') + '>' +
        '<span class="dub-switch__track"><span class="dub-switch__thumb"></span></span></label>';
    }

    // Вкладка «Автоматическая очистка»: под-вкладки по сущностям + тумблеры авто-объединения правил.
    function autoPaneHtml(rules) {
      var ents = [
        ['lead', 'settings.auto_deals', 'Дубли сделок'],
        ['contact', 'settings.auto_contacts', 'Дубли контактов'],
        ['company', 'settings.auto_companies', 'Дубли компаний']
      ];
      var subtabs = ents.map(function (e, i) { return subBtn('auto', e[0], e[1], e[2], i === 0); }).join('');
      var panes = ents.map(function (e, i) {
        var forEnt = rules.filter(function (r) { return r.entity_type === e[0]; });
        var body = forEnt.length
          ? forEnt.map(autoRuleRowHtml).join('')
          : '<div class="dub-settings__placeholder">' +
              escapeHtml(t('settings.auto_empty',
                'Нет правил для этой сущности. Создайте правило во вкладке «Правила поиска».')) + '</div>';
        return '<div class="dub-subpane' + (i === 0 ? ' dub-subpane_active' : '') +
          '" data-subgroup="auto" data-sub="' + e[0] + '">' + body + '</div>';
      }).join('');
      return '<div class="dub-card">' +
        '<div class="dub-card__hint">' + escapeHtml(t('settings.auto_hint',
          'Включите авто-объединение для нужных правил — однозначные дубли будут объединяться автоматически.')) +
        '</div><div class="dub-subtabs">' + subtabs + '</div>' + panes + '</div>';
    }

    // Сумма — целое число с разделением тысяч пробелом и знаком рубля.
    function fmtMoney(n) {
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
    }

    // Email текущего пользователя amoCRM для предзаполнения чека (если доступен).
    function currentUserEmail() {
      try {
        var u = (typeof AMOCRM !== 'undefined' && AMOCRM.constant) ? AMOCRM.constant('user') || {} : {};
        return u.email || u.login || '';
      } catch (e) {
        return '';
      }
    }

    // Число пользователей amoCRM в аккаунте (для авто-подстановки; минимум — тариф).
    function accountUsersCount() {
      try {
        var m = (typeof AMOCRM !== 'undefined' && AMOCRM.constant) ? AMOCRM.constant('managers') : null;
        var n = m && typeof m === 'object' ? Object.keys(m).length : 0;
        return Math.max(BILLING.minUsers, n || 0);
      } catch (e) {
        return BILLING.minUsers;
      }
    }

    // Расчёт подписки (для показа; авторитетный расчёт — на бэкенде при оплате).
    function calcPaySum(users, planId) {
      var u = Math.max(BILLING.minUsers, parseInt(users, 10) || 0);
      var plan = BILLING.plans.filter(function (p) { return p.id === planId; })[0] || BILLING.plans[0];
      return { users: u, plan: plan, sum: BILLING.pricePerUser * u * plan.pay };
    }

    function payPlanCardsHtml(users, activeId) {
      var mo = t('settings.pay_months', 'мес');
      return BILLING.plans.map(function (p) {
        var sum = BILLING.pricePerUser * Math.max(BILLING.minUsers, users) * p.pay;
        var bonus = p.months - p.pay;
        return '<label class="dub-plan' + (p.id === activeId ? ' dub-plan_active' : '') + '">' +
          '<input type="radio" name="dub-plan" class="dub-pay__plan" value="' + p.id + '"' +
            (p.id === activeId ? ' checked' : '') + '>' +
          '<span class="dub-plan__months">' + p.months + ' ' + escapeHtml(mo) + '</span>' +
          '<span class="dub-plan__bonus">' + (bonus > 0
            ? '+' + bonus + ' ' + escapeHtml(mo) + ' ' + escapeHtml(t('settings.pay_gift', 'в подарок')) : '') + '</span>' +
          '<span class="dub-plan__sum">' + fmtMoney(sum) + '</span>' +
          '</label>';
      }).join('');
    }

    // Вкладка «Оплата»: тариф, число пользователей, срок, сумма, онлайн-оплата и счёт.
    function payPaneHtml(status) {
      var activeId = BILLING.plans[0].id;
      var calc = calcPaySum((status && status.paid_users) || accountUsersCount(), activeId);
      var paid = status && status.paid_until;
      var statusLine = paid
        ? escapeHtml(t('settings.pay_status_paid', 'Оплачено до')) + ' ' + escapeHtml(String(status.paid_until)) +
          ' · ' + escapeHtml(String(status.paid_users || calc.users)) + ' ' + escapeHtml(t('settings.pay_users_short', 'польз.'))
        : escapeHtml(t('settings.pay_status_demo', 'Демо-режим — доступно ограниченное объединение'));
      return '<div class="dub-card">' +
        '<div class="dub-pay__status' + (paid ? ' dub-pay__status_ok' : '') + '">' + statusLine + '</div>' +
        '<div class="dub-pay__line">' +
          '<span>' + escapeHtml(t('settings.pay_for', 'За')) +
            ' <input type="number" class="dub-pay__users" min="' + BILLING.minUsers + '" value="' + calc.users + '"> ' +
            escapeHtml(t('settings.pay_users_word', 'пользователей amoCRM')) + '</span>' +
          '<span class="dub-pay__rate">' + BILLING.pricePerUser + ' ' +
            escapeHtml(t('settings.pay_per_month', '₽/мес')) + '</span>' +
        '</div>' +
        '<div class="dub-pay__plans">' + payPlanCardsHtml(calc.users, activeId) + '</div>' +
        '<div class="dub-pay__row"><span class="dub-pay__label">' +
          escapeHtml(t('settings.pay_email', 'Email для чека')) + '</span>' +
          '<input type="email" class="dub-pay__email" placeholder="you@example.com" value="' +
          escapeHtml(currentUserEmail()) + '"></div>' +
        '<div class="dub-pay__row"><span class="dub-pay__label">' +
          escapeHtml(t('settings.pay_phone', 'Телефон для связи')) + '</span>' +
          '<input type="tel" class="dub-pay__phone" placeholder="+7 999 000-00-00" value=""></div>' +
        '<div class="dub-pay__actions">' +
          '<b class="dub-pay__sum">' + fmtMoney(calc.sum) + '</b>' +
          '<button type="button" class="dub__btn dub__btn_primary dub-pay__online">' +
            escapeHtml(t('settings.pay_online', 'Оплатить онлайн')) + '</button>' +
          '<button type="button" class="dub__btn dub-pay__invoice">' +
            escapeHtml(t('settings.pay_invoice', 'Запросить счёт')) + '</button>' +
        '</div>' +
        '</div>';
    }

    // Разметка панели настроек: вкладочный интерфейс в стиле Ko:agency.
    function settingsHtml(dedup, rules) {
      var ent = dedup.entities || {};

      // Одна кнопка «Сохранить» — родная amoCRM внизу. Наши настройки (сущности,
      // предупреждение) сохраняются автоматически при переключении + на onSave.
      var head = '<div class="dub-ko__head">' +
        '<div class="dub-ko__brand">Ko:agency <span>· ' +
          escapeHtml(t('widget.short_description', 'Поиск и объединение дублей')) + '</span></div>' +
        '<div class="dub-ko__act"><span class="dub-settings__status"></span></div>' +
        '</div>';

      var tabs = '<div class="dub-tabs">' +
        tabBtn('main', 'settings.tab_widget', 'Настройки виджета', true) +
        tabBtn('mass', 'settings.tab_mass', 'Массовая очистка', false) +
        tabBtn('auto', 'settings.tab_auto', 'Автоматическая очистка', false) +
        tabBtn('pay', 'settings.tab_pay', 'Оплата', false) +
        '</div>';

      // --- вкладка «Настройки виджета» ---
      var warnCard = '<div class="dub-card">' +
        '<div class="dub-card__hint">' + escapeHtml(t('settings.warn_hint',
          'Отметьте сущности, по которым искать дубли.')) + '</div>' +
        entitySwitch('lead', 'settings.find_deals', 'Производить поиск дублей сделки', ent.lead !== false) +
        entitySwitch('contact', 'settings.find_contacts', 'Производить поиск дублей контакта', ent.contact !== false) +
        entitySwitch('company', 'settings.find_companies', 'Производить поиск дублей компании', ent.company !== false) +
        '</div>' +
        '<div class="dub-card">' +
        '<div class="dub-card__title">' + escapeHtml(t('settings.prevent', 'Запрет создания дублей')) + '</div>' +
        '<label class="dub-switch"><span class="dub-switch__text">' +
          escapeHtml(t('settings.prevent_label', 'Предупреждать о дублях при сохранении')) + '</span>' +
          '<input type="checkbox" class="dub-prevent"' + (dedup.prevent_create ? ' checked' : '') + '>' +
          '<span class="dub-switch__track"><span class="dub-switch__thumb"></span></span></label>' +
        '</div>';

      var mainPane = '<div class="dub-pane dub-pane_active" data-pane="main">' +
        '<div class="dub-subtabs">' +
          subBtn('main', 'warn', 'settings.sub_warn', 'Предупреждения о дублях', true) +
          subBtn('main', 'rules', 'settings.sub_rules', 'Правила поиска', false) +
        '</div>' +
        '<div class="dub-subpane dub-subpane_active" data-subgroup="main" data-sub="warn">' + warnCard + '</div>' +
        '<div class="dub-subpane" data-subgroup="main" data-sub="rules">' + rulesSectionHtml(rules) + '</div>' +
        '</div>';

      var massPane = '<div class="dub-pane" data-pane="mass">' +
        scanSectionHtml() + dupsSectionHtml() + '</div>';

      var autoPane = '<div class="dub-pane" data-pane="auto">' + autoPaneHtml(rules) + '</div>';

      var payPane = '<div class="dub-pane" data-pane="pay">' + payPaneHtml(dedup && dedup.billing) + '</div>';

      return head + tabs + mainPane + massPane + autoPane + payPane;
    }

    function loadErrorHtml() {
      return '<div class="dub-settings__hint dub-settings__status_error">' +
        escapeHtml(t('settings.load_failed', 'Не удалось загрузить настройки')) + '</div>';
    }

    /* ----------------------------- массовая чистка ----------------------------- */

    var SCAN_POLL_MS = 3000;

    function isActiveScan(j) {
      return j.status === 'queued' || j.status === 'running';
    }

    function scanStatusLabel(status) {
      switch (status) {
        case 'queued': return t('settings.scan_status_queued', 'В очереди');
        case 'running': return t('settings.scan_status_running', 'Идёт');
        case 'paused': return t('settings.scan_status_paused', 'Пауза');
        case 'done': return t('settings.scan_status_done', 'Готово');
        case 'error': return t('settings.scan_status_error', 'Ошибка');
        default: return status;
      }
    }

    function scanRowHtml(j) {
      var ctrl = '';
      if (isActiveScan(j)) {
        ctrl = '<button type="button" class="dub__btn dub-scan__pause" data-id="' +
          escapeHtml(j.id) + '">' + escapeHtml(t('settings.scan_pause', 'Пауза')) + '</button>';
      } else if (j.status === 'paused') {
        ctrl = '<button type="button" class="dub__btn dub-scan__resume" data-id="' +
          escapeHtml(j.id) + '">' + escapeHtml(t('settings.scan_resume', 'Продолжить')) + '</button>';
      }
      return '<div class="dub-scan__job" data-id="' + escapeHtml(j.id) + '">' +
        '<span class="dub-scan__entity-name">' + escapeHtml(j.entity_type) + '</span>' +
        '<span class="dub-scan__status dub-scan__status_' + escapeHtml(j.status) + '">' +
          escapeHtml(scanStatusLabel(j.status)) + '</span>' +
        '<span class="dub-scan__progress">' +
          escapeHtml(t('settings.scan_progress', 'обработано')) + ': ' +
          escapeHtml(String(j.progress || 0)) + '</span>' +
        ctrl +
        '</div>';
    }

    function scanJobsHtml(jobs) {
      if (!jobs.length) {
        return '<div class="dub-scan__empty dub-settings__placeholder">' +
          escapeHtml(t('settings.scan_empty', 'Сканирований пока не было')) + '</div>';
      }
      return jobs.map(scanRowHtml).join('');
    }

    function scanSectionHtml() {
      var controls = '<div class="dub-scan__controls">' +
        '<select class="dub-scan__entity">' + entityOptionsHtml() + '</select>' +
        '<button type="button" class="dub__btn dub__btn_primary dub-scan__start">' +
          escapeHtml(t('settings.scan_start', 'Сканировать')) + '</button>' +
        '</div>';
      return section('settings.scan_title', 'Массовая чистка',
        '<div class="dub-settings__hint">' +
          escapeHtml(t('settings.scan_hint', 'Просканировать всю базу и проиндексировать для поиска дублей.')) +
        '</div>' + controls + '<div class="dub-scan__list"></div>');
    }

    // Подгружает список задач сканирования и (пере)запускает опрос, пока есть активные.
    function refreshScans() {
      apiCall('GET', '/api/scan', null, function (jobs) {
        var arr = Array.isArray(jobs) ? jobs : [];
        var $list = $('.dub-scan__list');
        if (!$list.length) {
          stopScanPolling();
          return;
        }
        $list.html(scanJobsHtml(arr));
        var active = arr.some(isActiveScan);
        if (active) {
          startScanPolling();
        } else {
          stopScanPolling();
          // скан только что завершился — обновляем список найденных дублей
          if (self._scanWasActive && $('.dub-found__list').length) loadDupGroups();
        }
        self._scanWasActive = active;
      });
    }

    function startScanPolling() {
      if (self._scanTimer) return;
      self._scanTimer = setInterval(refreshScans, SCAN_POLL_MS);
      if (self._scanTimer && self._scanTimer.unref) self._scanTimer.unref();
    }

    function stopScanPolling() {
      if (self._scanTimer) {
        clearInterval(self._scanTimer);
        self._scanTimer = null;
      }
    }

    function startScan() {
      var entityType = $('.dub-scan__entity').val();
      apiCall('POST', '/api/scan', { entity_type: entityType }, function () {
        settingsStatus(t('settings.scan_started', 'Сканирование запущено'), false);
        refreshScans();
      }, function () {
        settingsStatus(t('settings.save_failed', 'Не удалось сохранить'), true);
      });
    }

    function pauseScan() {
      apiCall('POST', '/api/scan/' + encodeURIComponent($(this).attr('data-id')) + '/pause', null,
        refreshScans, refreshScans);
    }

    function resumeScan() {
      apiCall('POST', '/api/scan/' + encodeURIComponent($(this).attr('data-id')) + '/resume', null,
        refreshScans, refreshScans);
    }

    /* --------------------------- найденные дубли (группы) --------------------------- */

    function keyTypeLabel(kt) {
      switch (kt) {
        case 'phone': return t('settings.key_phone', 'Телефон');
        case 'email': return t('settings.key_email', 'Email');
        case 'inn': return t('settings.key_inn', 'ИНН');
        case 'name': return t('settings.key_name', 'Имя');
        default: return t('settings.key_custom', 'Поле');
      }
    }

    function dupsSectionHtml() {
      var controls = '<div class="dub-found__controls">' +
        '<select class="dub-found__entity">' + entityOptionsHtml() + '</select>' +
        '<button type="button" class="dub__btn dub__btn_primary dub-found__show">' +
          escapeHtml(t('settings.found_show', 'Показать')) + '</button>' +
        '</div>';
      return section('settings.found_title', 'Найденные дубли',
        '<div class="dub-settings__hint">' +
          escapeHtml(t('settings.found_hint',
            'Показать группы дублей по сущности (после сканирования) и объединить.')) +
        '</div>' + controls + '<div class="dub-found__list"></div>');
    }

    function dupGroupHtml(group, idx) {
      var records = (group.entities || []).map(function (e) {
        var name = e.name || ('#' + e.amo_id);
        return '<div class="dub-found__rec"><span class="dub-found__rec-name">' +
          escapeHtml(name) + '</span> <span class="dub-found__rec-id">#' +
          escapeHtml(e.amo_id) + '</span></div>';
      }).join('');
      var head = escapeHtml(keyTypeLabel(group.key_type)) + ': ' + escapeHtml(group.key_norm) +
        ' (' + (group.entities || []).length + ')';
      return '<div class="dub-found__group" data-idx="' + idx + '">' +
        '<div class="dub-found__head">' +
          '<span class="dub-found__key">' + head + '</span>' +
          '<button type="button" class="dub__btn dub__btn_primary dub-found__merge" data-idx="' +
            idx + '">' + escapeHtml(t('settings.found_merge', 'Объединить')) + '</button>' +
        '</div>' + records + '</div>';
    }

    function renderDupGroups(groups) {
      var $list = $('.dub-found__list');
      if (!$list.length) return;
      if (!groups.length) {
        $list.html('<div class="dub-found__empty dub-settings__placeholder">' +
          escapeHtml(t('settings.found_empty', 'Дублей не найдено. Запустите сканирование выше.')) +
          '</div>');
        return;
      }
      $list.html(groups.map(dupGroupHtml).join(''));
    }

    // Загрузка групп дублей по выбранной сущности: GET /api/duplicates?entity_type=… (без amo_id).
    function loadDupGroups() {
      var entityType = $('.dub-found__entity').val() || 'contact';
      self._foundEntity = entityType;
      $('.dub-found__list').html('<div class="dub-settings__placeholder">' +
        escapeHtml(t('common.loading', 'Загрузка…')) + '</div>');
      apiCall('GET', '/api/duplicates?entity_type=' + encodeURIComponent(entityType), null,
        function (resp) {
          var groups = (resp && resp.groups) || [];
          self._foundGroups = groups;
          renderDupGroups(groups);
        }, function () {
          $('.dub-found__list').html('<div class="dub-settings__placeholder dub-settings__status_error">' +
            escapeHtml(t('settings.load_failed', 'Не удалось загрузить настройки')) + '</div>');
        });
    }

    // Модалка выбора главной записи для группы.
    function confirmGroupMerge(idx) {
      var group = (self._foundGroups || [])[idx];
      if (!group || !(group.entities || []).length) return;
      self._gmerge = { entityType: self._foundEntity, records: group.entities.slice() };
      var opts = group.entities.map(function (e, i) {
        var name = e.name || ('#' + e.amo_id);
        return '<label class="dub-confirm__opt">' +
          '<input type="radio" name="dub-gmaster" class="dub-gmerge__master" value="' +
            escapeHtml(e.amo_id) + '"' + (i === 0 ? ' checked' : '') + '> #' +
            escapeHtml(e.amo_id) + ' — ' + escapeHtml(name) + '</label>';
      }).join('');
      var html = '<div class="dub-modal__title">' + escapeHtml(t('card.merge', 'Объединить')) + '</div>' +
        '<div class="dub-confirm__text">' +
          escapeHtml(t('settings.pick_master',
            'Выберите главную запись — остальные объединятся в неё (можно откатить).')) +
        '</div>' +
        '<div class="dub-confirm__opts">' + opts + '</div>' +
        '<div class="dub__actions dub-confirm__actions">' +
          '<button type="button" class="dub__btn dub-gmerge__cancel">' +
            escapeHtml(t('common.cancel', 'Отмена')) + '</button>' +
          '<button type="button" class="dub__btn dub__btn_primary dub-gmerge__ok">' +
            escapeHtml(t('card.merge', 'Объединить')) + '</button>' +
        '</div>';
      self._gConfirmModal = openYpModal('dub-confirm-modal', html);
    }

    function closeGroupConfirm() {
      if (self._gConfirmModal) {
        closeYpModal(self._gConfirmModal);
        self._gConfirmModal = null;
      }
    }

    // Последовательное слияние всех дублей группы в выбранную главную запись.
    function mergeSequence(entityType, master, dups, onAllDone) {
      if (!dups.length) {
        onAllDone();
        return;
      }
      postMerge(entityType, master, dups[0], function () {
        mergeSequence(entityType, master, dups.slice(1), onAllDone);
      }, function () {
        settingsStatus(t('settings.merge_failed', 'Не удалось объединить'), true);
      });
    }

    function submitGroupMerge() {
      var g = self._gmerge;
      if (!g || !isConfigured()) return;
      var master = String($('.dub-gmerge__master:checked').val() ||
        (g.records[0] && g.records[0].amo_id) || '');
      var dups = g.records.map(function (r) { return String(r.amo_id); })
        .filter(function (id) { return id !== master; });
      if (!master || !dups.length) return;
      mergeSequence(g.entityType, master, dups, function () {
        closeGroupConfirm();
        settingsStatus(t('settings.merge_done', 'Дубли объединены'), false);
        loadDupGroups(); // перезагрузить группы после слияния
      });
    }

    // Рендерит панель настроек: грузит настройки и правила с бэкенда и строит форму.
    function renderSettings($container) {
      injectStyles();
      $container.find('.dub-settings').remove(); // идемпотентно при повторном открытии
      var $panel = $('<div class="dub-settings"></div>');
      // Не трогаем служебные поля (backend_url / security_key) — их рисует амо.
      var $firstField = $container.find('input[name="backend_url"], input[name="security_key"]').first();
      if ($firstField.length) {
        var $wrap = $firstField.closest('.widget_settings_block__item_field');
        ($wrap.length ? $wrap : $firstField).before($panel);
      } else {
        $container.prepend($panel);
      }

      if (!isConfigured()) {
        $panel.html('<div class="dub-settings__hint">' +
          escapeHtml(t('settings.configure_first',
            'Заполните URL бэкенда и ключ безопасности, сохраните и откройте настройки снова.')) +
          '</div>');
        return;
      }

      $panel.html('<div class="dub-settings__hint">' + escapeHtml(t('common.loading', 'Загрузка…')) + '</div>');
      apiCall('GET', '/api/settings', null, function (dedup) {
        apiCall('GET', '/api/rules', null, function (rules) {
          $panel.html(settingsHtml(dedup || {}, rules || []));
          refreshScans(); // подгрузить задачи сканирования в секцию «Массовая чистка»
          loadDupGroups(); // сразу показать найденные группы дублей (если есть)
        }, function () { $panel.html(loadErrorHtml()); });
      }, function () { $panel.html(loadErrorHtml()); });

      bindSettingsActions();
    }

    /* ----------------------- обработчики экрана настроек ----------------------- */

    function bindSettingsActions() {
      $(document)
        .off('click.dubset change.dubset')
        // переключение вкладок / под-вкладок
        .on('click.dubset', '.dub-tab', switchTab)
        .on('click.dubset', '.dub-subtab', switchSubtab)
        // авто-объединение по правилу
        .on('change.dubset', '.dub-auto__toggle', toggleAutoMerge)
        // оплата: пересчёт суммы, онлайн-оплата, запрос счёта
        .on('change.dubset', '.dub-pay__users, .dub-pay__plan', recalcPay)
        .on('click.dubset', '.dub-pay__online', payOnline)
        .on('click.dubset', '.dub-pay__invoice', payInvoice)
        // авто-сохранение настроек (сущности/предупреждение) при переключении
        .on('change.dubset', '.dub-ent, .dub-prevent', saveSettings)
        .on('click.dubset', '.dub-rule__add', addRule)
        .on('click.dubset', '.dub-rule__del', deleteRule)
        .on('change.dubset', '.dub-rule__enabled', toggleRule)
        .on('click.dubset', '.dub-scan__start', startScan)
        .on('click.dubset', '.dub-scan__pause', pauseScan)
        .on('click.dubset', '.dub-scan__resume', resumeScan)
        // найденные дубли: показать группы, объединить группу
        .on('click.dubset', '.dub-found__show', loadDupGroups)
        .on('click.dubset', '.dub-found__merge', function () {
          confirmGroupMerge(Number($(this).attr('data-idx')));
        })
        .on('click.dubset', '.dub-gmerge__ok', submitGroupMerge)
        .on('click.dubset', '.dub-gmerge__cancel', closeGroupConfirm);
    }

    function saveSettings() {
      var $p = $('.dub-settings');
      var dedup = {
        entities: {
          contact: $p.find('.dub-ent[data-ent="contact"]').prop('checked'),
          company: $p.find('.dub-ent[data-ent="company"]').prop('checked'),
          lead: $p.find('.dub-ent[data-ent="lead"]').prop('checked')
        },
        prevent_create: $p.find('.dub-prevent').prop('checked')
      };
      apiCall('PUT', '/api/settings', dedup, function () {
        settingsStatus(t('settings.saved', 'Настройки сохранены'), false);
      }, function () {
        settingsStatus(t('settings.save_failed', 'Не удалось сохранить'), true);
      });
    }

    // Контакт клиента (телефон из настроек + email) → бэкенд, чтобы у Ko:agency был
    // номер сразу после установки/сохранения. Best-effort, не мешает сохранению.
    function saveContact() {
      var phone = String(getSettings().phone || '').trim();
      if (!phone) return;
      apiCall('POST', '/api/billing/contact', { phone: phone, email: currentUserEmail() },
        function () {}, function () {});
    }

    function addRule() {
      var $p = $('.dub-settings');
      var name = String($p.find('.dub-rule__newname').val() || '').trim();
      var fields = $p.find('.dub-rule__newkey:checked').map(function () {
        return { key_type: $(this).val() };
      }).get();
      if (!name || !fields.length) {
        settingsStatus(t('settings.rule_incomplete', 'Укажите название и хотя бы одно поле'), true);
        return;
      }
      var rule = {
        entity_type: $p.find('.dub-rule__newentity').val(),
        name: name,
        operator: $p.find('.dub-rule__newop').val(),
        fields: fields
      };
      apiCall('POST', '/api/rules', rule, function (created) {
        $p.find('.dub-rules__empty').remove();
        $p.find('.dub-rules__list').append(ruleRowHtml(created));
        $p.find('.dub-rule__newname').val('');
        $p.find('.dub-rule__newkey').prop('checked', false);
        settingsStatus(t('settings.saved', 'Настройки сохранены'), false);
      }, function () {
        settingsStatus(t('settings.save_failed', 'Не удалось сохранить'), true);
      });
    }

    function deleteRule() {
      var $row = $(this).closest('.dub-rule');
      apiCall('DELETE', '/api/rules/' + encodeURIComponent($row.attr('data-id')), null, function () {
        $row.remove();
      }, function () {
        settingsStatus(t('settings.save_failed', 'Не удалось сохранить'), true);
      });
    }

    function toggleRule() {
      var $row = $(this).closest('.dub-rule');
      apiCall('PATCH', '/api/rules/' + encodeURIComponent($row.attr('data-id')),
        { enabled: $(this).prop('checked') }, null, function () {
          settingsStatus(t('settings.save_failed', 'Не удалось сохранить'), true);
        });
    }

    // Переключение верхних вкладок (Настройки виджета / Массовая очистка / Автоматическая очистка).
    function switchTab() {
      var id = $(this).attr('data-tab');
      var $root = $(this).closest('.dub-settings');
      $root.find('.dub-tab').removeClass('dub-tab_active');
      $(this).addClass('dub-tab_active');
      $root.find('.dub-pane').removeClass('dub-pane_active');
      $root.find('.dub-pane[data-pane="' + id + '"]').addClass('dub-pane_active');
    }

    // Переключение под-вкладок внутри группы (main: предупреждения/правила; auto: по сущностям).
    function switchSubtab() {
      var group = $(this).attr('data-subgroup');
      var sub = $(this).attr('data-sub');
      var $root = $(this).closest('.dub-settings');
      $root.find('.dub-subtab[data-subgroup="' + group + '"]').removeClass('dub-subtab_active');
      $(this).addClass('dub-subtab_active');
      $root.find('.dub-subpane[data-subgroup="' + group + '"]').removeClass('dub-subpane_active');
      $root.find('.dub-subpane[data-subgroup="' + group + '"][data-sub="' + sub + '"]')
        .addClass('dub-subpane_active');
    }

    // Пересчёт суммы во вкладке «Оплата» при смене числа пользователей / срока.
    function recalcPay() {
      var $root = $('.dub-settings');
      var planId = $root.find('.dub-pay__plan:checked').val() || BILLING.plans[0].id;
      var calc = calcPaySum($root.find('.dub-pay__users').val(), planId);
      $root.find('.dub-pay__users').val(calc.users);
      $root.find('.dub-pay__plans').html(payPlanCardsHtml(calc.users, planId));
      $root.find('.dub-pay__sum').text(fmtMoney(calc.sum));
    }

    // Онлайн-оплата: бэкенд создаёт платёж (ЮKassa) и возвращает ссылку на оплату.
    function payOnline() {
      var $root = $('.dub-settings');
      var planId = $root.find('.dub-pay__plan:checked').val() || BILLING.plans[0].id;
      var calc = calcPaySum($root.find('.dub-pay__users').val(), planId);
      var email = String($root.find('.dub-pay__email').val() || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        showToast(t('settings.pay_email_required', 'Укажите корректный email для чека'), true);
        return;
      }
      apiCall('POST', '/api/billing/checkout', {
        users: calc.users, months: calc.plan.months, email: email,
        phone: String($root.find('.dub-pay__phone').val() || '').trim()
      },
        function (resp) {
          if (resp && resp.confirmation_url) { window.location.href = resp.confirmation_url; }
          else { showToast(t('settings.pay_soon', 'Онлайн-оплата скоро будет доступна')); }
        }, function (xhr) { showToast(apiErrText(xhr, t('settings.pay_failed', 'Не удалось отправить запрос')), true); });
    }

    // Запрос счёта: бэкенд создаёт сделку в нашей amoCRM для выставления счёта.
    function payInvoice() {
      var $root = $('.dub-settings');
      var planId = $root.find('.dub-pay__plan:checked').val() || BILLING.plans[0].id;
      var calc = calcPaySum($root.find('.dub-pay__users').val(), planId);
      var body = {
        users: calc.users,
        months: calc.plan.months,
        phone: String($root.find('.dub-pay__phone').val() || '').trim(),
        email: String($root.find('.dub-pay__email').val() || '').trim()
      };
      apiCall('POST', '/api/billing/invoice-request', body,
        function () { showToast(t('settings.pay_invoice_sent', 'Счёт запрошен — менеджер свяжется с вами')); },
        function (xhr) { showToast(apiErrText(xhr, t('settings.pay_failed', 'Не удалось отправить запрос')), true); });
    }

    // Тумблер авто-объединения правила (PATCH /api/rules/:id { auto_merge }).
    function toggleAutoMerge() {
      var checked = $(this).prop('checked');
      apiCall('PATCH', '/api/rules/' + encodeURIComponent($(this).attr('data-id')),
        { auto_merge: checked }, function () {
          settingsStatus(t('settings.saved', 'Настройки сохранены'), false);
        }, function () {
          settingsStatus(t('settings.save_failed', 'Не удалось сохранить'), true);
        });
    }

    /* --------------------------------- callbacks --------------------------------- */

    this.callbacks = {
      render: function () {
        var area = safeArea();
        var isCard = AREA_ENTITY.some(function (item) {
          return area.indexOf(item.prefix) === 0;
        });
        if (isCard) {
          renderCardWidget();
        }
        return true;
      },

      init: function () {
        return true;
      },

      bind_actions: function () {
        // Делегированные обработчики переживают перерисовки карточки и живут на document,
        // поэтому ловят и кнопки в модалках; неймспейс .dub защищает от дублей.
        $(document)
          .off('click.dub')
          // «Открыть» и «Объединить» в плашке → список возможных дублей
          .on('click.dub', '.dub__open, .dub__merge', function () {
            if (!$(this).prop('disabled')) {
              openDuplicatesModal();
            }
          })
          // строка списка: «Объединить в текущую» → подтверждение
          .on('click.dub', '.dub-dups__merge', function () {
            confirmMerge($(this).attr('data-amo-id'), $(this).attr('data-name'));
          })
          // подтверждение объединения
          .on('click.dub', '.dub-confirm__ok', function () {
            submitMerge();
          })
          .on('click.dub', '.dub-confirm__cancel', function () {
            if (self._confirmModal) {
              closeYpModal(self._confirmModal);
              self._confirmModal = null;
            }
          });
        return true;
      },

      settings: function ($modal_body) {
        renderSettings($modal_body);
        return true;
      },

      onSave: function () {
        // Родная кнопка «Сохранить» amoCRM: сохраняем наши настройки и шлём контакт
        // (телефон), чтобы у Ko:agency сразу был номер клиента.
        try { saveContact(); } catch (e) { /* не мешаем сохранению amoCRM */ }
        if ($('.dub-settings').length) {
          try { saveSettings(); } catch (e) { /* не мешаем сохранению amoCRM */ }
        }
        return true;
      },

      destroy: function () {
        // Очистка слушателей / DOM / модалок / таймеров в неймспейсах .dub и .dubset
        $(document).off('click.dub').off('click.dubset change.dubset');
        stopScanPolling();
        closeMergeModals();
        closeGroupConfirm();
        $('.dub-toast').remove();
      },

      advancedSettings: function () {
        // amoCRM отдаёт под advanced_settings целую страницу и сам рисует её заголовок из
        // advanced.title — в колонке контента, со сдвигом вправо от бокового меню настроек.
        // Монтируемся сразу за этим заголовком, чтобы попасть в ТУ ЖЕ колонку (иначе контент
        // уезжает во всю ширину и левый край прячется под меню). Ищем только среди h1–h3,
        // чтобы не поймать одноимённый пункт меню. .dub-adv (CSS) ограничивает ширину и
        // центрирует как страховку, если правильный контейнер не найден.
        var titleText = (t('advanced.title', '') || '').replace(/\s+/g, ' ').trim();
        var $title = $();
        if (titleText) {
          $('h1, h2, h3').each(function () {
            if ($title.length) return;
            if ($(this).text().replace(/\s+/g, ' ').trim() === titleText) $title = $(this);
          });
        }
        var $mount;
        if ($title.length) {
          $mount = $('<div class="dub-advanced-settings-anchor dub-adv dub-adv_col"></div>');
          $title.after($mount);
        } else {
          $mount = $('<div class="dub-advanced-settings-anchor dub-adv dub-adv_wide"></div>');
          var $area = $('.widget_advanced_settings, .list-pipelines__hidden').first();
          ($area.length ? $area : $(document.body)).append($mount);
        }
        renderSettings($mount);
        return true;
      }
    };

    return this;
  };

  return CustomWidget;
});
