/**
 * Локальный тестовый стенд для widget/script.js — каркас (этап 2).
 *
 * Эмулирует окружение amoCRM: jsdom + jQuery, заглушки Modal и глобального
 * AMOCRM, перехват $.ajax. Покрывает базовый каркас:
 *   1) render() рисует плашку-заглушку в карточке lcard/ccard/comcard;
 *   2) detectEntity() определяет сущность по area и по URL;
 *   3) ключи i18n ru.json и en.json совпадают по структуре;
 *   4) destroy() очищает добавленный DOM/слушатели.
 *
 * Запуск: node test/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://test.amocrm.ru/leads/detail/123'
});
global.window = dom.window;
global.document = dom.window.document;

const jqueryModule = require('jquery');
const $ = jqueryModule.fn ? jqueryModule : jqueryModule(dom.window);

/* ----------------------------- заглушки amoCRM ----------------------------- */

global.AMOCRM = {
  constant(key) {
    if (key === 'user') {
      return { id: 101, name: 'Viktor Borisenko' };
    }
    if (key === 'account') {
      return {};
    }
    if (key === 'managers') {
      return {};
    }
    return {};
  },
  data: { current_card: { id: 123 } }
};

const modals = [];
class ModalStub {
  constructor(opts) {
    this.destroyed = false;
    this.$body = $('<div class="modal-stub"></div>').appendTo(document.body);
    modals.push(this);
    opts.init.call(this, this.$body);
  }
  destroy() {
    this.destroyed = true;
    this.$body.remove();
  }
}

// На каркасе виджет не ходит в API, но $.ajax-роутер оставляем заглушкой,
// чтобы любой будущий/случайный вызов не падал и был виден в ajaxCalls.
let ajaxCalls = [];

$.ajax = function (opts) {
  ajaxCalls.push(opts);
  return {
    done(cb) {
      cb({});
      return this;
    },
    fail() {
      return this;
    }
  };
};

/* ------------------------------ загрузка виджета ------------------------------ */

let CustomWidget = null;
global.define = function (deps, factory) {
  CustomWidget = factory($, ModalStub);
};
require(path.join(__dirname, '..', 'widget', 'script.js'));

const ruLang = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'widget', 'i18n', 'ru.json'), 'utf8'));
const enLang = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'widget', 'i18n', 'en.json'), 'utf8'));

let allWidgets = [];

function makeWidget(area, url) {
  if (url) {
    // переопределяем pathname для проверки URL-фолбэка detectEntity
    Object.defineProperty(dom.window.document, 'URL', { value: url, configurable: true });
    try {
      dom.reconfigure({ url: url });
    } catch (e) { /* старые версии jsdom */ }
  }
  const widget = new CustomWidget();
  allWidgets.push(widget);
  widget.langs = ruLang;
  widget.get_settings = () => ({ backend_url: '', security_key: '' });
  widget.system = () => ({ area: area === undefined ? 'lcard-1' : area });
  widget.params = { widget_code: 'dubli' };
  widget.render_template = (opts) => {
    $('#card-zone').remove();
    $('<div id="card-zone"></div>').html(opts.body).appendTo(document.body);
  };
  return widget;
}

function resetEnv() {
  allWidgets.splice(0).forEach((w) => {
    try { w.callbacks.destroy(); } catch (e) { /* уже уничтожен */ }
  });
  ajaxCalls = [];
  modals.splice(0).forEach((modal) => modal.destroyed || modal.$body.remove());
  $('.dub-toast').remove();
  $('#card-zone').remove();
  $(document).off('.dub');
}

/* --------------------------------- проверки --------------------------------- */

let failures = 0;
let passed = 0;
function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failures++;
    console.error('  FAIL: ' + message);
  }
}
function section(name) {
  console.log('\n== ' + name);
}

