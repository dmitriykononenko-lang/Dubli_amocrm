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
    var WIDGET_BUILD = '2026-06-16.4';

    // Сопоставление области карточки (system().area) с типом сущности API v4
    var AREA_ENTITY = [
      { prefix: 'lcard', entity: 'leads' },
      { prefix: 'ccard', entity: 'contacts' },
      { prefix: 'comcard', entity: 'companies' }
    ];

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
        '.dub__btn_primary{background:#2b7de9;border-color:#2b7de9;color:#fff}',
        '.dub__btn_primary:hover:not(:disabled){background:#226fd0}',
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
        '.dub-confirm__target{font-size:13px;color:#313942;font-weight:bold;margin-bottom:16px}',
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
        '.dub-scan__pause,.dub-scan__resume{margin-left:auto;flex:0 0 auto;padding:4px 10px;font-size:12px}'
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

    function backendBase() {
      return String(getSettings().backend_url || '').replace(/\/+$/, '');
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

    // Подтверждение: дубль будет объединён в текущую карточку (главную) и удалён.
    function confirmMerge(duplicateAmoId, duplicateName) {
      var entity = self._entity;
      if (!entity) {
        return;
      }
      var target = '#' + duplicateAmoId + (duplicateName ? ' — ' + duplicateName : '');
      var html = '<div class="dub-modal__title">' + escapeHtml(t('card.merge', 'Объединить')) + '</div>' +
        '<div class="dub-confirm__text">' +
          escapeHtml(t('card.merge_confirm',
            'Объединить запись в текущую карточку? Дубль будет удалён (можно откатить).')) +
        '</div>' +
        '<div class="dub-confirm__target">' + escapeHtml(target) +
          ' → #' + escapeHtml(String(entity.id)) + '</div>' +
        '<div class="dub__actions dub-confirm__actions">' +
          '<button type="button" class="dub__btn dub-confirm__cancel">' +
            escapeHtml(t('common.cancel', 'Отмена')) + '</button>' +
          '<button type="button" class="dub__btn dub__btn_primary dub-confirm__ok" data-amo-id="' +
            escapeHtml(duplicateAmoId) + '">' + escapeHtml(t('card.merge', 'Объединить')) + '</button>' +
        '</div>';
      self._confirmModal = openYpModal('dub-confirm-modal', html);
    }

    // POST {backend_url}/api/merge: текущая карточка — главная, выбранная запись — дубль.
    function performMerge(duplicateAmoId) {
      var entity = self._entity;
      if (!entity || !isConfigured()) {
        return;
      }
      $.ajax({
        url: backendBase() + '/api/merge?account_id=' + encodeURIComponent(accountId()),
        method: 'POST',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({
          entity_type: entity.type,
          master_amo_id: entity.id,
          duplicate_amo_id: duplicateAmoId,
          author_user_id: currentUserId()
        }),
        headers: { 'X-Security-Key': getSettings().security_key }
      }).done(function () {
        closeMergeModals();
        showToast(t('card.merge_done', 'Дубль объединён'));
        renderCardWidget(); // перепроверяем дубли после объединения
      }).fail(function () {
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

    // Разметка панели настроек по загруженным данным (настройки + правила).
    function settingsHtml(dedup, rules) {
      var ent = dedup.entities || {};
      var entities = entityCheckbox('contact', 'settings.contacts', 'Контакты', ent.contact !== false) +
        entityCheckbox('company', 'settings.companies', 'Компании', ent.company !== false) +
        entityCheckbox('lead', 'settings.leads', 'Сделки', ent.lead !== false);

      var prevent = '<label class="dub-settings__row">' +
        '<input type="checkbox" class="dub-prevent"' + (dedup.prevent_create ? ' checked' : '') + '> ' +
        escapeHtml(t('settings.prevent_label', 'Предупреждать о дублях при сохранении')) + '</label>';

      return '<div class="dub-settings__hint">' +
          escapeHtml(t('widget.short_description', 'Поиск и объединение дублей')) + '</div>' +
        section('settings.entities', 'Сущности', entities) +
        rulesSectionHtml(rules) +
        scanSectionHtml() +
        section('settings.prevent', 'Запрет создания дублей', prevent) +
        '<div class="dub-settings__foot">' +
          '<button type="button" class="dub__btn dub__btn_primary dub-settings__save">' +
            escapeHtml(t('common.save', 'Сохранить')) + '</button>' +
          '<span class="dub-settings__status"></span>' +
        '</div>';
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
        if (arr.some(isActiveScan)) {
          startScanPolling();
        } else {
          stopScanPolling();
        }
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
        }, function () { $panel.html(loadErrorHtml()); });
      }, function () { $panel.html(loadErrorHtml()); });

      bindSettingsActions();
    }

    /* ----------------------- обработчики экрана настроек ----------------------- */

    function bindSettingsActions() {
      $(document)
        .off('click.dubset change.dubset')
        .on('click.dubset', '.dub-settings__save', saveSettings)
        .on('click.dubset', '.dub-rule__add', addRule)
        .on('click.dubset', '.dub-rule__del', deleteRule)
        .on('change.dubset', '.dub-rule__enabled', toggleRule)
        .on('click.dubset', '.dub-scan__start', startScan)
        .on('click.dubset', '.dub-scan__pause', pauseScan)
        .on('click.dubset', '.dub-scan__resume', resumeScan);
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
            performMerge($(this).attr('data-amo-id'));
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
        return true;
      },

      destroy: function () {
        // Очистка слушателей / DOM / модалок / таймеров в неймспейсах .dub и .dubset
        $(document).off('click.dub').off('click.dubset change.dubset');
        stopScanPolling();
        closeMergeModals();
        $('.dub-toast').remove();
      },

      advancedSettings: function () {
        renderSettings($('.dub-advanced-settings-anchor').length
          ? $('.dub-advanced-settings-anchor')
          : $(document.body));
        return true;
      }
    };

    return this;
  };

  return CustomWidget;
});
