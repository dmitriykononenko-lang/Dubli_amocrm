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
    var WIDGET_BUILD = '2026-06-16.1';

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
        /* скелет настроек */
        '.dub-settings{margin:0 0 15px}',
        '.dub-settings__hint{font-size:13px;color:#92989b;margin-bottom:14px;line-height:17px}',
        '.dub-settings__section{border:1px solid #e2e4e7;border-radius:4px;padding:12px 15px;margin-bottom:12px;background:#fff}',
        '.dub-settings__section-title{font-size:14px;font-weight:bold;color:#313942;margin-bottom:8px}',
        '.dub-settings__row{display:flex;align-items:center;gap:8px;font-size:13px;color:#313942;margin-bottom:6px}',
        '.dub-settings__row:last-child{margin-bottom:0}',
        '.dub-settings__placeholder{font-size:12px;color:#92989b;font-style:italic}',
        '.dub-settings__badge{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:10px;background:#eef1f4;color:#92989b;font-size:11px;font-style:normal;vertical-align:middle}'
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
      // «Открыть» активна только при найденных дублях; «Объединить» — пока всегда
      // неактивна (движок слияния на бэкенде это следующий слой).
      var openDisabled = state.status === 'found' ? '' : ' disabled';
      return '<div class="dub" data-entity="' + escapeHtml(entity ? entity.type : '') + '">' +
        '<div class="dub__banner">' + LOGO_SVG + '<span>KO:AGENCY</span></div>' +
        statusHtml +
        '<div class="dub__actions">' +
          '<button type="button" class="dub__btn dub__open"' + openDisabled + '>' +
            escapeHtml(t('card.open', 'Открыть')) + '</button>' +
          '<button type="button" class="dub__btn dub__btn_primary dub__merge" disabled>' +
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

    // Модалка со списком возможных дублей: имя-ссылка на карточку + совпавшие ключи.
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
          '<a class="dub-dups__link" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' +
            escapeHtml(name) + '</a>' +
          '<span class="dub-dups__id">#' + escapeHtml(d.amo_id) + '</span>' +
          (keys ? '<div class="dub-dups__keys">' +
            escapeHtml(t('card.matched_by', 'Совпадение по')) + ': ' + keys + '</div>' : '') +
          '</div>';
      }).join('');
      var html = '<div class="dub-modal__title">' +
        escapeHtml(t('card.dups_title', 'Возможные дубли')) + '</div>' +
        '<div class="dub-dups">' + rows + '</div>';
      openYpModal('dub-dups-modal', html);
    }

    /* ------------------------- скелет экрана настроек ------------------------- */

    // Статическая разметка настроек (без логики). Секции из ТЗ §5.4.
    function settingsSkeletonHtml() {
      function section(titleKey, titleFallback, rowsHtml) {
        return '<div class="dub-settings__section">' +
          '<div class="dub-settings__section-title">' + escapeHtml(t(titleKey, titleFallback)) +
            '<span class="dub-settings__badge">' + escapeHtml(t('common.soon', 'Скоро')) + '</span></div>' +
          rowsHtml +
          '</div>';
      }

      function checkboxRow(labelKey, labelFallback) {
        return '<label class="dub-settings__row">' +
          '<input type="checkbox" disabled> ' + escapeHtml(t(labelKey, labelFallback)) +
          '</label>';
      }

      function placeholderRow() {
        return '<div class="dub-settings__row dub-settings__placeholder">' +
          escapeHtml(t('common.soon', 'Скоро')) + '</div>';
      }

      var entities = checkboxRow('settings.contacts', 'Контакты') +
        checkboxRow('settings.companies', 'Компании') +
        checkboxRow('settings.leads', 'Сделки');

      return '<div class="dub-settings">' +
        '<div class="dub-settings__hint">' +
          escapeHtml(t('widget.short_description', 'Поиск и объединение дублей')) +
        '</div>' +
        section('settings.entities', 'Сущности', entities) +
        section('settings.rules', 'Правила поиска', placeholderRow()) +
        section('settings.normalization', 'Нормализация', placeholderRow()) +
        section('settings.permissions', 'Права на объединение', placeholderRow()) +
        section('settings.prevent', 'Запрет создания дублей', placeholderRow()) +
        '</div>';
    }

    function renderSettingsSkeleton($modal_body) {
      injectStyles();
      var $skeleton = $(settingsSkeletonHtml());
      // Не трогаем служебные поля настроек (backend_url / security_key) —
      // их рисует амо. Скелет добавляем перед ними как превью будущих секций.
      var $firstField = $modal_body.find('input[name="backend_url"], input[name="security_key"]').first();
      if ($firstField.length) {
        var $wrap = $firstField.closest('.widget_settings_block__item_field');
        ($wrap.length ? $wrap : $firstField).before($skeleton);
      } else {
        $modal_body.prepend($skeleton);
      }
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
        // Делегированные обработчики переживают перерисовки карточки,
        // неймспейс .dub защищает от дублей при повторных вызовах bind_actions.
        // «Открыть» → список дублей; «Объединить» пока неактивна (слияние — след. слой).
        $(document)
          .off('click.dub')
          .on('click.dub', '.dub__open', function () {
            if (!$(this).prop('disabled')) {
              openDuplicatesModal();
            }
          })
          .on('click.dub', '.dub__merge', function () { /* слияние — следующий слой */ });
        return true;
      },

      settings: function ($modal_body) {
        renderSettingsSkeleton($modal_body);
        return true;
      },

      onSave: function () {
        return true;
      },

      destroy: function () {
        // Очистка слушателей / DOM / таймеров в неймспейсе .dub
        $(document).off('click.dub');
        $('.dub-toast').remove();
      },

      advancedSettings: function () {
        renderSettingsSkeleton($('.dub-advanced-settings-anchor').length
          ? $('.dub-advanced-settings-anchor')
          : $(document.body));
        return true;
      }
    };

    return this;
  };

  return CustomWidget;
});
