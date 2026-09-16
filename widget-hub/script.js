/**
 * Ko:agency — центр виджетов (лаунчер).
 *
 * Приватный виджет-лаунчер: единственная задача — из настроек аккаунта amoCRM открыть
 * панель управления нашими виджетами (подписки/оплаты/счета) на dubli.koagency.ru/vendor/panel.
 * Данные amoCRM не читает, бэкенд не дёргает — просто фирменный экран с кнопкой.
 *
 * Соглашения (как в основном виджете «Дубли»): AMD-конструктор; callbacks render/init/
 * bind_actions возвращают true; self.system() не вызывается в конструкторе (инжектится
 * позже); CSS инлайном с меткой сборки; слушатели в неймспейсе .kohub и очистка в destroy.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;

    var STYLE_ID = 'kohub-styles';
    var WIDGET_BUILD = '2026-09-16.1';
    // Панель управления виджетами Ko:agency (открывается в новой вкладке).
    var PANEL_URL = 'https://dubli.koagency.ru/vendor/panel';

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

    /* --------------------------------- стили --------------------------------- */

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) {
        return;
      }
      var css = [
        /* фирменная тема Ko:agency: Roboto, красный акцент #d22730 */
        '.kohub{font-family:"Roboto",Arial,"Helvetica Neue",sans-serif;color:#141414;box-sizing:border-box;max-width:760px;margin:28px 0 48px}',
        '.kohub *,.kohub *::before,.kohub *::after{box-sizing:border-box}',
        '.kohub__head{display:flex;align-items:center;gap:10px;margin:0 0 18px;flex-wrap:wrap}',
        '.kohub__badge{flex:0 0 auto;width:26px;height:26px;border-radius:7px;background:#d22730;color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center}',
        '.kohub__brand{font-weight:700;color:#141414;font-size:15px}',
        '.kohub__card{border:1px solid #e7e9ec;border-radius:12px;padding:22px 24px;background:#fff}',
        '.kohub__title{font-size:20px;font-weight:700;color:#141414;margin:0 0 6px}',
        '.kohub__subtitle{font-size:14px;color:#6b7178;line-height:1.5;margin:0 0 18px}',
        '.kohub__cta{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}',
        '.kohub__btn{-webkit-appearance:none;appearance:none;border:0;cursor:pointer;background:#d22730;color:#fff;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;font-family:inherit}',
        '.kohub__btn:hover{background:#b31f27}',
        '.kohub__hint{font-size:12px;color:#98a0a8}',
        '.kohub__products{margin-top:22px;padding-top:18px;border-top:1px solid #f0f1f3}',
        '.kohub__products-title{font-size:13px;font-weight:700;color:#141414;text-transform:uppercase;letter-spacing:.3px;margin:0 0 12px}',
        '.kohub__product{display:flex;align-items:center;gap:12px;padding:10px 0}',
        '.kohub__product+.kohub__product{border-top:1px solid #f5f6f7}',
        '.kohub__ava{flex:0 0 auto;width:34px;height:34px;border-radius:9px;background:#fdeced;color:#d22730;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center}',
        '.kohub__pname{font-size:14px;font-weight:600;color:#141414}',
        '.kohub__pdesc{display:block;font-size:12px;color:#98a0a8;margin-top:2px;font-weight:400}',
        '.kohub__more{font-size:12px;color:#98a0a8;margin-top:12px}',
        '.kohub__foot{font-size:12px;color:#b3b9c0;margin-top:16px}'
      ].join('');
      var styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.setAttribute('data-v', WIDGET_BUILD);
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    }

    /* --------------------------------- разметка -------------------------------- */

    function productRow(letter, nameKey, nameFb, descKey, descFb) {
      return '<div class="kohub__product">' +
        '<span class="kohub__ava">' + escapeHtml(letter) + '</span>' +
        '<span class="kohub__pinfo">' +
          '<span class="kohub__pname">' + escapeHtml(t(nameKey, nameFb)) + '</span>' +
          '<span class="kohub__pdesc">' + escapeHtml(t(descKey, descFb)) + '</span>' +
        '</span>' +
        '</div>';
    }

    function launcherHtml() {
      return '<div class="kohub">' +
        '<div class="kohub__head">' +
          '<span class="kohub__badge">K</span>' +
          '<span class="kohub__brand">' + escapeHtml(t('hub.brand', 'Ko:agency')) + '</span>' +
        '</div>' +
        '<div class="kohub__card">' +
          '<h2 class="kohub__title">' + escapeHtml(t('hub.title', 'Центр управления виджетами')) + '</h2>' +
          '<p class="kohub__subtitle">' + escapeHtml(t('hub.subtitle',
            'Единая панель для подписок, оплат и продления по всем нашим виджетам для amoCRM.')) + '</p>' +
          '<div class="kohub__cta">' +
            '<button type="button" class="kohub__btn kohub__open">' +
              escapeHtml(t('hub.open_panel', 'Открыть панель управления виджетами')) + '</button>' +
            '<span class="kohub__hint">' + escapeHtml(t('hub.open_hint', 'Панель откроется в новой вкладке.')) + '</span>' +
          '</div>' +
          '<div class="kohub__products">' +
            '<div class="kohub__products-title">' + escapeHtml(t('hub.products_title', 'Наши виджеты')) + '</div>' +
            productRow('Д', 'hub.product_dubli', 'Дубли', 'hub.product_dubli_desc',
              'Поиск и объединение дублей контактов, компаний и сделок') +
            '<div class="kohub__more">' + escapeHtml(t('hub.more_soon',
              'Другие виджеты Ko:agency подключаются к этой же панели.')) + '</div>' +
          '</div>' +
          '<div class="kohub__foot">' + escapeHtml(t('hub.footer',
            'Ko:agency — внедрение и автоматизация amoCRM')) + '</div>' +
        '</div>' +
        '</div>';
    }

    // Монтируем лаунчер в переданный контейнер, не затирая соседний контент amoCRM:
    // удаляем только свой предыдущий якорь и добавляем новый.
    function mount($container) {
      injectStyles();
      var $host = $container && $container.length ? $container : $(document.body);
      $host.find('.kohub-anchor').remove();
      var $anchor = $('<div class="kohub-anchor"></div>').html(launcherHtml());
      $host.append($anchor);
    }

    // Экран advanced_settings: amoCRM рисует заголовок из advanced.title в колонке контента.
    // Монтируемся сразу за ним (та же колонка); фолбэк — контейнер страницы настроек или body.
    function mountAdvanced() {
      injectStyles();
      var titleText = (t('advanced.title', '') || '').replace(/\s+/g, ' ').trim();
      var $title = $();
      if (titleText) {
        $('h1, h2, h3').each(function () {
          if ($title.length) return;
          if ($(this).text().replace(/\s+/g, ' ').trim() === titleText) $title = $(this);
        });
      }
      $('.kohub-anchor').remove();
      var $anchor = $('<div class="kohub-anchor"></div>').html(launcherHtml());
      if ($title.length) {
        $title.after($anchor);
      } else {
        var $area = $('.widget_advanced_settings, .list-pipelines__hidden').first();
        ($area.length ? $area : $(document.body)).append($anchor);
      }
    }

    function openPanel() {
      try {
        window.open(PANEL_URL, '_blank', 'noopener,noreferrer');
      } catch (e) {
        window.location.href = PANEL_URL;
      }
    }

    /* --------------------------------- callbacks --------------------------------- */

    this.callbacks = {
      render: function () {
        return true;
      },

      init: function () {
        return true;
      },

      bind_actions: function () {
        // Делегированный слушатель в неймспейсе .kohub — переживает перерисовки, чистится в destroy.
        $(document)
          .off('click.kohub')
          .on('click.kohub', '.kohub__open', function () {
            openPanel();
          });
        return true;
      },

      settings: function ($modal_body) {
        mount($modal_body);
        return true;
      },

      advancedSettings: function () {
        mountAdvanced();
        return true;
      },

      onSave: function () {
        return true;
      },

      destroy: function () {
        $(document).off('click.kohub');
        $('.kohub-anchor').remove();
      }
    };

    return this;
  };

  return CustomWidget;
});
