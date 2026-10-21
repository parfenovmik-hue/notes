/**
 * Сервер приложения «Заметки»: синхронизация с Google Таблицей, вложения в Google Диске
 * и push-уведомления на iPhone.
 *
 * Код выкладывается через clasp (папка google-apps-script). Секрет лежит в Secret.gs —
 * этот файл есть только в Apps Script и на Mac, в GitHub он не попадает:
 *   const SECRET = 'длинный-случайный-секрет';
 * После первой выкладки один раз запусти в редакторе функцию setup и выдай доступы —
 * так включатся напоминания и хранение файлов.
 */

// Колонки листов. Колонки ищутся по заголовку, так что порядок можно менять,
// но заголовки не переименовывай. Технические колонки (id и т.п.) — серые.
const SHEETS = {
  folders: {
    name: 'Папки',
    cols: [['name', 'Название'], ['icon', 'Значок'], ['color', 'Цвет'], ['image', 'Картинка'],
      ['id', 'id'], ['order', 'order'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  notes: {
    name: 'Темы',
    cols: [['folderName', 'Папка'], ['title', 'Тема'], ['text', 'Содержимое'],
      ['id', 'id'], ['folder', 'folder'], ['html', 'html'], ['blocks', 'blocks'], ['pinned', 'pinned'], ['order', 'order'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  tasks: {
    name: 'Дела',
    cols: [['date', 'Дата'], ['title', 'Дело'], ['folderName', 'Папка'], ['noteTitle', 'Тема'], ['done', 'Сделано'], ['remind', 'Напомнить'], ['note', 'Заметка'], ['pinned', 'Закреплено'],
      ['id', 'id'], ['folder', 'folder'], ['noteId', 'noteId'], ['order', 'order'], ['doneAt', 'doneAt'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  shop: {
    name: 'Покупки',
    cols: [['name', 'Покупка'], ['cat', 'Раздел'], ['done', 'Куплено'], ['note', 'Заметка'],
      ['id', 'id'], ['order', 'order'], ['doneAt', 'doneAt'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  wants: {
    name: 'Мне надо',
    cols: [['name', 'Что'], ['type', 'Тип'], ['price', 'Стоимость'], ['cur', 'Валюта'], ['saved', 'Отложено'], ['done', 'Сделано'], ['note', 'Заметка'],
      ['link', 'Ссылка'], ['desc', 'Описание'], ['specs', 'Характеристики'], ['image', 'Картинка'],
      ['id', 'id'], ['status', 'status'], ['order', 'order'], ['doneAt', 'doneAt'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  files: {
    name: 'Файлы',
    cols: [['name', 'Файл'], ['noteTitle', 'Тема'], ['size', 'Размер'], ['mime', 'Тип'],
      ['id', 'id'], ['noteId', 'noteId'], ['driveId', 'driveId'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
};
const TECH = ['id', 'folder', 'noteId', 'html', 'blocks', 'pinned', 'order', 'doneAt', 'createdAt', 'updatedAt', 'deleted', 'driveId'];
const TEXT_KEYS = ['link', 'desc', 'specs', 'cur', 'status', 'id', 'name', 'icon', 'color', 'image', 'title', 'text', 'folder', 'folderName', 'noteId', 'noteTitle', 'note', 'html', 'blocks', 'remind', 'mime', 'driveId', 'type', 'cat'];
const PROPS = PropertiesService.getScriptProperties();
const FILES_FOLDER = 'Заметки — вложения';

function doGet() {
  return json({ ok: true, app: 'notespanel' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Некорректный запрос' });
  }
  if (typeof SECRET === 'undefined' || !SECRET) return json({ ok: false, error: 'Задай SECRET в Secret.gs' });
  if (body.secret !== SECRET) return json({ ok: false, error: 'Неверный секретный ключ' });
  try {
    switch (body.action || 'sync') {
      case 'sync': return json({ ok: true, data: sync_(body), serverTime: Date.now() });
      case 'upload': return json({ ok: true, data: upload_(body) });
      case 'download': return json({ ok: true, data: download_(body) });
      case 'vapid': return json({ ok: true, data: { publicKey: getVapid_().pub } });
      case 'subscribe': return json({ ok: true, data: subscribe_(body.subscription) });
      case 'outbox': return json({ ok: true, data: recentOutbox_() });
      case 'test': return json({ ok: true, data: sendTest_() });
      case 'diag': return json({ ok: true, data: diag_() });
      case 'link': return json({ ok: true, data: linkCard_(body) });
      default: return json({ ok: false, error: 'Неизвестное действие' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------------- Синхронизация ---------------- */

function sync_(body) {
  if (body.prefs) PROPS.setProperty('prefs', JSON.stringify(body.prefs));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = Session.getScriptTimeZone();
    fixDates_(ss);
    const changes = body.changes || {};
    const data = {};
    Object.keys(SHEETS).forEach(function (kind) {
      const t = table_(ss, SHEETS[kind]);
      if (changes[kind] && changes[kind].length) upsert_(t, changes[kind]);
      data[kind] = readAll_(t, tz);
    });
    // Удалённые в приложении файлы — в корзину Диска
    (changes.files || []).forEach(function (f) {
      if (f.deleted && f.driveId) { try { DriveApp.getFileById(f.driveId).setTrashed(true); } catch (err) {} }
    });
    return data;
  } finally {
    lock.releaseLock();
  }
}

// Лист + карта «ключ → номер колонки». Недостающие колонки добавляются справа.
function table_(ss, def) {
  let sh = ss.getSheetByName(def.name);
  if (!sh) { sh = ss.insertSheet(def.name); sh.setFrozenRows(1); }
  const lastCol = sh.getLastColumn();
  const head = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const map = {};
  let added = false;
  def.cols.forEach(function (c) {
    let i = head.indexOf(c[1]);
    if (i < 0) {
      i = head.length;
      head.push(c[1]);
      added = true;
      const col = sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1);
      if (TEXT_KEYS.indexOf(c[0]) >= 0) col.setNumberFormat('@');
      if (['createdAt', 'updatedAt', 'doneAt', 'order', 'size'].indexOf(c[0]) >= 0) col.setNumberFormat('0');
      if (c[0] === 'date') col.setNumberFormat('@');
      const h = sh.getRange(1, i + 1).setValue(c[1]).setFontWeight('bold');
      if (TECH.indexOf(c[0]) >= 0) h.setFontColor('#999999');
    }
    map[c[0]] = i;
  });
  if (added) SpreadsheetApp.flush();
  return { sh: sh, map: map, width: head.length, def: def };
}

function upsert_(t, rows) {
  const last = t.sh.getLastRow();
  const values = last > 1 ? t.sh.getRange(2, 1, last - 1, t.width).getValues() : [];
  const index = {};
  values.forEach(function (r, i) { const id = r[t.map.id]; if (id) index[String(id)] = i; });
  const appends = [];
  rows.forEach(function (r) {
    if (!r || !r.id) return;
    const pos = index[r.id];
    const row = pos === undefined ? new Array(t.width).fill('') : values[pos].slice();
    Object.keys(t.map).forEach(function (k) {
      let v = r[k];
      if (v === undefined || v === null) v = '';
      if (typeof v === 'string' && v.length > 49000) v = v.slice(0, 49000);
      row[t.map[k]] = v;
    });
    if (pos === undefined) { appends.push(row); index[r.id] = -1; }
    else t.sh.getRange(pos + 2, 1, 1, t.width).setValues([row]);
  });
  if (appends.length) t.sh.getRange(t.sh.getLastRow() + 1, 1, appends.length, t.width).setValues(appends);
}

function readAll_(t, tz) {
  const last = t.sh.getLastRow();
  if (last < 2) return [];
  return t.sh.getRange(2, 1, last - 1, t.width).getValues()
    .map(function (row) {
      const o = {};
      Object.keys(t.map).forEach(function (k) {
        let v = row[t.map[k]];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, k === 'remind' ? 'HH:mm' : 'yyyy-MM-dd');
        o[k] = v;
      });
      return o;
    })
    .filter(function (o) { return o.id; });
}

// Разовая починка: раньше дата записывалась в ячейку как «дата» и читалась в часовом
// поясе таблицы, который не совпадал с поясом скрипта, — день съезжал назад.
// Превращаем такие ячейки в текст с исходной датой и помечаем строки изменёнными,
// чтобы телефоны забрали правильные даты.
function fixDates_(ss) {
  if (PROPS.getProperty('datesFixed')) return;
  const tz = Session.getScriptTimeZone();
  const t = table_(ss, SHEETS.tasks);
  const last = t.sh.getLastRow();
  if (last > 1) {
    const vals = t.sh.getRange(2, 1, last - 1, t.width).getValues();
    const dates = [], upd = [];
    vals.forEach(function (r) {
      let v = r[t.map.date], u = r[t.map.updatedAt];
      if (v instanceof Date) { v = Utilities.formatDate(v, tz, 'yyyy-MM-dd'); u = Number(u) + 1; }
      dates.push([v]);
      upd.push([u]);
    });
    t.sh.getRange(2, t.map.date + 1, last - 1, 1).setNumberFormat('@').setValues(dates);
    t.sh.getRange(2, t.map.updatedAt + 1, last - 1, 1).setValues(upd);
  }
  t.sh.getRange(2, t.map.date + 1, Math.max(t.sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  ss.setSpreadsheetTimeZone(tz);
  SpreadsheetApp.flush();
  PROPS.setProperty('datesFixed', String(Date.now()));
}

/* ---------------- «Мне надо»: карточка по ссылке ----------------
   Скрипт сам читает страницу. Если на ней есть текст — Claude оформляет карточку из него
   (дёшево, без поиска). Если страница пустая или закрыта для роботов — Claude получает
   инструменты загрузки страниц и поиска и находит товар сам.
   Ключ Anthropic лежит в Claude.gs (ANTHROPIC_KEY), в GitHub не попадает. */

const LINK_MODEL = 'claude-sonnet-5-5';
const LINK_SYSTEM = [
  'Ты помогаешь вести личный список желаний и целей. По ссылке на товар, услугу или курс собери короткую карточку на русском языке.',
  'Если в сообщении есть текст страницы — опирайся на него. Если текста нет, открой ссылку через web_fetch; если и это не дало данных о товаре, найди его через web_search по названию, артикулу или словам из ссылки.',
  'Ничего не выдумывай: если цену или характеристику не удалось найти, оставь поле пустым. Цена — основная цена товара или услуги (для курса или автошколы — базовый тариф).',
  'В конце обязательно один раз вызови save_card.',
].join('\n');
const SAVE_CARD_TOOL = {
  name: 'save_card',
  description: 'Сохранить итоговую карточку.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['name', 'price', 'currency', 'description', 'specs', 'image', 'kind', 'found'],
    properties: {
      name: { type: 'string', description: 'Короткое понятное название, до 60 символов' },
      price: { type: ['number', 'null'], description: 'Цена числом без валюты; null, если не нашлась' },
      currency: { type: 'string', description: 'Код валюты: RUB, USD, EUR… Пусто, если цены нет' },
      description: { type: 'string', description: '1–2 предложения: что это и чем хорошо' },
      specs: {
        type: 'array', description: '3–5 главных характеристик',
        items: { type: 'object', additionalProperties: false, required: ['k', 'v'], properties: { k: { type: 'string' }, v: { type: 'string' } } },
      },
      image: { type: 'string', description: 'Прямая ссылка на картинку товара, если встретилась; иначе пусто' },
      kind: { type: 'string', enum: ['thing', 'goal'], description: 'thing — вещь; goal — курс, обучение, услуга, цель' },
      found: { type: 'boolean', description: 'Удалось ли найти данные о товаре' },
    },
  },
};

function linkCard_(body) {
  if (typeof ANTHROPIC_KEY === 'undefined' || !ANTHROPIC_KEY) throw new Error('Не задан ключ Claude');
  const url = String(body.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Это не ссылка');
  const page = fetchPage_(url);
  const rich = page.text.length >= 600;
  const facts = ['Ссылка: ' + url];
  if (page.title) facts.push('Заголовок страницы: ' + page.title);
  Object.keys(page.meta).forEach(function (k) { facts.push(k + ': ' + page.meta[k]); });
  if (page.ld) facts.push('Структурированные данные страницы:\n' + page.ld);
  if (rich) facts.push('Текст страницы (сокращён):\n' + page.text.slice(0, 14000));
  else facts.push('Текст страницы прочитать не удалось (ответ ' + page.status + ').');

  const tools = rich ? [SAVE_CARD_TOOL] : [
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2 },
    { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
    SAVE_CARD_TOOL,
  ];
  const req = {
    model: LINK_MODEL, max_tokens: 8000, output_config: { effort: 'low' }, fallbacks: 'default',
    system: LINK_SYSTEM, tools: tools, messages: [{ role: 'user', content: facts.join('\n\n') }],
  };
  let card = null, usage = { input: 0, output: 0, searches: 0 };
  for (let step = 0; step < 4 && !card; step++) {
    const r = callClaude_(req);
    usage.input += (r.usage && r.usage.input_tokens) || 0;
    usage.output += (r.usage && r.usage.output_tokens) || 0;
    usage.searches += (r.usage && r.usage.server_tool_use && r.usage.server_tool_use.web_search_requests) || 0;
    if (r.stop_reason === 'refusal') throw new Error('Claude отказался разбирать эту ссылку');
    const call = (r.content || []).filter(function (b) { return b.type === 'tool_use' && b.name === 'save_card'; })[0];
    if (call) { card = call.input; break; }
    // pause_turn — серверные инструменты не успели, продолжаем; иначе просим сохранить карточку
    req.messages.push({ role: 'assistant', content: r.content });
    if (r.stop_reason !== 'pause_turn') req.messages.push({ role: 'user', content: 'Сохрани карточку через save_card.' });
  }
  if (!card) throw new Error('Не удалось оформить карточку');
  const img = /^https?:\/\//.test(card.image || '') ? card.image : page.image;
  return {
    name: String(card.name || '').slice(0, 120), price: typeof card.price === 'number' ? card.price : null,
    currency: String(card.currency || '').toUpperCase(), description: card.description || '',
    specs: (card.specs || []).slice(0, 6), image: img || '', kind: card.kind === 'goal' ? 'goal' : 'thing',
    found: !!card.found, usage: usage,
  };
}

function callClaude_(req) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    payload: JSON.stringify(req),
  });
  const code = res.getResponseCode();
  const j = JSON.parse(res.getContentText() || '{}');
  if (code >= 300 || j.type === 'error') {
    const msg = (j.error && j.error.message) || ('HTTP ' + code);
    if (code === 401) throw new Error('Ключ Claude не подошёл');
    if (/credit|balance/i.test(msg)) throw new Error('На счёте Anthropic закончились деньги');
    if (code === 429 || code >= 500) throw new Error('Claude сейчас перегружен — попробуй позже');
    throw new Error('Ошибка Claude: ' + msg);
  }
  return j;
}

// Читает страницу: заголовок, мета-теги для превью, структурированные данные, видимый текст
function fetchPage_(url) {
  const out = { status: 0, title: '', meta: {}, ld: '', text: '', image: '' };
  let html = '';
  try {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        'Accept-Language': 'ru,en;q=0.8',
      },
    });
    out.status = res.getResponseCode();
    if (out.status < 300) html = res.getContentText('UTF-8').slice(0, 1500000);
  } catch (err) { out.status = String(err.message || err).slice(0, 80); }
  if (!html) return out;
  const decode = function (t) {
    return String(t || '').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  };
  const t = html.match(/<title[^>]*>([^<]*)/i);
  out.title = t ? decode(t[1]).trim().slice(0, 200) : '';
  ['og:title', 'og:description', 'og:image', 'og:price:amount', 'og:price:currency', 'product:price:amount', 'product:price:currency', 'twitter:image', 'description'].forEach(function (p) {
    const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + p.replace(/:/g, '\\:') + '["\'][^>]*content=["\']([^"\']*)', 'i');
    const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + p.replace(/:/g, '\\:') + '["\']', 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) out.meta[p] = decode(m[1]).trim().slice(0, 400);
  });
  out.image = out.meta['og:image'] || out.meta['twitter:image'] || '';
  if (out.image && !/^https?:/.test(out.image)) { try { out.image = url.match(/^https?:\/\/[^/]+/)[0] + (out.image[0] === '/' ? '' : '/') + out.image; } catch (e) { out.image = ''; } }
  const lds = [];
  html.replace(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi, function (m, j) { lds.push(j.trim()); return m; });
  out.ld = lds.join('\n').slice(0, 5000);
  out.text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return out;
}

/* ---------------- Вложения в Google Диске ---------------- */

function filesFolder_() {
  const it = DriveApp.getFoldersByName(FILES_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FILES_FOLDER);
}
function upload_(body) {
  const blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mime || 'application/octet-stream', body.name || 'file');
  return { driveId: filesFolder_().createFile(blob).getId() };
}
function download_(body) {
  const f = DriveApp.getFileById(body.driveId);
  const blob = f.getBlob();
  return { data: Utilities.base64Encode(blob.getBytes()), mime: blob.getContentType(), name: f.getName() };
}

/* ---------------- Напоминания ---------------- */

// Запусти один раз вручную: создаёт ключи для push, триггер каждые 5 минут и папку для файлов.
function setup() {
  SpreadsheetApp.getActiveSpreadsheet().setSpreadsheetTimeZone(Session.getScriptTimeZone());
  getVapid_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  filesFolder_();
  UrlFetchApp.getRequest('https://web.push.apple.com');
  Logger.log('Готово: напоминания и вложения включены.');
}

// Каждые 5 минут: собирает, что пора напомнить, и шлёт push на все устройства.
function tick() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const prefs0 = JSON.parse(PROPS.getProperty('prefs') || '{}');
  // Время напоминаний — по часовому поясу телефона (он присылает его при синхронизации)
  let tz = Session.getScriptTimeZone();
  if (prefs0.tz) { try { Utilities.formatDate(new Date(), prefs0.tz, 'HH:mm'); tz = prefs0.tz; } catch (err) {} }
  const now = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const hm = Utilities.formatDate(now, tz, 'HH:mm');
  const prefs = JSON.parse(PROPS.getProperty('prefs') || '{}');
  const sent = JSON.parse(PROPS.getProperty('sent') || '{}');
  const tasks = readAll_(table_(ss, SHEETS.tasks), tz).filter(function (t) { return !isTrue_(t.deleted); });
  const open = tasks.filter(function (t) { return !isTrue_(t.done); });
  const todays = open.filter(function (t) { return t.date === today; });
  const late = open.filter(function (t) { return t.date && t.date < today; });
  const msgs = [];

  if (prefs.digest && hm >= prefs.digest && !sent['digest:' + today]) {
    sent['digest:' + today] = Date.now();
    if (todays.length || late.length) {
      const names = todays.slice(0, 4).map(function (t) { return t.title; }).join(', ');
      msgs.push({
        id: 'digest-' + today, title: 'План на сегодня · ' + todays.length + ' ' + plural_(todays.length, ['дело', 'дела', 'дел']),
        body: (names || 'На сегодня дел нет') + (todays.length > 4 ? '…' : '') + (late.length ? '\nНе сделано раньше: ' + late.length : ''),
      });
    }
  }
  if (prefs.evening && hm >= prefs.evening && !sent['evening:' + today]) {
    sent['evening:' + today] = Date.now();
    if (todays.length) {
      msgs.push({
        id: 'evening-' + today, title: 'Не закрыто ' + todays.length + ' ' + plural_(todays.length, ['дело', 'дела', 'дел']),
        body: todays.slice(0, 4).map(function (t) { return t.title; }).join(', ') + ' — перенеси или закрой',
      });
    }
  }
  todays.forEach(function (t) {
    const r = String(t.remind || '');
    if (!/^\d\d:\d\d$/.test(r) || hm < r) return;
    const key = 't:' + t.id + ':' + today + ':' + r;
    if (sent[key]) return;
    sent[key] = Date.now();
    msgs.push({ id: 'task-' + t.id + '-' + today, title: t.title, body: [t.folderName, t.noteTitle].filter(String).join(' · ') || 'Напоминание' });
  });

  // Старые отметки об отправке чистим через 3 дня
  const cutoff = Date.now() - 3 * 864e5;
  Object.keys(sent).forEach(function (k) { if (sent[k] < cutoff) delete sent[k]; });
  PROPS.setProperty('sent', JSON.stringify(sent));
  if (msgs.length) { addOutbox_(msgs); pushAll_(); }
}

function sendTest_() {
  addOutbox_([{ id: 'test-' + Date.now(), title: 'Заметки', body: 'Уведомления работают ✓' }]);
  return { results: pushAll_() };
}

function subscribe_(sub) {
  if (!sub || !sub.endpoint) throw new Error('Пустая подписка');
  const subs = getSubs_().filter(function (s) { return s.endpoint !== sub.endpoint; });
  subs.push({ endpoint: sub.endpoint, at: Date.now() });
  PROPS.setProperty('subs', JSON.stringify(subs.slice(-10)));
  return { devices: subs.length };
}
function getSubs_() { return JSON.parse(PROPS.getProperty('subs') || '[]'); }

// Очередь сообщений: push приходит без текста, приложение само забирает текст отсюда
function addOutbox_(msgs) {
  const now = Date.now();
  const box = JSON.parse(PROPS.getProperty('outbox') || '[]').filter(function (m) { return m.at > now - 2 * 3600e3; });
  msgs.forEach(function (m) { m.at = now; box.push(m); });
  PROPS.setProperty('outbox', JSON.stringify(box.slice(-30)));
}
function recentOutbox_() {
  const since = Date.now() - 30 * 60e3;
  return JSON.parse(PROPS.getProperty('outbox') || '[]').filter(function (m) { return m.at > since; });
}

function pushAll_() {
  const v = getVapid_();
  const subs = getSubs_();
  const keep = [], results = [];
  subs.forEach(function (s) {
    const res = sendPush_(s.endpoint, v);
    results.push(res.code + (res.text ? ' ' + res.text.slice(0, 120) : ''));
    if (res.code !== 404 && res.code !== 410) keep.push(s);
  });
  if (keep.length !== subs.length) PROPS.setProperty('subs', JSON.stringify(keep));
  return results;
}

function sendPush_(endpoint, v) {
  const aud = endpoint.match(/^https?:\/\/[^/]+/)[0];
  const header = b64u_(bytes_(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u_(bytes_(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 3600, sub: 'mailto:' + (Session.getEffectiveUser().getEmail() || 'notes@example.com') })));
  const input = header + '.' + claims;
  const hash = unsign_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes_(input)));
  const sig = EC_.sign(hash, BigInt('0x' + v.d), hmac_);
  const jwt = input + '.' + b64u_(sig);
  const res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    headers: { Authorization: 'vapid t=' + jwt + ', k=' + v.pub, TTL: '3600', Urgency: 'high' },
    payload: '',
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  return { code: code, text: code >= 300 ? res.getContentText() : '' };
}

function getVapid_() {
  const saved = PROPS.getProperty('vapid');
  if (saved) return JSON.parse(saved);
  const seed = hmac_(bytes_(Utilities.getUuid() + Date.now()), bytes_(Utilities.getUuid() + Math.random()));
  const d = EC_.privateFromSeed(seed);
  const v = { d: d.toString(16), pub: b64u_(EC_.publicKey(d)) };
  PROPS.setProperty('vapid', JSON.stringify(v));
  return v;
}

const unsign_ = (a) => a.map(function (b) { return b & 255; });
const sign8_ = (a) => a.map(function (b) { b &= 255; return b > 127 ? b - 256 : b; });
const bytes_ = (s) => unsign_(Utilities.newBlob(s).getBytes());
const b64u_ = (a) => Utilities.base64EncodeWebSafe(sign8_(a)).replace(/=+$/, '');
function hmac_(key, data) {
  return unsign_(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, sign8_(data), sign8_(key)));
}
const isTrue_ = (v) => v === true || String(v).toUpperCase() === 'TRUE';
function plural_(n, f) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b > 1 && b < 5) return f[1];
  return b === 1 ? f[0] : f[2];
}

// Диагностика: часовые пояса скрипта и таблицы, триггер напоминаний
function diag_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const d = new Date(2026, 9, 20);
  return {
    scriptTz: Session.getScriptTimeZone(),
    sheetTz: ss.getSpreadsheetTimeZone(),
    midnightIso: d.toISOString(),
    asScript: Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
    asSheet: Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'),
    datesFixed: PROPS.getProperty('datesFixed') || '',
  };
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- Web Push: подпись VAPID (ES256, P-256) ---------------- */
// В Apps Script нет ECDSA, поэтому эллиптическая кривая реализована вручную на BigInt.
const EC_ = (function () {
  const B = BigInt;
  const P = B('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const N = B('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const G = [B('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'), B('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')];
  const Z = B(0), ONE = B(1), TWO = B(2), THREE = B(3);
  const mod = (a, m) => { const r = a % m; return r >= Z ? r : r + m; };
  function inv(a, m) {
    let r0 = mod(a, m), r1 = m, s0 = ONE, s1 = Z;
    while (r1 !== Z) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
    return mod(s0, m);
  }
  function add(p, q) {
    if (!p) return q;
    if (!q) return p;
    let l;
    if (p[0] === q[0]) {
      if (mod(p[1] + q[1], P) === Z) return null;
      l = mod((THREE * p[0] * p[0] - THREE) * inv(TWO * p[1], P), P);
    } else {
      l = mod((q[1] - p[1]) * inv(q[0] - p[0], P), P);
    }
    const x = mod(l * l - p[0] - q[0], P);
    return [x, mod(l * (p[0] - x) - p[1], P)];
  }
  function mul(k, pt) {
    let r = null, a = pt;
    while (k > Z) { if (k % TWO === ONE) r = add(r, a); a = add(a, a); k = k / TWO; }
    return r;
  }
  const toBig = (bytes) => bytes.reduce((acc, b) => acc * B(256) + B(b & 255), Z);
  function toBytes(x, len) {
    const out = new Array(len);
    for (let i = len - 1; i >= 0; i--) { out[i] = Number(x % B(256)); x = x / B(256); }
    return out;
  }
  // Детерминированный k по RFC 6979 (HMAC-SHA256)
  function nonce(d, e, hmac) {
    const x = toBytes(d, 32), h = toBytes(mod(e, N), 32);
    let v = new Array(32).fill(1), k = new Array(32).fill(0);
    k = hmac(k, v.concat([0], x, h)); v = hmac(k, v);
    k = hmac(k, v.concat([1], x, h)); v = hmac(k, v);
    for (;;) {
      v = hmac(k, v);
      const c = toBig(v);
      if (c >= ONE && c < N) return c;
      k = hmac(k, v.concat([0])); v = hmac(k, v);
    }
  }
  return {
    publicKey(d) { const q = mul(d, G); return [4].concat(toBytes(q[0], 32), toBytes(q[1], 32)); },
    privateFromSeed(seed) { return mod(toBig(seed), N - ONE) + ONE; },
    sign(hash, d, hmac) {
      const e = toBig(hash);
      for (;;) {
        const k = nonce(d, e, hmac);
        const r = mod(mul(k, G)[0], N);
        const s = mod(inv(k, N) * (e + r * d), N);
        if (r !== Z && s !== Z) return toBytes(r, 32).concat(toBytes(s, 32));
      }
    },
    toBig: toBig,
    toBytes: toBytes,
  };
})();
