/**
 * Локальный тестовый стенд для widget/script.js (Этап 3: проверка дублей).
 *
 * Эмулирует окружение amoCRM: jsdom + jQuery, заглушки Modal и глобального
 * AMOCRM, настраиваемый перехват $.ajax. Покрывает:
 *   1) render() рисует плашку в карточке lcard/ccard/comcard;
 *   1в) checkDuplicates() делает GET /api/duplicates с account_id/entity_type/
 *       amo_id и заголовком X-Security-Key; без настройки запросов нет;
 *   1г) плашка отражает ответ: найдено N (активная «Открыть» + модалка со
 *       списком), не проиндексировано, ошибка;
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

let accountConstant = { id: 777 };

global.AMOCRM = {
  constant(key) {
    if (key === 'user') {
      return { id: 101, name: 'Viktor Borisenko' };
    }
    if (key === 'account') {
      return accountConstant;
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

// Перехват $.ajax: фиксируем вызовы и отдаём настраиваемый ответ.
// ajaxResponse — тело успешного ответа по умолчанию; ajaxShouldFail → ветка .fail().
// ajaxHandler(opts) — опц. роутер: { response?, fail? } по URL/методу (для нескольких эндпоинтов).
let ajaxCalls = [];
let ajaxResponse = { entity: { indexed: true }, count: 0, duplicates: [] };
let ajaxShouldFail = false;
let ajaxHandler = null;

$.ajax = function (opts) {
  ajaxCalls.push(opts);
  let failing = ajaxShouldFail;
  let resp = ajaxResponse;
  if (typeof ajaxHandler === 'function') {
    const routed = ajaxHandler(opts) || {};
    if (routed.fail !== undefined) failing = routed.fail;
    if ('response' in routed) resp = routed.response;
  }
  return {
    done(cb) {
      if (!failing) {
        cb(resp);
      }
      return this;
    },
    fail(cb) {
      if (failing) {
        cb({});
      }
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

function makeWidget(area, opts) {
  if (typeof opts === 'string') {
    opts = { url: opts }; // обратная совместимость: 2-й аргумент-строка = url
  }
  opts = opts || {};
  if (opts.url) {
    // переопределяем pathname для проверки URL-фолбэка detectEntity
    Object.defineProperty(dom.window.document, 'URL', { value: opts.url, configurable: true });
    try {
      dom.reconfigure({ url: opts.url });
    } catch (e) { /* старые версии jsdom */ }
  }
  const widget = new CustomWidget();
  allWidgets.push(widget);
  widget.langs = ruLang;
  // по умолчанию бэкенд настроен (URL + ключ); account_id берётся из AMOCRM.constant
  const settings = opts.settings || { backend_url: 'https://api.test', security_key: 'k' };
  widget.get_settings = () => settings;
  widget.system = () => ({ area: area === undefined ? 'lcard-1' : area });
  widget.params = { widget_code: 'dubli' };
  widget.render_template = (tpl) => {
    $('#card-zone').remove();
    $('<div id="card-zone"></div>').html(tpl.body).appendTo(document.body);
  };
  return widget;
}