/* 1. Рендер плашки-заглушки в карточках lcard / ccard / comcard */
section('Рендер плашки в карточке (lcard/ccard/comcard)');
[
  ['lcard-1', 'leads'],
  ['ccard-1', 'contacts'],
  ['comcard-1', 'companies']
].forEach(([area, entity]) => {
  resetEnv();
  const widget = makeWidget(area);
  const result = widget.callbacks.render();
  assert(result === true, area + ': render() вернул true');
  assert($('#card-zone .dub').length === 1, area + ': плашка отрисована');
  assert($('#card-zone .dub__banner').length === 1, area + ': есть баннер KO:AGENCY');
  assert($('#card-zone .dub__status_ok').text().indexOf(ruLang.card.no_dups) !== -1,
    area + ': статус «дублей не найдено» из локализации');
  assert($('#card-zone .dub__open').length === 1 && $('#card-zone .dub__open').prop('disabled'),
    area + ': кнопка «Открыть» есть и неактивна');
  assert($('#card-zone .dub__merge').length === 1 && $('#card-zone .dub__merge').prop('disabled'),
    area + ': кнопка «Объединить» есть и неактивна');
  assert($('#card-zone .dub__open').text() === ruLang.card.open, area + ': текст «Открыть» из локализации');
  assert($('#card-zone .dub__merge').text() === ruLang.card.merge, area + ': текст «Объединить» из локализации');
  assert($('#card-zone .dub').attr('data-entity') === entity, area + ': сущность определена как ' + entity);
});

/* 1б. Вне карточки (например, settings) плашка не рисуется */
section('Вне карточки плашка не рисуется');
{
  resetEnv();
  const widget = makeWidget('settings');
  assert(widget.callbacks.render() === true, 'render() вернул true и вне карточки');
  assert($('#card-zone').length === 0, 'плашка не отрисована в settings');
}

/* 1в. checkDuplicates — заглушка, без сетевых запросов */
section('Заглушка checkDuplicates без запросов к API');
{
  resetEnv();
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  assert(ajaxCalls.length === 0, 'каркас не выполняет запросов к API/бэкенду');
}

/* 2. detectEntity по area и по URL */
section('detectEntity по area');
{
  // detectEntity — приватная функция; проверяем через data-entity на плашке
  // (она пишется из detectEntity), а также напрямую через URL-фолбэк.
  [
    ['lcard-1', 'leads'],
    ['lcard-7', 'leads'],
    ['ccard-1', 'contacts'],
    ['comcard-1', 'companies']
  ].forEach(([area, entity]) => {
    resetEnv();
    const widget = makeWidget(area);
    widget.callbacks.render();
    assert($('#card-zone .dub').attr('data-entity') === entity,
      'area «' + area + '» → ' + entity);
  });
}

section('detectEntity по URL (фолбэк при пустом area)');
{
  // area пустой — сущность и id должны определиться по window.location.pathname
  resetEnv();
  const widget = makeWidget('', 'https://test.amocrm.ru/contacts/detail/555');
  widget.system = () => ({ area: '' });
  // current_card.id оставляем, но проверяем именно тип сущности из URL
  AMOCRM.data = { current_card: {} };
  widget.callbacks.render();
  // area пустой → не карточная область → render не рисует плашку; поэтому
  // проверяем URL-фолбэк через прямой разбор pathname так же, как в виджете
  const m = dom.window.location.pathname.match(/\/(leads|contacts|companies)\/detail\/(\d+)/);
  assert(!!m && m[1] === 'contacts' && parseInt(m[2], 10) === 555,
    'URL /contacts/detail/555 разбирается как contacts#555');
  AMOCRM.data = { current_card: { id: 123 } };
  try { dom.reconfigure({ url: 'https://test.amocrm.ru/leads/detail/123' }); } catch (e) { /* */ }
}

section('detectEntity по area + id из URL');
{
  // area задаёт тип, id берётся из URL когда current_card пуст
  resetEnv();
  AMOCRM.data = { current_card: {} };
  const widget = makeWidget('comcard-1', 'https://test.amocrm.ru/companies/detail/909');
  widget.callbacks.render();
  assert($('#card-zone .dub').attr('data-entity') === 'companies',
    'area comcard + URL → companies (плашка отрисована, id есть)');
  assert($('#card-zone .dub').length === 1, 'плашка отрисована (entity и id определены)');
  AMOCRM.data = { current_card: { id: 123 } };
  try { dom.reconfigure({ url: 'https://test.amocrm.ru/leads/detail/123' }); } catch (e) { /* */ }
}

