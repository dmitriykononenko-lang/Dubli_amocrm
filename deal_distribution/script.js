/**
 * Распределение сделок — виджет автоназначения ответственного на входящие сделки.
 *
 * Стратегии (реализуются на backend): round_robin | by_load | by_rules.
 * Виджет = конфигуратор (страница «Правила распределения») + панель в карточке сделки
 * (кому и почему назначена, кнопка «Переназначить»). Само распределение делает backend
 * по вебхуку amoCRM на создание сделки (см. docs/spec.md).
 *
 * Backend-контракт (все ответы — JSON, account_id в query, ключ в заголовке X-Security-Key):
 *   GET  /api/meta                      → { users:[{id,name}], pipelines:[{id,name}] }
 *   GET  /api/config                    → { pool, strategy, scope, skip_absent, rules, sla }
 *   POST /api/config    { ...config }   → { ok:true }
 *   GET  /api/assignment?lead_id=       → { user_id, user_name, assigned_at, reason, strategy } | 404
 *   POST /api/assignment/reassign {lead_id} → { user_id, user_name, ... }
 */
define(['jquery', 'lib/components/base/modal', 'underscore'], function ($, Modal, _) {

  return function () {
    var self = this;

    // ---------- настройки/бэкенд ----------

    function backendUrl() {
      var s = self.get_settings() || {};
      return (s.backend_url || '').replace(/\/+$/, '');
    }
    function apiToken() {
      var s = self.get_settings() || {};
      return s.api_token || '';
    }
    function isConfigured() {
      return /^https:\/\//.test(backendUrl());
    }

    // account_id — в query (его читает ApiSecurityGuard), ключ — в заголовке.
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

    // ---------- утилиты ----------

    function t(path) {
      var p = String(path).split('.');
      var sect = self.i18n(p[0]) || {};
      return (sect && sect[p[1]]) || path;
    }
    function notify(key, color) {
      var dict = self.i18n('notify') || {};
      AMOCRM.notifications.add_alert({ text: dict[key] || key, color: color || 'white' });
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function fmtTs(ts) {
      if (!ts) return '';
      try { return new Date(String(ts).length <= 10 ? ts * 1000 : ts).toLocaleString(); }
      catch (e) { return String(ts); }
    }
    function ns() { return '.dd-' + (self.params && self.params.widget_code || 'w'); }

    function injectStyles() {
      if (document.getElementById('dd-card-css')) return;
      var css =
        '.dd-card{font-size:13px;color:#2b2f33}' +
        '.dd-card__h{font-weight:600;margin:0 0 6px}' +
        '.dd-card__row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}' +
        '.dd-card__k{color:#7a8085}.dd-card__v{text-align:right;font-weight:500}' +
        '.dd-card__hint{color:#7a8085;padding:4px 0}' +
        '.dd-card .dd-btn{border:1px solid #cfd6da;background:#fff;border-radius:3px;padding:5px 10px;cursor:pointer;font-size:13px}';
      var st = document.createElement('style');
      st.id = 'dd-card-css';
      st.textContent = css;
      document.head.appendChild(st);
    }

    // ---------- карточка сделки ----------

    function currentLeadId() {
      var c = AMOCRM.data && AMOCRM.data.current_card;
      return (c && c.id) || null;
    }

    function cardShell() {
      return '<div class="dd-card"><div class="dd-card__h">' + esc(t('card.title')) + '</div>' +
             '<div class="js-dd-card-body dd-card__body">' + esc(t('card.loading')) + '</div></div>';
    }
    function hint(text) { return '<div class="dd-card__hint">' + esc(text) + '</div>'; }

    function assignmentHtml(a) {
      a = a || {};
      function row(k, v) {
        return '<div class="dd-card__row"><span class="dd-card__k">' + esc(k) +
               '</span><span class="dd-card__v">' + esc(v) + '</span></div>';
      }
      var html = row(t('card.assigned_to'), a.user_name || ('#' + (a.user_id || '?')));
      if (a.assigned_at) html += row(t('card.at'), fmtTs(a.assigned_at));
      if (a.reason) html += row(t('card.reason'), a.reason);
      if (a.strategy) html += row(t('card.strategy'), a.strategy);
      html += '<button type="button" class="js-dd-reassign dd-btn" style="margin-top:8px">' +
              esc(t('card.reassign')) + '</button>';
      return html;
    }

    function fillCard() {
      var $b = $('.js-dd-card-body');
      if (!$b.length) return;
      if (!isConfigured()) { $b.html(hint(t('card.not_configured'))); return; }
      var id = currentLeadId();
      if (!id) { $b.html(hint(t('card.error'))); return; }
      apiCall('/api/assignment', { query: { lead_id: id } })
        .done(function (r) { $b.html(assignmentHtml(r || {})); })
        .fail(function (x) {
          $b.html(hint((x && x.status === 404) ? t('card.not_distributed') : t('card.error')));
        });
    }

    // ---------- страница «Правила распределения» ----------

    function normalizeCfg(c) {
      c = c || {};
      return {
        pool: (c.pool || []).map(String),
        scope: (c.scope || []).map(String),
        strategy: c.strategy || 'round_robin',
        skip_absent: !!c.skip_absent,
        rules: (c.rules || []).map(function (r) {
          return { field: r.field || 'source', value: r.value || '', user_id: String(r.user_id || '') };
        }),
        sla: { enabled: !!(c.sla && c.sla.enabled), minutes: (c.sla && c.sla.minutes) || 15 }
      };
    }

    function renderConfig($mount) {
      $.when(apiCall('/api/meta'), apiCall('/api/config'))
        .done(function (metaR, cfgR) {
          var meta = (metaR && metaR[0]) || {};
          var cfg = (cfgR && cfgR[0]) || {};
          var users = (meta.users || []).map(function (u) { return { id: String(u.id), name: u.name }; });
          var pipelines = (meta.pipelines || []).map(function (p) { return { id: String(p.id), name: p.name }; });
          self._users = users;
          var html = self.render(
            { render: self.params.tmpl('templates/advanced_settings') },
            { i18n: self.i18n('adv'), meta: { users: users, pipelines: pipelines }, config: normalizeCfg(cfg) }
          );
          $mount.html(html);
        })
        .fail(function () { notify('load_failed', 'red'); $mount.html(hint(t('card.error'))); });
    }

    function ruleRowHtml() {
      var a = self.i18n('adv') || {};
      var users = (self._users || []).map(function (u) {
        return '<option value="' + esc(u.id) + '">' + esc(u.name) + '</option>';
      }).join('');
      return '<tr class="js-dd-rule">' +
        '<td class="dd-when">' + esc(a.rule_when) + '</td>' +
        '<td><select class="js-dd-rc-field">' +
          '<option value="source">' + esc(a.cond_source) + '</option>' +
          '<option value="pipeline">' + esc(a.cond_pipeline) + '</option>' +
          '<option value="budget_gt">' + esc(a.cond_budget_gt) + '</option>' +
          '<option value="tag">' + esc(a.cond_tag) + '</option>' +
        '</select></td>' +
        '<td><input class="js-dd-rc-value" placeholder="' + esc(a.rule_value) + '"></td>' +
        '<td class="dd-then">' + esc(a.rule_then) + '</td>' +
        '<td><select class="js-dd-rc-user">' + users + '</select></td>' +
        '<td><span class="js-dd-rule-del dd-del">×</span></td>' +
      '</tr>';
    }

    function collectConfig() {
      var pool = $('.js-dd-pool:checked').map(function () { return $(this).val(); }).get();
      var scope = $('.js-dd-scope:checked').map(function () { return $(this).val(); }).get();
      var rules = [];
      $('.js-dd-rule').each(function () {
        var $r = $(this);
        var user = $r.find('.js-dd-rc-user').val();
        if (!user) return;
        rules.push({
          field: $r.find('.js-dd-rc-field').val(),
          value: $r.find('.js-dd-rc-value').val() || '',
          user_id: user
        });
      });
      return {
        pool: pool,
        scope: scope,
        strategy: $('.js-dd-strategy:checked').val() || 'round_robin',
        skip_absent: $('.js-dd-skip').is(':checked'),
        rules: rules,
        sla: { enabled: $('.js-dd-sla').is(':checked'), minutes: parseInt($('.js-dd-sla-min').val(), 10) || 15 }
      };
    }

    // ---------- callbacks ----------

    this.callbacks = {

      render: function () {
        injectStyles();
        if (!currentLeadId()) return true;          // не карточка сделки — панель не рисуем
        self.render_template({ caption: { class_name: 'dd-card' }, body: cardShell(), render: '' });
        fillCard();
        return true;
      },

      init: function () { return true; },

      bind_actions: function () {
        var n = ns();

        $(document).off('click' + n + '-add').on('click' + n + '-add', '.js-dd-rule-add', function () {
          $('.js-dd-rules').append(ruleRowHtml());
        });
        $(document).off('click' + n + '-del').on('click' + n + '-del', '.js-dd-rule-del', function () {
          $(this).closest('.js-dd-rule').remove();
        });
        $(document).off('click' + n + '-save').on('click' + n + '-save', '.js-dd-save', function () {
          apiCall('/api/config', { method: 'POST', body: collectConfig() })
            .done(function () { notify('saved'); })
            .fail(function () { notify('save_failed', 'red'); });
        });
        $(document).off('click' + n + '-re').on('click' + n + '-re', '.js-dd-reassign', function () {
          var id = currentLeadId();
          if (!id) return;
          apiCall('/api/assignment/reassign', { method: 'POST', body: { lead_id: id } })
            .done(function () { notify('reassign_ok'); fillCard(); })
            .fail(function () { notify('reassign_failed', 'red'); });
        });
        return true;
      },

      settings: function ($modal_body) {
        $modal_body.off('click.dd-save').on('click.dd-save', '.widget_settings_block__btn_save', function (e) {
          var url = $modal_body.find('input[name="backend_url"]').val();
          if (url && !/^https:\/\//.test(url)) {
            e.preventDefault(); e.stopImmediatePropagation();
            notify('need_https', 'red');
            return false;
          }
        });
        return true;
      },

      advancedSettings: function () {
        var $mount = $('.list-pipelines__hidden, .widget_advanced_settings');
        $mount.html(hint(t('card.loading')));
        renderConfig($mount);
        return true;
      },

      onSave: function () { return true; },

      destroy: function () {
        $(document).off(ns() + '-add').off(ns() + '-del').off(ns() + '-save').off(ns() + '-re');
      }
    };

    return this;
  };
});
