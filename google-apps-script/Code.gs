/**
 * Сервер приложения «Заметки»: синхронизация с Google Таблицей, вложения в Google Диске
 * и push-уведомления на iPhone.
 *
 * 1. Открой таблицу → Расширения → Apps Script, вставь этот код целиком.
 * 2. Придумай длинный секрет и впиши его в SECRET ниже (тот же — в настройках приложения).
 * 3. Вверху выбери функцию setup и нажми «Выполнить» (один раз): выдай доступы —
 *    так включатся напоминания и хранение файлов.
 * 4. Начать развёртывание → Новое развёртывание → Тип: Веб-приложение,
 *    «Выполнять как»: Я, «Кто имеет доступ»: Все. Скопируй URL (…/exec) в приложение.
 */
const SECRET = 'ЗАМЕНИ-НА-СВОЙ-ДЛИННЫЙ-СЕКРЕТ';

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
      ['id', 'id'], ['folder', 'folder'], ['blocks', 'blocks'], ['pinned', 'pinned'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  tasks: {
    name: 'Дела',
    cols: [['date', 'Дата'], ['title', 'Дело'], ['folderName', 'Папка'], ['noteTitle', 'Тема'], ['done', 'Сделано'], ['remind', 'Напомнить'], ['note', 'Заметка'],
      ['id', 'id'], ['folder', 'folder'], ['noteId', 'noteId'], ['order', 'order'], ['doneAt', 'doneAt'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  files: {
    name: 'Файлы',
    cols: [['name', 'Файл'], ['noteTitle', 'Тема'], ['size', 'Размер'], ['mime', 'Тип'],
      ['id', 'id'], ['noteId', 'noteId'], ['driveId', 'driveId'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
};
const TECH = ['id', 'folder', 'noteId', 'blocks', 'pinned', 'order', 'doneAt', 'createdAt', 'updatedAt', 'deleted', 'driveId'];
const TEXT_KEYS = ['id', 'name', 'icon', 'color', 'image', 'title', 'text', 'folder', 'folderName', 'noteId', 'noteTitle', 'note', 'blocks', 'remind', 'mime', 'driveId'];
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
  if (!SECRET || SECRET.indexOf('ЗАМЕНИ') === 0) return json({ ok: false, error: 'Задай SECRET в скрипте' });
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
    const tz = ss.getSpreadsheetTimeZone();
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
      if (c[0] === 'date') col.setNumberFormat('yyyy-mm-dd');
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
      if (k === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const p = v.split('-');
        v = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      }
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
  const tz = ss.getSpreadsheetTimeZone();
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