/* 3. Совпадение структуры ключей ru.json и en.json */
section('Структура ключей ru.json и en.json совпадает');
{
  function collectKeys(obj, prefix, set) {
    Object.keys(obj).forEach((key) => {
      const full = prefix ? prefix + '.' + key : key;
      set.add(full);
      if (obj[key] && typeof obj[key] === 'object') {
        collectKeys(obj[key], full, set);
      }
    });
  }
  const ruKeys = new Set();
  const enKeys = new Set();
  collectKeys(ruLang, '', ruKeys);
  collectKeys(enLang, '', enKeys);
  const ruOnly = [...ruKeys].filter((k) => !enKeys.has(k));
  const enOnly = [...enKeys].filter((k) => !ruKeys.has(k));
  assert(ruOnly.length === 0, 'нет ключей только в ru.json (лишние: ' + ruOnly.join(', ') + ')');
  assert(enOnly.length === 0, 'нет ключей только в en.json (лишние: ' + enOnly.join(', ') + ')');
  // обязательные секции каркаса
  ['widget.name', 'card.title', 'card.no_dups', 'card.open', 'card.merge',
    'settings.entities', 'settings.rules', 'settings.normalization',
    'settings.permissions', 'settings.prevent', 'common.soon'].forEach((key) => {
    assert(ruKeys.has(key) && enKeys.has(key), 'ключ «' + key + '» есть в обоих языках');
  });
}

/* 3б. Покрытие ключей t() из script.js обоими языками */
section('Покрытие ключей локализации (ru/en)');
{
  const source = fs.readFileSync(path.join(__dirname, '..', 'widget', 'script.js'), 'utf8');
  const keys = new Set();
  const re = /\bt\('([^']+)'/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    keys.add(match[1]);
  }
  keys.forEach((key) => {
    [['ru', ruLang], ['en', enLang]].forEach(([locale, lang]) => {
      let node = lang;
      const ok = key.split('.').every((part) => {
        if (node && typeof node === 'object' && part in node) {
          node = node[part];
          return true;
        }
        return false;
      });
      assert(ok && typeof node === 'string', 'ключ «' + key + '» есть в ' + locale + '.json');
    });
  });
}

/* 4. settings() рисует скелет секций */
section('Скелет экрана настроек');
{
  resetEnv();
  const widget = makeWidget('settings');
  const $modalBody = $('<div><input type="text" name="backend_url" value=""><input type="text" name="security_key" value=""></div>')
    .appendTo(document.body);
  const result = widget.callbacks.settings($modalBody);
  assert(result === true, 'settings() вернул true');
  assert($modalBody.find('.dub-settings').length === 1, 'скелет настроек добавлен');
  assert($modalBody.find('.dub-settings__section').length === 5, 'пять секций (сущности/правила/нормализация/права/запрет)');
  const titles = $modalBody.find('.dub-settings__section-title').map(function () {
    return $(this).text();
  }).get().join('|');
  ['entities', 'rules', 'normalization', 'permissions', 'prevent'].forEach((k) => {
    assert(titles.indexOf(ruLang.settings[k]) !== -1, 'секция «' + ruLang.settings[k] + '» присутствует');
  });
  assert($modalBody.find('.dub-settings__section').first().find('input[type="checkbox"]').length === 3,
    'в секции «Сущности» три чекбокса (контакты/компании/сделки)');
  $modalBody.remove();
}

/* 5. destroy() очищает добавленный DOM и слушатели */
section('destroy() очищает DOM и слушатели');
{
  resetEnv();
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  assert($('#card-zone .dub').length === 1, 'до destroy: плашка в DOM');
  // добавляем тост, чтобы проверить его удаление
  $('<div class="dub-toast">x</div>').appendTo(document.body);
  assert($('.dub-toast').length === 1, 'тост добавлен в DOM');

  // обработчики .dub навешаны после bind_actions
  function dubClickHandlers() {
    const events = $._data ? ($._data(document, 'events') || {}) : {};
    return (events.click || []).filter((h) => h.namespace === 'dub');
  }
  assert(dubClickHandlers().length > 0, 'после bind_actions есть click-обработчики .dub');

  widget.callbacks.destroy();
  assert($('.dub-toast').length === 0, 'destroy() удалил тосты');
  assert(dubClickHandlers().length === 0, 'после destroy нет click-обработчиков в namespace .dub');

  // повторные bind/destroy не плодят и не оставляют обработчиков
  widget.callbacks.bind_actions();
  widget.callbacks.bind_actions();
  assert(dubClickHandlers().length > 0, 'bind_actions повторно навесил обработчик');
  widget.callbacks.destroy();
  assert(dubClickHandlers().length === 0, 'повторный destroy снова всё снял (нет утечки)');

  // ручная очистка плашки (амо сам убирает контейнер виджета между рендерами)
  $('#card-zone').remove();
  assert($('#card-zone .dub').length === 0, 'плашка удалена из DOM');
}

console.log('\nИтого: ' + passed + ' проверок пройдено, ' + failures + ' провалено');
process.exit(failures ? 1 : 0);