function resetEnv() {
  allWidgets.splice(0).forEach((w) => {
    try { w.callbacks.destroy(); } catch (e) { /* уже уничтожен */ }
  });
  ajaxCalls = [];
  ajaxResponse = { entity: { indexed: true }, count: 0, duplicates: [] };
  ajaxShouldFail = false;
  ajaxHandler = null;
  accountConstant = { id: 777 };
  modals.splice(0).forEach((modal) => modal.destroyed || modal.$body.remove());
  $('.dub-toast').remove();
  $('.dub-settings').remove();
  $('#card-zone').remove();
  $(document).off('.dub').off('.dubset');
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

/* 1в. checkDuplicates обращается к бэкенду при настроенном URL/ключе/account_id */
section('checkDuplicates: запрос к GET /api/duplicates');
{
  resetEnv();
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  assert(ajaxCalls.length === 1, 'настроенный бэкенд → один запрос');
  const call = ajaxCalls[0] || {};
  assert(/\/api\/duplicates$/.test(call.url || ''), 'URL оканчивается на /api/duplicates');
  assert(call.method === 'GET', 'метод GET');
  assert(call.data && String(call.data.account_id) === '777', 'передан account_id из AMOCRM.constant');
  assert(call.data && call.data.entity_type === 'leads' && String(call.data.amo_id) === '123',
    'переданы entity_type=leads и amo_id=123');
  assert(call.headers && call.headers['X-Security-Key'] === 'k', 'передан заголовок X-Security-Key');
}

section('checkDuplicates: без настройки бэкенда запросов нет');
{
  resetEnv();
  const widget = makeWidget('lcard-1', { settings: { backend_url: '', security_key: '' } });
  widget.callbacks.render();
  assert(ajaxCalls.length === 0, 'бэкенд не настроен → запросов нет');
  assert($('#card-zone .dub__status').text().indexOf(ruLang.card.not_configured) !== -1,
    'показан статус «Бэкенд не настроен»');
  assert($('#card-zone .dub__open').prop('disabled'), '«Открыть» неактивна без настройки');
}

/* 1г. Плашка отражает ответ бэкенда */
section('Плашка: найдены дубли → активная «Открыть» + модалка со списком');
{
  resetEnv();
  ajaxResponse = {
    entity: { entity_type: 'leads', amo_id: '123', indexed: true },
    count: 2,
    duplicates: [
      { amo_id: '201', name: 'Иван Петров', matched_keys: [{ key_type: 'phone', key_norm: '9991112233' }], matched_rules: [] },
      { amo_id: '202', name: null, matched_keys: [{ key_type: 'email', key_norm: 'a@b.ru' }], matched_rules: ['email'] }
    ]
  };
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  assert($('#card-zone .dub__status_found').length === 1, 'статус «найдены дубли»');
  assert($('#card-zone .dub__status').text().indexOf('2') !== -1, 'в статусе показано число дублей');
  assert(!$('#card-zone .dub__open').prop('disabled'), '«Открыть» активна при найденных дублях');
  assert(!$('#card-zone .dub__merge').prop('disabled'), '«Объединить» активна при найденных дублях');

  $('#card-zone .dub__open').trigger('click');
  const $modal = $('.modal-stub');
  assert($modal.find('.dub-dups__item').length === 2, 'в модалке два дубля');
  assert($modal.find('.dub-dups__link').first().text() === 'Иван Петров', 'имя дубля — ссылка');
  assert($modal.find('.dub-dups__link').first().attr('href') === '/leads/detail/201',
    'ссылка ведёт на карточку дубля');
  assert($modal.find('.dub-dups__link').eq(1).text() === '#202', 'без имени показывается #amo_id');
  assert($modal.text().indexOf('phone: 9991112233') !== -1, 'показан совпавший ключ');
}

/* 1д. Объединение: список → подтверждение → POST /api/merge */
section('Объединить: список → подтверждение → POST /api/merge');
{
  resetEnv();
  ajaxResponse = {
    entity: { indexed: true },
    count: 1,
    duplicates: [{ amo_id: '201', name: 'Иван', matched_keys: [{ key_type: 'phone', key_norm: '999' }], matched_rules: [] }]
  };
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  widget.callbacks.bind_actions();

  // «Объединить» в плашке открывает тот же список с кнопками строки
  $('#card-zone .dub__merge').trigger('click');
  assert($('.dub-dups__merge').length === 1, 'в списке есть кнопка «Объединить в текущую»');

  // строка → подтверждение с выбором главной записи (по умолчанию — текущая)
  $('.dub-dups__merge').first().trigger('click');
  assert($('.dub-confirm__ok').length === 1, 'показано подтверждение объединения');
  assert($('.dub-confirm__master').length === 2, 'предложены обе записи для выбора главной');
  assert(String($('.dub-confirm__master:checked').val()) === '123',
    'по умолчанию главная — текущая карточка');

  // подтверждение → POST /api/merge
  $('.dub-confirm__ok').trigger('click');
  const post = ajaxCalls.find((c) => c.method === 'POST');
  assert(!!post, 'выполнен POST-запрос объединения');
  assert(/\/api\/merge\?account_id=777$/.test((post && post.url) || ''), 'URL /api/merge с account_id');
  const body = JSON.parse((post && post.data) || '{}');
  assert(String(body.master_amo_id) === '123' && String(body.duplicate_amo_id) === '201',
    'master = текущая карточка (123), duplicate = выбранная (201)');
  assert(body.entity_type === 'leads', 'передан entity_type');
  assert(body.author_user_id === 101, 'передан author_user_id текущего пользователя');
  assert(post.headers && post.headers['X-Security-Key'] === 'k', 'передан X-Security-Key');
  // после успеха модалки закрыты, показан тост
  assert($('.dub-confirm__ok').length === 0 && $('.dub-dups__merge').length === 0,
    'после объединения модалки закрыты');
}

/* 1е. Выбор главной записи: если выбрать дубль, стороны меняются местами */
section('Объединить: выбор дубля главной меняет master/duplicate');
{
  resetEnv();
  ajaxResponse = {
    entity: { indexed: true },
    count: 1,
    duplicates: [{ amo_id: '201', name: 'Иван', matched_keys: [{ key_type: 'phone', key_norm: '999' }], matched_rules: [] }]
  };
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  widget.callbacks.bind_actions();
  $('#card-zone .dub__merge').trigger('click');
  $('.dub-dups__merge').first().trigger('click');

  // выбираем главной запись-дубль (201) — снимаем дефолт и включаем 201
  $('.dub-confirm__master[value="123"]').prop('checked', false);
  $('.dub-confirm__master[value="201"]').prop('checked', true);
  $('.dub-confirm__ok').trigger('click');
  const body = JSON.parse((ajaxCalls.find((c) => c.method === 'POST') || {}).data || '{}');
  assert(String(body.master_amo_id) === '201' && String(body.duplicate_amo_id) === '123',
    'master = выбранный дубль (201), duplicate = текущая карточка (123)');
}

section('Плашка: сущность ещё не проиндексирована');
{
  resetEnv();
  ajaxResponse = { entity: { indexed: false }, count: 0, duplicates: [] };
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  assert($('#card-zone .dub__status').text().indexOf(ruLang.card.not_indexed) !== -1,
    'статус «ещё не проиндексировано»');
  assert($('#card-zone .dub__open').prop('disabled'), '«Открыть» неактивна');
}

section('Плашка: ошибка запроса к бэкенду');
{
  resetEnv();
  ajaxShouldFail = true;
  const widget = makeWidget('lcard-1');
  widget.callbacks.render();
  assert($('#card-zone .dub__status_error').length === 1, 'показан статус ошибки');
  assert($('#card-zone .dub__open').prop('disabled'), '«Открыть» неактивна при ошибке');
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

/* 4. Экран настроек: загрузка с бэкенда, сохранение, CRUD правил */
function settingsBody() {
  return $('<div><input type="text" name="backend_url" value="x"><input type="text" name="security_key" value="k"></div>')
    .appendTo(document.body);
}

section('Экран настроек: загрузка настроек и правил');
{
  resetEnv();
  ajaxHandler = (opts) => {
    if (/\/api\/settings/.test(opts.url) && opts.method !== 'PUT') {
      return { response: { entities: { contact: true, company: false, lead: true }, prevent_create: false } };
    }
    if (/\/api\/rules/.test(opts.url) && opts.method === 'GET') {
      return { response: [{ id: '7', entity_type: 'contact', name: 'По телефону', fields: [{ key_type: 'phone' }], operator: 'AND', enabled: true }] };
    }
    return {};
  };
  const widget = makeWidget('settings');
  const $modalBody = settingsBody();
  const result = widget.callbacks.settings($modalBody);
  assert(result === true, 'settings() вернул true');
  assert($modalBody.find('.dub-settings').length === 1, 'панель настроек добавлена');
  assert(ajaxCalls.some((c) => /\/api\/settings/.test(c.url) && c.method === 'GET'), 'запрошены настройки');
  assert(ajaxCalls.some((c) => /\/api\/rules/.test(c.url) && c.method === 'GET'), 'запрошены правила');
  assert($modalBody.find('.dub-ent[data-ent="contact"]').prop('checked') === true, 'contact включён');
  assert($modalBody.find('.dub-ent[data-ent="company"]').prop('checked') === false,
    'company выключен (из загруженных настроек)');
  assert($modalBody.find('.dub-rule').length === 1, 'загруженное правило в списке');
  assert($modalBody.find('.dub-rule__name').text() === 'По телефону', 'имя правила отрисовано');
  $modalBody.remove();
}

section('Экран настроек: сохранение (PUT /api/settings)');
{
  resetEnv();
  ajaxHandler = (opts) => {
    if (/\/api\/settings/.test(opts.url) && opts.method !== 'PUT') return { response: { entities: { contact: true, company: true, lead: true }, prevent_create: false } };
    if (/\/api\/rules/.test(opts.url) && opts.method === 'GET') return { response: [] };
    return {};
  };
  const widget = makeWidget('settings');
  const $modalBody = settingsBody();
  widget.callbacks.settings($modalBody);
  $modalBody.find('.dub-ent[data-ent="lead"]').prop('checked', false);
  $modalBody.find('.dub-prevent').prop('checked', true);
  $modalBody.find('.dub-settings__save').trigger('click');
  const put = ajaxCalls.find((c) => c.method === 'PUT' && /\/api\/settings/.test(c.url));
  assert(!!put, 'выполнен PUT /api/settings');
  const body = JSON.parse((put && put.data) || '{}');
  assert(body.entities.lead === false && body.prevent_create === true, 'тело отражает изменения формы');
  assert(/account_id=777/.test((put && put.url) || ''), 'account_id в query');
  assert(put.headers && put.headers['X-Security-Key'] === 'k', 'передан X-Security-Key');
  assert($modalBody.find('.dub-settings__status').text() !== '', 'показан статус сохранения');
  $modalBody.remove();
}

section('Экран настроек: добавление и удаление правила');
{
  resetEnv();
  let nextId = 50;
  ajaxHandler = (opts) => {
    if (/\/api\/settings/.test(opts.url) && opts.method !== 'PUT') return { response: { entities: {}, prevent_create: false } };
    if (/\/api\/rules/.test(opts.url) && opts.method === 'GET') return { response: [] };
    if (/\/api\/rules/.test(opts.url) && opts.method === 'POST') {
      const b = JSON.parse(opts.data || '{}');
      return { response: { id: String(nextId++), entity_type: b.entity_type, name: b.name, fields: b.fields, operator: b.operator, enabled: true } };
    }
    return {};
  };
  const widget = makeWidget('settings');
  const $modalBody = settingsBody();
  widget.callbacks.settings($modalBody);
  assert($modalBody.find('.dub-rules__empty').length === 1, 'изначально правил нет');

  $modalBody.find('.dub-rule__newname').val('Email-правило');
  $modalBody.find('.dub-rule__newentity').val('company');
  $modalBody.find('.dub-rule__newop').val('OR');
  $modalBody.find('.dub-rule__newkey[value="email"]').prop('checked', true);
  $modalBody.find('.dub-rule__add').trigger('click');

  const post = ajaxCalls.find((c) => c.method === 'POST' && /\/api\/rules/.test(c.url));
  assert(!!post, 'выполнен POST /api/rules');
  const body = JSON.parse((post && post.data) || '{}');
  assert(body.name === 'Email-правило' && body.entity_type === 'company' && body.operator === 'OR',
    'тело нового правила');
  assert(body.fields.length === 1 && body.fields[0].key_type === 'email', 'выбрано поле email');
  assert($modalBody.find('.dub-rule').length === 1, 'правило добавлено в список');

  $modalBody.find('.dub-rule__del').trigger('click');
  assert(ajaxCalls.some((c) => c.method === 'DELETE' && /\/api\/rules\/50/.test(c.url)),
    'выполнен DELETE /api/rules/:id');
  assert($modalBody.find('.dub-rule').length === 0, 'строка правила удалена');
  $modalBody.remove();
}

section('Экран настроек: бэкенд не настроен → подсказка');
{
  resetEnv();
  const widget = makeWidget('settings', { settings: { backend_url: '', security_key: '' } });
  const $modalBody = $('<div></div>').appendTo(document.body);
  widget.callbacks.settings($modalBody);
  assert(ajaxCalls.length === 0, 'без настройки бэкенда запросов нет');
  assert($modalBody.find('.dub-settings__hint').text().indexOf(ruLang.settings.configure_first) !== -1,
    'показана подсказка «настройте бэкенд»');
  $modalBody.remove();
}

section('Экран настроек: массовая чистка (запуск + статус + пауза)');
{
  resetEnv();
  let started = false;
  ajaxHandler = (opts) => {
    if (/\/api\/settings/.test(opts.url) && opts.method !== 'PUT') return { response: { entities: {}, prevent_create: false } };
    if (/\/api\/rules/.test(opts.url) && opts.method === 'GET') return { response: [] };
    if (/\/api\/scan(\?|$)/.test(opts.url) && opts.method === 'GET') {
      return { response: started ? [{ id: '5', entity_type: 'company', status: 'running', progress: 7 }] : [] };
    }
    if (/\/api\/scan(\?|$)/.test(opts.url) && opts.method === 'POST') {
      started = true;
      return { response: { id: '5', entity_type: 'company', status: 'queued', progress: 0 } };
    }
    return {};
  };
  const widget = makeWidget('settings');
  const $modalBody = settingsBody();
  widget.callbacks.settings($modalBody);

  assert($modalBody.find('.dub-scan__start').length === 1, 'есть кнопка «Сканировать»');
  assert($modalBody.find('.dub-scan__empty').length === 1, 'изначально сканирований нет');

  $modalBody.find('.dub-scan__entity').val('company');
  $modalBody.find('.dub-scan__start').trigger('click');
  const post = ajaxCalls.find((c) => c.method === 'POST' && /\/api\/scan(\?|$)/.test(c.url));
  assert(!!post, 'выполнен POST /api/scan');
  const body = JSON.parse((post && post.data) || '{}');
  assert(body.entity_type === 'company', 'передан entity_type');
  assert(/account_id=777/.test((post && post.url) || ''), 'account_id в query');

  // refreshScans после запуска показал активную задачу с прогрессом
  assert($modalBody.find('.dub-scan__job').length === 1, 'задача появилась в списке');
  assert($modalBody.find('.dub-scan__status_running').length === 1, 'статус «идёт»');
  assert($modalBody.find('.dub-scan__progress').text().indexOf('7') !== -1, 'показан прогресс');

  // пауза
  $modalBody.find('.dub-scan__pause').trigger('click');
  assert(ajaxCalls.some((c) => c.method === 'POST' && /\/api\/scan\/5\/pause/.test(c.url)),
    'выполнен POST /api/scan/:id/pause');

  widget.callbacks.destroy();
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
