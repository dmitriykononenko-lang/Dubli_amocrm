/**
 * Hidden Field — виджет управления видимостью полей и страниц amoCRM.
 *
 * Режимы поля: O (открыть) · S (скрыть) · STAR (звёздочки) · B (блокировать) · V (воронка).
 * Конфигурация (матрица «поле × пользователь × сущность/воронка») хранится на backend,
 * виджет запрашивает её для текущего пользователя и применяет к DOM через MutationObserver.
 *
 * Это каркас (MVP). Селекторы DOM amoCRM зависят от версии интерфейса и помечены
 * комментарием // VERIFY — их нужно сверить на живом аккаунте перед продакшеном.
 */
define(['jquery', 'lib/components/base/modal', 'underscore'], function ($, Modal, _) {

  return function () {
    var self = this;

    // Режимы
    var MODE = { OPEN: 'O', HIDE: 'S', STAR: '*', BLOCK: 'B', FUNNEL: 'V' };
    var MODE_CYCLE = [MODE.OPEN, MODE.HIDE, MODE.STAR, MODE.BLOCK, MODE.FUNNEL];

    var observer = null;
    var config = null;            // нормализованная конфигурация для текущего пользователя
    var STAR_ATTR = 'data-hf-applied';

    // ---------- backend ----------

    function backendUrl() {
      var s = self.get_settings() || {};
      return (s.backend_url || '').replace(/\/+$/, '');
    }

    function apiToken() {
      var s = self.get_settings() || {};
      return s.api_token || '';
    }

    // Запрос к backend. account_id всегда в query (его читает ApiSecurityGuard на сервере),
    // security_key — в заголовке X-Security-Key. GET кладёт params в query, POST — тело JSON.
    //   apiCall('/api/meta')
    //   apiCall('/api/config', { query: { user_id: 123 } })
    //   apiCall('/api/matrix', { method: 'POST', body: { matrix: {...} } })
    function apiCall(path, opts) {
      opts = opts || {};
      var method = opts.method || 'GET';
      var query = $.extend({ account_id: AMOCRM.constant('account').id }, opts.query || {});
      var ajax = {
        url: backendUrl() + path + '?' + $.param(query),
        method: method,
        dataType: 'json',
        headers: { 'X-Security-Key': apiToken() }
      };
      if (method === 'POST') {
        ajax.contentType = 'application/json';
        ajax.data = JSON.stringify(opts.body || {});
      }
      return $.ajax(ajax);
    }

    function notify(key, color) {
      var dict = self.i18n('notify') || {};
      AMOCRM.notifications.add_alert({ text: dict[key] || key, color: color || 'white' });
    }

    // ---------- определение контекста ----------

    function entityTypeName() {
      var card = AMOCRM.data.current_card;
      if (!card) return null;
      // 1 = lead, 2 = contact, 3 = company, 12 = customer
      return ({ 1: 'lead', 2: 'contact', 3: 'company', 12: 'customer' })[card.type] || null;
    }

    function currentPipelineId() {
      var card = AMOCRM.data.current_card;
      try { return (card && card.model && card.model.get && card.model.get('pipeline_id')) || null; }
      catch (e) { return null; }
    }

    /**
     * Возвращает режим для поля с учётом контекста.
     * Приоритет: точечное правило (поле+сущность+воронка) → V (наследование воронки) → O.
     */
    function resolveMode(fieldId) {
      if (!config || !config.rules) return MODE.OPEN;
      var ent = entityTypeName();
      var pid = currentPipelineId();
      var rule = config.rules[fieldId];
      if (!rule) return MODE.OPEN;
      // rule: { entity: { lead: {pipelineId: mode, '*': mode}, contact:..., company:... } }
      var byEntity = rule[ent] || rule['*'];
      if (!byEntity) return MODE.OPEN;
      var mode = (pid && byEntity[pid]) || byEntity['*'] || MODE.OPEN;
      if (mode === MODE.FUNNEL) {
        // наследуем настройку воронки
        mode = (config.funnels && config.funnels[pid] && config.funnels[pid][fieldId]) || MODE.OPEN;
      }
      return mode;
    }

    // ---------- движок применения режимов к DOM ----------

    function starsFor(text) {
      var n = (text || '').replace(/\s/g, '').length || 4;
      return new Array(Math.min(n, 32) + 1).join('*');
    }

    function applyToNode($field, fieldId, mode) {
      if (mode === MODE.OPEN) return;
      $field.attr(STAR_ATTR, mode);

      if (mode === MODE.HIDE) {
        $field.hide();
        return;
      }
      if (mode === MODE.BLOCK) {
        $field.find('input, textarea, select').prop('readonly', true).prop('disabled', true);
        // перехват открытия редактора по клику
        $field.find('.control--select, .linked-form__field__value').css('pointer-events', 'none');
        return;
      }
      if (mode === MODE.STAR) {
        // VERIFY: контейнер значения поля
        var $val = $field.find('.linked-form__field__value, .cfc__value, .control-contacts__field__value');
        $val.each(function () {
          var $v = $(this);
          if ($v.attr('data-hf-star')) return;
          var raw = $v.text();
          $v.attr('data-hf-star', '1').attr('title', '');
          $v.text(starsFor(raw));
        });
        return;
      }
    }

    /**
     * Проходит по полям на странице (карточка / список / канбан) и применяет режимы.
     * VERIFY: набор селекторов под актуальную вёрстку amoCRM.
     */
    function sweep(root) {
      if (!config) return;
      var user = AMOCRM.constant('user');
      if (user && user.is_admin) return;            // админ видит всё
      var s = self.get_settings() || {};
      if (s.engine_enabled === '0') return;

      // VERIFY: поле карточки с идентификатором поля в data-id / data-field-id
      $(root).find('[data-id][class*="field"], .linked-form__field[data-id], div[data-field-id]').each(function () {
        var $field = $(this);
        if ($field.attr(STAR_ATTR)) return;
        var fieldId = $field.attr('data-field-id') || $field.attr('data-id');
        if (!fieldId) return;
        applyToNode($field, String(fieldId), resolveMode(String(fieldId)));
      });
    }

    function startObserver() {
      if (observer) return;
      sweep(document);
      observer = new MutationObserver(_.debounce(function () { sweep(document); }, 30));
      observer.observe(document.body, { childList: true, subtree: true });
    }

    function stopObserver() {
      if (observer) { observer.disconnect(); observer = null; }
    }

    function loadConfigThen(cb) {
      apiCall('/api/config', { query: { user_id: AMOCRM.constant('user').id } })
        .done(function (resp) { config = resp || { rules: {}, funnels: {} }; cb && cb(); })
        .fail(function () { config = { rules: {}, funnels: {} }; cb && cb(); });
    }

    // ---------- матрица (advancedSettings) ----------

    function renderMatrix($mount) {
      apiCall('/api/meta')
        .done(function (meta) {
          // meta: { fields:[{id,name,entity}], users:[{id,name}], pipelines:[{id,name}], matrix:{...}, groups:[...] }
          $mount.html(self.render(
            { render: self.params.tmpl('templates/advanced_settings') },
            { meta: meta, modes: MODE_CYCLE }
          ));
        })
        .fail(function () { notify('meta_failed', 'red'); });
    }

    function nextMode(cur) {
      var i = MODE_CYCLE.indexOf(cur);
      return MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
    }

    // ---------- callbacks ----------

    this.callbacks = {

      render: function () { return true; },

      init: function () {
        var s = self.get_settings();
        if (!s || !s.backend_url) return true;     // не настроен — не запускаем движок
        loadConfigThen(startObserver);
        return true;
      },

      bind_actions: function () {
        var ns = '.hf-' + self.params.widget_code;

        // Матрица: клик по ячейке циклически меняет режим
        $(document).off('click' + ns + '-cell').on('click' + ns + '-cell', '.js-hf-cell', function () {
          var $c = $(this);
          var m = nextMode($c.attr('data-mode') || MODE.OPEN);
          $c.attr('data-mode', m).text(m);
        });

        // Заголовок строки/столбца — массовое применение
        $(document).off('click' + ns + '-row').on('click' + ns + '-row', '.js-hf-row-mode', function () {
          var m = $(this).attr('data-mode');
          $(this).closest('tr').find('.js-hf-cell').attr('data-mode', m).text(m);
        });
        $(document).off('click' + ns + '-col').on('click' + ns + '-col', '.js-hf-col-mode', function () {
          var m = $(this).attr('data-mode'), idx = $(this).closest('th').index();
          $('.js-hf-matrix tbody tr').each(function () {
            $(this).find('.js-hf-cell').eq(idx - 1).attr('data-mode', m).text(m);
          });
        });

        // Сохранение матрицы
        $(document).off('click' + ns + '-save').on('click' + ns + '-save', '.js-hf-save', function () {
          var matrix = {};
          $('.js-hf-matrix .js-hf-cell').each(function () {
            var $c = $(this);
            matrix[$c.attr('data-key')] = $c.attr('data-mode') || MODE.OPEN;
          });
          apiCall('/api/matrix', { method: 'POST', body: { matrix: matrix } })
            .done(function () { notify('saved'); })
            .fail(function () { notify('save_failed', 'red'); });
        });

        return true;
      },

      settings: function ($modal_body) {
        $modal_body.off('click.hf-save').on('click.hf-save', '.widget_settings_block__btn_save', function (e) {
          var url = $modal_body.find('input[name="backend_url"]').val();
          if (!/^https:\/\//.test(url || '')) {
            e.preventDefault(); e.stopImmediatePropagation();
            notify('need_https', 'red');
            return false;
          }
        });
        return true;
      },

      advancedSettings: function () {
        var $mount = $('.list-pipelines__hidden, .widget_advanced_settings');
        $mount.html('<div class="hf-loading">' + (self.i18n('matrix').loading || '...') + '</div>');
        renderMatrix($mount);
        return true;
      },

      destroy: function () {
        stopObserver();
        $(document).off('.hf-' + self.params.widget_code +
          '-cell .hf-' + self.params.widget_code + '-row .hf-' + self.params.widget_code +
          '-col .hf-' + self.params.widget_code + '-save');
      }
    };

    return this;
  };
});
