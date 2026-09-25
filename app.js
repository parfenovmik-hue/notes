'use strict';

/* =========================================================
   Заметки — PWA: ежедневник, папки проектов, заметки, календарь.
   Данные: IndexedDB на телефоне + синхронизация с Google Sheets
   через Apps Script (см. google-apps-script/Code.gs).
   ========================================================= */

const APP_VERSION = '0.1.0';

/* ---------------- Утилиты ---------------- */

const $ = (s, r = document) => r.querySelector(s);
const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function weekStart(s) { const d = parseYmd(s); return addDays(s, -((d.getDay() + 6) % 7)); }
function shiftMonth(m, delta) { const [y, mm] = m.split('-').map(Number); return ymd(new Date(y, mm - 1 + delta, 1)).slice(0, 7); }
function monthLabel(m) { const [y, mm] = m.split('-').map(Number); return `${MONTHS[mm - 1]} ${y}`; }
function dayWord(s) {
  const t = ymd();
  if (s === t) return 'Сегодня';
  if (s === addDays(t, 1)) return 'Завтра';
  if (s === addDays(t, -1)) return 'Вчера';
  return '';
}
// «25 сентября, четверг» (+ год, если не текущий)
function dateLong(s) {
  const d = parseYmd(s);
  const yr = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${yr}, ${WD_FULL[d.getDay()]}`;
}
// «завтра», «пн, 29 сен»
function dateShort(s) {
  const w = dayWord(s);
  if (w) return w.toLowerCase();
  const d = parseYmd(s);
  const yr = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
  return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${yr}`;
}
function nextMonday(s) { const d = parseYmd(s); return addDays(s, ((8 - d.getDay()) % 7) || 7); }

const P = {
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  move: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  memo: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  inbox: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 13.5H9a3 3 0 0 0 6 0h5.5"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
};
const FOLDER_ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 11a17 17 0 0 1 9-8c1 0 3 2 3 3a17 17 0 0 1-8 9z"/><path d="M9 11H5l2-4h5M13 15v4l4-2v-5"/><circle cx="15.5" cy="8.5" r="1.5"/>',
  return: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  camera: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r=".6"/>',
  send: '<path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="m10 13 4.5-4.5"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  paw: '<circle cx="7" cy="10" r="1.8"/><circle cx="12" cy="7" r="1.8"/><circle cx="17" cy="10" r="1.8"/><path d="M8 17c0-2.5 1.8-4.5 4-4.5s4 2 4 4.5a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2z"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2.5 3h2.6l2.4 12h11l2-8H6.2"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5zM4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  plane: '<path d="M22 16v-2l-8.5-5V3.5a1.5 1.5 0 0 0-3 0V9L2 14v2l8.5-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5l-2-1.5v-5.5z"/>',
  sport: '<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>',
};
const COLORS = ['blue', 'orange', 'pink', 'violet', 'green', 'teal', 'red', 'gray'];
const svg = (p, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24">${p}</svg>`;
const icon = (k) => svg(P[k]);
const folderIcon = (f) => svg(FOLDER_ICONS[f?.icon] || FOLDER_ICONS.folder);
const fc = (f) => `--fc:var(--c-${COLORS.includes(f?.color) ? f.color : 'gray'})`;

/* ---------------- Хранилище (IndexedDB с запасным localStorage) ---------------- */

const Store = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('notespanel', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        const q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    } catch (e) {
      try { const v = localStorage.getItem('np_' + k); return v ? JSON.parse(v) : undefined; } catch (_) { return undefined; }
    }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      await new Promise((res, rej) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(v, k);
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
    } catch (e) {
      try { localStorage.setItem('np_' + k, JSON.stringify(v)); } catch (_) { toast('Не удалось сохранить данные'); }
    }
  },
};

/* ---------------- Состояние ---------------- */

const KINDS = ['folders', 'notes', 'tasks'];
let state;
const ui = {
  tab: 'today', day: ymd(), lastToday: ymd(),
  calMonth: ymd().slice(0, 7), calDay: ymd(),
  folder: '', folderTab: 'tasks', showDone: false,
  sync: { status: 'idle', msg: '' }, sheets: [], refocus: '', swallowClick: 0,
};

function defaultSettings() {
  return { syncUrl: '', syncSecret: '', lastSync: 0, hideInstallTip: false };
}

function defaultState() {
  const now = Date.now();
  const folders = [
    ['MOST', 'rocket', 'blue'],
    ['Возвраты', 'return', 'orange'],
    ['Мой Instagram', 'camera', 'pink'],
    ['Мой Telegram', 'send', 'teal'],
    ['Дом, семья', 'home', 'green'],
  ].map(([name, ic, color], i) => ({ id: uid('f'), name, icon: ic, color, order: i, updatedAt: now, deleted: false, _dirty: true }));
  return { v: 1, folders, notes: [], tasks: [], settings: defaultSettings() };
}

function save() { Store.set('state', state); }

const live = (k) => state[k].filter((e) => !e.deleted);
const byId = (k, id) => (id ? state[k].find((e) => e.id === id) : undefined);
const folders = () => live('folders').sort(byOrder);
const liveFolder = (id) => { const f = byId('folders', id); return f && !f.deleted ? f : undefined; };

function upsert(k, obj) {
  obj.updatedAt = Math.max(Date.now(), (byId(k, obj.id)?.updatedAt || 0) + 1);
  obj._dirty = true;
  const i = state[k].findIndex((e) => e.id === obj.id);
  if (i < 0) state[k].push(obj); else state[k][i] = obj;
  save();
  scheduleSync();
}
function patch(k, id, changes) {
  const e = byId(k, id);
  if (e) upsert(k, { ...e, ...changes });
}

function newTask(o) {
  const now = Date.now();
  const t = { id: uid('t'), title: '', folder: '', date: '', note: '', done: false, doneAt: 0, order: now, createdAt: now, deleted: false, ...o };
  upsert('tasks', t);
  return t;
}
function newNote(o) {
  const now = Date.now();
  return { id: uid('n'), folder: '', title: '', body: '', pinned: false, createdAt: now, deleted: false, ...o };
}

/* ---------------- Выборки ---------------- */

const sortOpen = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.order || 0) - (b.order || 0);
const sortDone = (a, b) => (b.doneAt || 0) - (a.doneAt || 0);

function tasksOn(day) {
  const list = live('tasks').filter((t) => t.date === day);
  return { open: list.filter((t) => !t.done).sort(sortOpen), done: list.filter((t) => t.done).sort(sortDone) };
}
function lateTasks() {
  const t = ymd();
  return live('tasks').filter((x) => !x.done && x.date && x.date < t).sort(sortOpen);
}
// Для точек в календаре: { 'YYYY-MM-DD': { open, done } }
function dayStats() {
  const m = {};
  for (const t of live('tasks')) {
    if (!t.date) continue;
    const s = (m[t.date] ||= { open: 0, done: 0 });
    if (t.done) s.done++; else s.open++;
  }
  return m;
}
const inboxNotes = () => live('notes').filter((n) => !liveFolder(n.folder)).sort((a, b) => b.updatedAt - a.updatedAt);
const inboxTasks = () => live('tasks').filter((t) => !t.done && !t.date && !liveFolder(t.folder)).sort(sortOpen);
const inboxCount = () => inboxNotes().length + inboxTasks().length;

function noteTitle(n) {
  if (n.title.trim()) return n.title.trim();
  return n.body.trim().split('\n')[0].slice(0, 80) || 'Без названия';
}
function notePreview(n) {
  const lines = n.body.trim().split('\n').filter((l) => l.trim());
  return (n.title.trim() ? lines : lines.slice(1)).join(' ').slice(0, 160);
}
function when(ts) {
  const d = new Date(ts), s = ymd(d);
  if (s === ymd()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return dateShort(s);
}

/* ---------------- Синхронизация с Google Таблицей ---------------- */

const FIELDS = {
  folders: { s: ['id', 'name', 'icon', 'color'], n: ['order', 'updatedAt'], b: ['deleted'] },
  notes: { s: ['id', 'folder', 'title', 'body'], n: ['createdAt', 'updatedAt'], b: ['pinned', 'deleted'] },
  tasks: { s: ['id', 'title', 'folder', 'date', 'note'], n: ['order', 'doneAt', 'createdAt', 'updatedAt'], b: ['done', 'deleted'] },
};

function norm(k, r) {
  const f = FIELDS[k], o = {};
  f.s.forEach((x) => (o[x] = r[x] == null ? '' : String(r[x])));
  f.n.forEach((x) => { const n = Number(r[x]); o[x] = isFinite(n) ? n : 0; });
  f.b.forEach((x) => (o[x] = r[x] === true || String(r[x]).toUpperCase() === 'TRUE'));
  return o;
}
// Строка для таблицы: технические поля + название папки для удобства чтения
function outRow(k, e) {
  const o = norm(k, e);
  if (k !== 'folders') o.folderName = liveFolder(e.folder)?.name || 'Входящие';
  return o;
}

let syncBusy = false, syncTimer;
function scheduleSync(delay = 2500) {
  if (!state.settings.syncUrl) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(false), delay);
}
function setSync(status, msg = '') {
  ui.sync = { status, msg };
  refreshTopSheet();
}
const hasDirty = () => KINDS.some((k) => state[k].some((e) => e._dirty));

async function syncPost(changes) {
  const s = state.settings;
  let r;
  try {
    r = await fetch(s.syncUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: s.syncSecret, changes }),
    });
  } catch (e) { throw new Error('Нет связи с таблицей'); }
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('Скрипт ответил не JSON — проверь адрес и доступ «Все»'); }
  if (!j.ok) throw new Error(j.error || 'Ошибка скрипта');
  return j.data || {};
}
function collectChanges() {
  const changes = {}, sent = [];
  for (const k of KINDS) {
    changes[k] = [];
    for (const e of state[k]) if (e._dirty) { changes[k].push(outRow(k, e)); sent.push([k, e.id, e.updatedAt]); }
  }
  return { changes, sent };
}
function mergeRemote(data) {
  for (const k of KINDS) {
    for (const raw of data[k] || []) {
      const r = norm(k, raw);
      if (!r.id) continue;
      const i = state[k].findIndex((e) => e.id === r.id);
      if (i < 0) state[k].push(r);
      else if (!state[k][i]._dirty && r.updatedAt > state[k][i].updatedAt) state[k][i] = r;
    }
  }
}
function clearDirty(sent) {
  for (const [k, id, upd] of sent) {
    const e = byId(k, id);
    if (e && e.updatedAt === upd) delete e._dirty;
  }
}

async function syncNow(manual) {
  const s = state.settings;
  if (!s.syncUrl) { if (manual) toast('Сначала укажи адрес скрипта'); return; }
  if (syncBusy) return;
  if (!navigator.onLine) { setSync('error', 'Нет интернета'); if (manual) toast('Нет интернета'); return; }
  syncBusy = true;
  clearTimeout(syncTimer);
  setSync('busy');
  try {
    const fresh = !s.lastSync && !live('notes').length && !live('tasks').length;
    if (fresh) {
      // Первое подключение: если в таблице уже есть данные — берём их, иначе заливаем свои
      const data = await syncPost({});
      if (KINDS.some((k) => (data[k] || []).length)) {
        for (const k of KINDS) state[k] = (data[k] || []).map((r) => norm(k, r)).filter((e) => e.id);
      } else {
        const { changes, sent } = collectChanges();
        mergeRemote(await syncPost(changes));
        clearDirty(sent);
      }
    } else {
      const { changes, sent } = collectChanges();
      const data = await syncPost(changes);
      clearDirty(sent);
      mergeRemote(data);
    }
    s.lastSync = Date.now();
    save();
    setSync('ok');
    if (!ui.sheets.length) render();
    if (manual) toast('Синхронизировано ✓');
  } catch (e) {
    setSync('error', e.message);
    if (manual) toast(e.message);
  } finally {
    syncBusy = false;
  }
}

/* ---------------- Листы (модальные окна) ---------------- */

function openSheet({ title, left = 'Отмена', right = '', onRight, actions = {}, onInput, refresh, onClose, tall }) {
  const root = $('#sheet-root');
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  const sh = document.createElement('div');
  sh.className = 'sheet' + (tall ? ' tall' : '');
  sh.setAttribute('role', 'dialog');
  sh.innerHTML = `<div class="sheet-head"><button data-act="sheet-close">${esc(left)}</button><h2>${esc(title)}</h2><button data-act="sheet-right">${esc(right)}</button></div><div class="sheet-body"></div>`;
  root.append(bd, sh);
  const entry = { bd, sh, body: $('.sheet-body', sh), onRight, actions, refresh, onClose };
  ui.sheets.push(entry);
  bd.addEventListener('click', () => closeSheet());
  if (onInput) { sh.addEventListener('input', onInput); sh.addEventListener('change', onInput); }
  entry.refresh?.(entry);
  sh.getBoundingClientRect();
  bd.classList.add('show');
  sh.classList.add('show');
  return entry;
}
function closeSheet() {
  const e = ui.sheets.pop();
  if (!e) return;
  document.activeElement?.blur?.();
  e.onClose?.();
  e.bd.classList.remove('show');
  e.sh.classList.remove('show');
  setTimeout(() => { e.bd.remove(); e.sh.remove(); }, 280);
  refreshTopSheet();
  render();
}
function refreshTopSheet() {
  const top = ui.sheets[ui.sheets.length - 1];
  if (!top?.refresh) return;
  const st = top.body.scrollTop;
  top.refresh(top);
  top.body.scrollTop = st;
}

let toastTimer, toastUndo;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button data-act="toast-undo">Отменить</button>' : ''}`;
  toastUndo = undo;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); toastUndo = null; }, undo ? 4000 : 2200);
}

function autoGrow(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

/* ---------------- Строки списков ---------------- */

function folderTag(id) {
  const f = liveFolder(id);
  if (!f) return '';
  return `<span class="tag" style="${fc(f)}">${folderIcon(f)}${esc(f.name)}</span>`;
}

// opts: showFolder, showDate
function taskRow(t, opts = {}) {
  const today = ymd();
  const meta = [];
  if (opts.showDate && t.date) meta.push(`<span class="${!t.done && t.date < today ? 'late' : ''}">${esc(dateShort(t.date))}</span>`);
  if (opts.showFolder) meta.push(folderTag(t.folder));
  if (t.note.trim()) meta.push(`<span class="has-note">${icon('memo')}</span>`);
  return `<div class="task-wrap">
    <div class="task-bg">${icon('move')}Перенести</div>
    <div class="task${t.done ? ' done' : ''}" data-id="${t.id}">
      <button class="check" data-act="toggle" data-id="${t.id}" aria-label="Готово">${icon('check')}</button>
      <button class="t-main" data-act="task" data-id="${t.id}">
        <div class="t-title">${esc(t.title) || '<span style="color:var(--muted)">Без названия</span>'}</div>
        <div class="t-meta">${meta.join('')}</div>
      </button>
    </div>
  </div>`;
}

function addRow(placeholder, { date = '', folder = '', key }) {
  return `<label class="add-row"><span class="plus">${icon('plus')}</span>
    <input data-add="${key}" data-date="${date}" data-folder="${folder}" placeholder="${esc(placeholder)}" enterkeyhint="done" autocomplete="off"></label>`;
}

function noteRow(n, opts = {}) {
  const prev = notePreview(n);
  return `<button class="note-row" data-act="note" data-id="${n.id}">
    <div class="n-title">${esc(noteTitle(n))}</div>
    <div class="n-prev"><b>${esc(when(n.updatedAt))}</b>${esc(prev)}</div>
    ${opts.showFolder ? folderTag(n.folder) : ''}
  </button>`;
}

function calGrid(month, sel, act, stats = dayStats()) {
  const today = ymd();
  const first = month + '-01';
  let d = weekStart(first);
  const nextMonth = shiftMonth(month, 1) + '-01';
  let cells = '';
  while (d < nextMonth || parseYmd(d).getDay() !== 1) {
    const s = stats[d];
    const dots = s ? '<i></i>'.repeat(Math.min(3, s.open)) + (s.open ? '' : s.done ? '<i class="done"></i>' : '') : '';
    const cls = [d.slice(0, 7) !== month ? 'out' : '', d === today ? 'today' : '', d === sel ? 'sel' : ''].join(' ');
    cells += `<button class="${cls}" data-act="${act}" data-d="${d}">${parseYmd(d).getDate()}<span class="dots">${dots}</span></button>`;
    d = addDays(d, 1);
  }
  return `<div class="cal"><div class="cal-head">${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => `<span>${w}</span>`).join('')}</div><div class="cal-grid">${cells}</div></div>`;
}

/* ---------------- Экраны ---------------- */

function viewToday() {
  const d = ui.day, today = ymd();
  const { open, done } = tasksOn(d);
  const stats = dayStats();
  const ws = weekStart(d);
  let week = '';
  for (let i = 0; i < 7; i++) {
    const x = addDays(ws, i), s = stats[x];
    week += `<button class="wd${x === today ? ' today' : ''}${x === d ? ' sel' : ''}" data-act="day" data-d="${x}">
      <span class="w">${WD[parseYmd(x).getDay()]}</span><span class="n">${parseYmd(x).getDate()}</span>
      <i class="dot ${s?.open ? 'on' : s?.done ? 'done' : ''}"></i></button>`;
  }
  const total = open.length + done.length;
  const late = d === today ? lateTasks() : [];
  const tip = !state.settings.hideInstallTip && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;

  return `
  <div class="topbar">
    <div><h1>${dayWord(d) || `${parseYmd(d).getDate()} ${MONTHS_GEN[parseYmd(d).getMonth()]}`}</h1><div class="sub">${esc(dateLong(d))}</div></div>
    <div class="top-actions">
      ${d !== today ? `<button class="pill-btn" data-act="day" data-d="${today}">Сегодня</button>` : ''}
      <button class="icon-btn" data-act="settings" aria-label="Настройки">${icon('gear')}</button>
    </div>
  </div>
  ${tip ? `<div class="card info-card"><div>Установи на экран «Домой»: в Safari нажми <b>Поделиться</b> → <b>На экран «Домой»</b>.</div><button data-act="hide-tip" aria-label="Скрыть">×</button></div>` : ''}
  <div class="day-nav">
    <button class="arrow" data-act="day-shift" data-n="-1" aria-label="Предыдущий день">${icon('chevL')}</button>
    <div class="week">${week}</div>
    <button class="arrow" data-act="day-shift" data-n="1" aria-label="Следующий день">${icon('chevR')}</button>
  </div>

  ${late.length ? `
    <div class="section-title late-head"><span>Не сделано раньше · ${late.length}</span><button data-act="late-today">Всё на сегодня</button></div>
    <div class="tasks">${late.map((t) => taskRow(t, { showDate: true, showFolder: true })).join('')}</div>` : ''}

  ${total ? `<div class="progress-line"><span>${done.length} из ${total} ${plural(total, ['дела', 'дел', 'дел'])}</span><span class="bar"><i style="width:${Math.round(done.length / total * 100)}%"></i></span></div>`
    : `<div class="section-title"><span>Дела</span></div>`}
  <div class="tasks">
    ${open.map((t) => taskRow(t, { showFolder: true })).join('')}
    ${addRow(d === today ? 'Что сделать сегодня?' : 'Добавить дело', { date: d, key: 'day' })}
    ${done.map((t) => taskRow(t, { showFolder: true })).join('')}
  </div>
  ${!total && !late.length ? `<div class="hint" style="text-align:center;margin-top:14px">Смахни дело вправо, чтобы перенести его на другой день</div>` : ''}`;
}

function viewFolders() {
  if (ui.folder && liveFolder(ui.folder)) return viewFolder(liveFolder(ui.folder));
  ui.folder = '';
  const all = live('tasks'), notes = live('notes');
  const cards = folders().map((f) => {
    const t = all.filter((x) => x.folder === f.id && !x.done).length;
    const n = notes.filter((x) => x.folder === f.id).length;
    const meta = [t ? `${t} ${plural(t, ['дело', 'дела', 'дел'])}` : '', n ? `${n} ${plural(n, ['заметка', 'заметки', 'заметок'])}` : ''].filter(Boolean).join(' · ') || 'пусто';
    return `<button class="folder-card" data-act="folder" data-id="${f.id}" style="${fc(f)}">
      <span class="f-ico">${folderIcon(f)}</span><span class="name">${esc(f.name)}</span><span class="meta">${meta}</span></button>`;
  }).join('');
  const inbox = inboxCount();
  return `
  <div class="topbar"><div><h1>Папки</h1></div>
    <div class="top-actions"><button class="icon-btn" data-act="settings" aria-label="Настройки">${icon('gear')}</button></div></div>
  <div class="folder-grid">
    ${cards}
    <button class="folder-card add" data-act="folder-new">+ Новая папка</button>
  </div>
  ${inbox ? `<div class="section-title"><span>Не разложено</span></div>
    <div class="card"><button class="note-row" data-act="tab" data-tab="inbox"><div class="n-title">Входящие · ${inbox}</div><div class="n-prev">Заметки и дела без папки</div></button></div>` : ''}`;
}

function viewFolder(f) {
  const tasks = live('tasks').filter((t) => t.folder === f.id);
  const open = tasks.filter((t) => !t.done).sort(sortOpen);
  const done = tasks.filter((t) => t.done).sort(sortDone);
  const notes = live('notes').filter((n) => n.folder === f.id).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt);
  const tab = ui.folderTab;
  let body;
  if (tab === 'tasks') {
    body = `
    <div class="tasks" style="margin-top:14px">
      ${addRow('Новое дело', { folder: f.id, key: 'folder' })}
      ${open.map((t) => taskRow(t, { showDate: true })).join('')}
    </div>
    ${!open.length ? '<div class="empty">Открытых дел нет</div>' : ''}
    ${done.length ? `<button class="toggle-done" data-act="toggle-show-done">${ui.showDone ? 'Скрыть' : 'Показать'} выполненные · ${done.length}</button>
      ${ui.showDone ? `<div class="tasks">${done.map((t) => taskRow(t, { showDate: true })).join('')}</div>` : ''}` : ''}`;
  } else {
    body = `
    <button class="btn secondary small" data-act="note-new" data-folder="${f.id}" style="margin-top:14px">+ Новая заметка</button>
    ${notes.length ? `<div class="card" style="margin-top:12px">${notes.map((n) => noteRow(n)).join('')}</div>` : '<div class="empty">Заметок пока нет</div>'}`;
  }
  return `
  <button class="back" data-act="folders-back">${icon('chevL')}Папки</button>
  <div class="topbar">
    <div class="folder-head" style="${fc(f)}"><span class="f-ico">${folderIcon(f)}</span><h1>${esc(f.name)}</h1></div>
    <div class="top-actions"><button class="icon-btn" data-act="folder-edit" data-id="${f.id}" aria-label="Изменить папку">${icon('edit')}</button></div>
  </div>
  <div class="seg">
    <button class="${tab === 'tasks' ? 'on' : ''}" data-act="folder-tab" data-t="tasks">Дела${open.length ? ' · ' + open.length : ''}</button>
    <button class="${tab === 'notes' ? 'on' : ''}" data-act="folder-tab" data-t="notes">Заметки${notes.length ? ' · ' + notes.length : ''}</button>
  </div>
  ${body}`;
}

function viewCalendar() {
  const d = ui.calDay;
  const { open, done } = tasksOn(d);
  return `
  <div class="topbar"><div><h1>Календарь</h1></div>
    <div class="top-actions">${ui.calMonth !== ymd().slice(0, 7) || d !== ymd() ? `<button class="pill-btn" data-act="cal-today">Сегодня</button>` : ''}</div></div>
  <div class="month-switch">
    <button data-act="cal-month" data-n="-1" aria-label="Предыдущий месяц">${icon('chevL')}</button>
    <span>${monthLabel(ui.calMonth)}</span>
    <button data-act="cal-month" data-n="1" aria-label="Следующий месяц">${icon('chevR')}</button>
  </div>
  <div class="card" style="margin-top:10px">${calGrid(ui.calMonth, d, 'cal-day')}</div>
  <div class="section-title"><span>${esc(dateLong(d))}</span><button data-act="open-day" data-d="${d}">В ежедневник</button></div>
  <div class="tasks">
    ${open.map((t) => taskRow(t, { showFolder: true })).join('')}
    ${addRow('Добавить дело', { date: d, key: 'cal' })}
    ${done.map((t) => taskRow(t, { showFolder: true })).join('')}
  </div>`;
}

function viewInbox() {
  const notes = inboxNotes(), tasks = inboxTasks();
  return `
  <div class="topbar"><div><h1>Входящие</h1><div class="sub">Всё, что добавлено без папки и даты</div></div></div>
  <div class="card info-card"><div>Скоро здесь заработает <b>автосортировка</b>: новые записи будут сами раскладываться по папкам. Пока — открой запись и выбери папку.</div></div>
  <div class="section-title"><span>Дела</span></div>
  <div class="tasks">
    ${addRow('Быстрое дело', { key: 'inbox' })}
    ${tasks.map((t) => taskRow(t)).join('')}
  </div>
  <div class="section-title"><span>Заметки</span><button data-act="note-new" data-folder="">+ Заметка</button></div>
  ${notes.length ? `<div class="card">${notes.map((n) => noteRow(n)).join('')}</div>` : '<div class="empty">Пусто — всё разложено</div>'}`;
}

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const views = { today: viewToday, folders: viewFolders, calendar: viewCalendar, inbox: viewInbox };
  $('#view').innerHTML = (views[ui.tab] || viewToday)();
  const n = inboxCount();
  $('#inbox-badge').textContent = n ? String(n) : '';
  if (ui.refocus) {
    $(`[data-add="${ui.refocus}"]`)?.focus();
    ui.refocus = '';
  }
}

/* ---------------- Выбор даты ---------------- */

function openDatePicker({ title = 'Перенести на', current = '', allowNone = true, onPick }) {
  const today = ymd();
  const quick = [
    ['Сегодня', today], ['Завтра', addDays(today, 1)],
    ['Послезавтра', addDays(today, 2)], ['В понедельник', nextMonday(today)],
    ['Через неделю', addDays(today, 7)],
  ];
  if (allowNone) quick.push(['Без даты', '']);
  const entry = openSheet({
    title,
    refresh: (e) => {
      e.m ||= (current || today).slice(0, 7);
      e.body.innerHTML = `
      <div class="quick-dates">${quick.map(([l, d]) => `<button class="${d === current ? 'on' : ''}" data-act="pick" data-d="${d}">${l}<small>${d ? `${WD[parseYmd(d).getDay()]}, ${parseYmd(d).getDate()} ${MONTHS_SHORT[parseYmd(d).getMonth()]}` : ''}</small></button>`).join('')}</div>
      <div class="month-switch" style="margin-top:14px">
        <button data-act="m" data-n="-1">${icon('chevL')}</button><span>${monthLabel(e.m)}</span><button data-act="m" data-n="1">${icon('chevR')}</button>
      </div>
      <div class="card" style="margin-top:10px">${calGrid(e.m, current, 'pick')}</div>`;
    },
    actions: {
      pick: (el) => { closeSheet(); onPick(el.dataset.d); },
      m: (el) => { entry.m = shiftMonth(entry.m, Number(el.dataset.n)); refreshTopSheet(); },
    },
  });
}

function moveTasks(ids, date) {
  const before = ids.map((id) => [id, byId('tasks', id)?.date || '']);
  for (const id of ids) patch('tasks', id, { date, order: Date.now() });
  render();
  refreshTopSheet();
  const what = ids.length > 1 ? `${ids.length} ${plural(ids.length, ['дело', 'дела', 'дел'])} перенесено` : 'Перенесено';
  toast(date ? `${what}: ${dateShort(date)}` : `${what}: без даты`, () => {
    for (const [id, d] of before) patch('tasks', id, { date: d });
    render();
    refreshTopSheet();
  });
}

/* ---------------- Быстрое добавление (кнопка +) ---------------- */

function openCapture() {
  const c = { kind: 'task', date: '', folder: '' };
  if (ui.tab === 'today') c.date = ui.day;
  if (ui.tab === 'calendar') c.date = ui.calDay;
  if (ui.tab === 'folders' && ui.folder) { c.folder = ui.folder; if (ui.folderTab === 'notes') c.kind = 'note'; }
  const today = ymd();

  const paintOpts = (e) => {
    const dates = [['Сегодня', today], ['Завтра', addDays(today, 1)], ['Без даты', '']];
    const custom = c.date && !dates.some(([, d]) => d === c.date);
    $('.opts', e.body).innerHTML = `
      <div class="field-label" style="margin-top:12px">Тип</div>
      <div class="seg"><button class="${c.kind === 'task' ? 'on' : ''}" data-act="kind" data-k="task">Дело</button><button class="${c.kind === 'note' ? 'on' : ''}" data-act="kind" data-k="note">Заметка</button></div>
      ${c.kind === 'task' ? `
      <div class="field-label">Когда</div>
      <div class="chips">
        ${dates.map(([l, d]) => `<button class="chip${c.date === d ? ' on' : ''}" data-act="date" data-d="${d}">${l}</button>`).join('')}
        <button class="chip${custom ? ' on' : ''}" data-act="date-pick">${icon('cal')}${custom ? esc(dateShort(c.date)) : 'Дата…'}</button>
      </div>` : ''}
      <div class="field-label">Папка</div>
      <div class="chips">
        <button class="chip${!c.folder ? ' on' : ''}" data-act="folder-pick" data-id="">${icon('inbox')}${c.kind === 'task' && c.date ? 'Без папки' : 'Входящие'}</button>
        ${folders().map((f) => `<button class="chip${c.folder === f.id ? ' on' : ''}" style="${fc(f)}" data-act="folder-pick" data-id="${f.id}">${folderIcon(f)}${esc(f.name)}</button>`).join('')}
      </div>
      <button class="btn" data-act="save">Добавить</button>`;
  };

  const submit = () => {
    const text = $('.capture', entry.body).value.trim();
    if (!text) { toast('Напиши текст'); return; }
    if (c.kind === 'task') {
      // Несколько строк — несколько дел
      const lines = text.split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
      lines.forEach((title, i) => newTask({ title, date: c.date, folder: c.folder, order: Date.now() + i }));
      closeSheet();
      toast(lines.length > 1 ? `Добавлено ${lines.length} ${plural(lines.length, ['дело', 'дела', 'дел'])}` : 'Дело добавлено');
    } else {
      const [first, ...rest] = text.split('\n');
      const n = newNote({ folder: c.folder, title: first.trim().slice(0, 120), body: rest.join('\n').trim() });
      upsert('notes', n);
      closeSheet();
      toast(c.folder ? `Заметка в «${liveFolder(c.folder).name}»` : 'Заметка во «Входящих»');
    }
  };

  const entry = openSheet({
    title: 'Новая запись',
    right: 'Добавить',
    onRight: submit,
    refresh: (e) => {
      if (!$('.capture', e.body)) {
        e.body.innerHTML = `<textarea class="textarea capture" rows="3" placeholder="Что нужно сделать или запомнить?"></textarea><div class="opts"></div>`;
      }
      paintOpts(e);
    },
    actions: {
      kind: (el) => { c.kind = el.dataset.k; paintOpts(entry); },
      date: (el) => { c.date = el.dataset.d; paintOpts(entry); },
      'date-pick': () => openDatePicker({ title: 'Дата', current: c.date, onPick: (d) => { c.date = d; paintOpts(entry); } }),
      'folder-pick': (el) => { c.folder = el.dataset.id; paintOpts(entry); },
      save: submit,
    },
    onInput: (e) => { if (e.target.matches('.capture')) autoGrow(e.target); },
  });
  setTimeout(() => $('.capture', entry.body)?.focus(), 50);
}

/* ---------------- Дело ---------------- */

function openTask(id) {
  const t0 = byId('tasks', id);
  if (!t0) return;
  let timer;
  const cur = () => byId('tasks', id);
  const flush = () => {
    clearTimeout(timer);
    const e = entry.body;
    const title = $('.t-edit', e)?.value.trim() ?? '';
    const note = $('.t-note', e)?.value ?? '';
    const t = cur();
    if (t && !t.deleted && (t.title !== title || t.note !== note)) patch('tasks', id, { title: title || t.title, note });
  };
  const paintOpts = (e) => {
    const t = cur();
    if (!t) return;
    const today = ymd();
    const dates = [['Сегодня', today], ['Завтра', addDays(today, 1)], ['Без даты', '']];
    const custom = t.date && !dates.some(([, d]) => d === t.date);
    $('.opts', e.body).innerHTML = `
      <div class="field-label">Когда</div>
      <div class="chips">
        ${dates.map(([l, d]) => `<button class="chip${t.date === d ? ' on' : ''}" data-act="date" data-d="${d}">${l}</button>`).join('')}
        <button class="chip${custom ? ' on' : ''}" data-act="date-pick">${icon('cal')}${custom ? esc(dateShort(t.date)) : 'Дата…'}</button>
      </div>
      <div class="field-label">Папка</div>
      <div class="chips">
        <button class="chip${!liveFolder(t.folder) ? ' on' : ''}" data-act="folder-pick" data-id="">${icon('inbox')}Без папки</button>
        ${folders().map((f) => `<button class="chip${t.folder === f.id ? ' on' : ''}" style="${fc(f)}" data-act="folder-pick" data-id="${f.id}">${folderIcon(f)}${esc(f.name)}</button>`).join('')}
      </div>
      <button class="btn${t.done ? ' secondary' : ''}" data-act="done">${t.done ? 'Вернуть в работу' : 'Готово ✓'}</button>
      <button class="btn danger small" data-act="del">Удалить дело</button>`;
  };
  const entry = openSheet({
    title: 'Дело',
    left: 'Закрыть',
    tall: false,
    refresh: (e) => {
      if (!$('.t-edit', e.body)) {
        const t = cur();
        e.body.innerHTML = `
          <textarea class="textarea t-edit" rows="1" style="min-height:0;font-size:18px;font-weight:600" placeholder="Название">${esc(t.title)}</textarea>
          <div class="field-label">Заметка к делу</div>
          <textarea class="textarea t-note" rows="2" style="min-height:70px" placeholder="Подробности, ссылки…">${esc(t.note)}</textarea>
          <div class="opts"></div>`;
        e.body.querySelectorAll('textarea').forEach((x) => requestAnimationFrame(() => autoGrow(x)));
      }
      paintOpts(e);
    },
    onInput: (e) => {
      if (e.target.tagName !== 'TEXTAREA') return;
      autoGrow(e.target);
      clearTimeout(timer);
      timer = setTimeout(flush, 600);
    },
    onClose: flush,
    actions: {
      date: (el) => { flush(); patch('tasks', id, { date: el.dataset.d }); paintOpts(entry); },
      'date-pick': () => { flush(); openDatePicker({ title: 'Дата', current: cur().date, onPick: (d) => { patch('tasks', id, { date: d }); paintOpts(entry); } }); },
      'folder-pick': (el) => { flush(); patch('tasks', id, { folder: el.dataset.id }); paintOpts(entry); },
      done: () => { flush(); toggleTask(id); closeSheet(); },
      del: () => {
        flush();
        patch('tasks', id, { deleted: true });
        closeSheet();
        toast('Дело удалено', () => { patch('tasks', id, { deleted: false }); render(); });
      },
    },
  });
}

function toggleTask(id, rowEl) {
  const t = byId('tasks', id);
  if (!t) return;
  const done = !t.done;
  patch('tasks', id, { done, doneAt: done ? Date.now() : 0 });
  if (rowEl) {
    rowEl.classList.toggle('done', done);
    if (navigator.vibrate) navigator.vibrate(10);
    clearTimeout(toggleTask.timer);
    toggleTask.timer = setTimeout(render, 550);
  } else render();
}

/* ---------------- Заметка ---------------- */

function openNote(id, folder = '') {
  let n = id ? { ...byId('notes', id) } : newNote({ folder });
  const isNew = !id;
  let timer, saved = !isNew;
  const flush = () => {
    clearTimeout(timer);
    const title = $('.note-title', entry.body).value;
    const body = $('.note-body', entry.body).value;
    const empty = !title.trim() && !body.trim();
    if (empty && !saved) return;
    const cur = byId('notes', n.id);
    if (cur && cur.title === title && cur.body === body && cur.folder === n.folder && !cur.deleted) return;
    n = { ...(cur || n), title, body, folder: n.folder, deleted: empty };
    upsert('notes', n);
    saved = true;
  };
  const paintFolders = (e) => {
    $('.opts', e.body).innerHTML = `
      <div class="field-label">Папка</div>
      <div class="chips">
        <button class="chip${!liveFolder(n.folder) ? ' on' : ''}" data-act="folder-pick" data-id="">${icon('inbox')}Входящие</button>
        ${folders().map((f) => `<button class="chip${n.folder === f.id ? ' on' : ''}" style="${fc(f)}" data-act="folder-pick" data-id="${f.id}">${folderIcon(f)}${esc(f.name)}</button>`).join('')}
      </div>
      ${saved ? `<button class="btn danger small" data-act="del" style="margin-top:24px">Удалить заметку</button>` : ''}
      <div class="note-foot">${saved ? 'Изменено ' + esc(when(byId('notes', n.id)?.updatedAt || Date.now())) : 'Новая заметка'}</div>`;
  };
  const entry = openSheet({
    title: '',
    left: 'Готово',
    tall: true,
    refresh: (e) => {
      if (!$('.note-body', e.body)) {
        e.body.innerHTML = `
          <input class="note-title" placeholder="Заголовок" value="${esc(n.title)}" enterkeyhint="next">
          <textarea class="note-body" placeholder="Текст заметки">${esc(n.body)}</textarea>
          <div class="opts"></div>`;
        requestAnimationFrame(() => autoGrow($('.note-body', e.body)));
      }
      paintFolders(e);
    },
    onInput: (e) => {
      if (e.target.matches('.note-body')) autoGrow(e.target);
      clearTimeout(timer);
      timer = setTimeout(() => { flush(); paintFolders(entry); }, 700);
    },
    onClose: flush,
    actions: {
      'folder-pick': (el) => { n.folder = el.dataset.id; flush(); paintFolders(entry); },
      del: () => {
        clearTimeout(timer);
        const cur = byId('notes', n.id);
        if (cur) upsert('notes', { ...cur, deleted: true });
        saved = false;
        $('.note-title', entry.body).value = '';
        $('.note-body', entry.body).value = '';
        closeSheet();
        toast('Заметка удалена', () => { const c = byId('notes', n.id); if (c) upsert('notes', { ...c, deleted: false }); render(); });
      },
    },
  });
  if (isNew) setTimeout(() => $('.note-title', entry.body)?.focus(), 50);
}

/* ---------------- Папка: создание и настройка ---------------- */

function openFolderEdit(id) {
  const f = id ? { ...byId('folders', id) } : { id: uid('f'), name: '', icon: 'folder', color: COLORS[folders().length % COLORS.length], order: folders().length, deleted: false };
  const commit = () => {
    const name = $('#f-name', entry.body).value.trim();
    if (!name) { toast('Назови папку'); return; }
    upsert('folders', { ...f, name });
    closeSheet();
    if (!id) { ui.tab = 'folders'; ui.folder = f.id; render(); }
  };
  const entry = openSheet({
    title: id ? 'Папка' : 'Новая папка',
    right: 'Готово',
    onRight: commit,
    refresh: (e) => {
      if (!$('#f-name', e.body)) e.body.innerHTML = `<input class="input" id="f-name" placeholder="Название" value="${esc(f.name)}" style="margin-top:6px"><div class="opts"></div>`;
      $('.opts', e.body).innerHTML = `
        <div class="field-label">Цвет</div>
        <div class="color-row">${COLORS.map((c) => `<button class="color-opt${f.color === c ? ' on' : ''}" style="--fc:var(--c-${c})" data-act="color" data-c="${c}" aria-label="${c}"></button>`).join('')}</div>
        <div class="field-label">Значок</div>
        <div class="icon-grid">${Object.keys(FOLDER_ICONS).map((k) => `<button class="icon-opt${f.icon === k ? ' on' : ''}" data-act="ic" data-k="${k}">${svg(FOLDER_ICONS[k])}</button>`).join('')}</div>
        ${id ? `<button class="btn danger small" data-act="del" style="margin-top:24px">Удалить папку</button>
        <div class="hint">Заметки и дела из неё переедут во «Входящие».</div>` : ''}`;
    },
    actions: {
      color: (el) => { f.color = el.dataset.c; refreshTopSheet(); },
      ic: (el) => { f.icon = el.dataset.k; refreshTopSheet(); },
      del: () => {
        if (!confirm(`Удалить папку «${f.name}»? Её заметки и дела переедут во «Входящие».`)) return;
        for (const n of live('notes').filter((x) => x.folder === id)) upsert('notes', { ...n, folder: '' });
        for (const t of live('tasks').filter((x) => x.folder === id)) upsert('tasks', { ...t, folder: '' });
        patch('folders', id, { deleted: true });
        ui.folder = '';
        closeSheet();
        toast('Папка удалена');
      },
    },
  });
  if (!id) setTimeout(() => $('#f-name', entry.body)?.focus(), 50);
}

/* ---------------- Настройки ---------------- */

function openSettings() {
  openSheet({
    title: 'Настройки',
    left: 'Закрыть',
    refresh: (entry) => {
      const s = state.settings;
      const syncState = { ok: ['ok', 'Синхронизировано'], error: ['err', ui.sync.msg || 'Ошибка'], busy: ['wait', 'Синхронизация…'] }[ui.sync.status];
      const last = s.lastSync ? new Date(s.lastSync).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'ещё не было';
      entry.body.innerHTML = `
      <div class="section-title" style="margin-top:8px"><span>Google Таблица</span></div>
      <div class="card" style="padding:16px">
        <div class="field-label" style="margin-top:0">Адрес веб-приложения Apps Script</div>
        <input class="input" id="s-url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(s.syncUrl)}" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div class="field-label">Секретный ключ</div>
        <input class="input" id="s-secret" placeholder="Тот же, что в скрипте" value="${esc(s.syncSecret)}" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div class="hint">${syncState ? `<span class="sync-dot ${syncState[0]}"></span>${esc(syncState[1])} · ` : ''}последняя синхронизация: ${last}</div>
        <button class="btn small" data-act="sync-now">Синхронизировать сейчас</button>
      </div>
      <div class="section-title"><span>Данные</span></div>
      <div class="card">
        <button class="note-row" data-act="backup-export" style="color:var(--accent)">Сохранить резервную копию (JSON)</button>
        <button class="note-row" data-act="backup-import" style="color:var(--accent)">Восстановить из копии</button>
      </div>
      <div class="hint" style="text-align:center;margin:18px 0 0">Заметки ${APP_VERSION} · данные хранятся на телефоне${s.syncUrl ? ' и в твоей Google-таблице' : ''}</div>`;
    },
    onInput: (e) => {
      if (e.type !== 'change') return;
      const s = state.settings;
      if (e.target.id === 's-url') { s.syncUrl = e.target.value.trim(); save(); }
      if (e.target.id === 's-secret') { s.syncSecret = e.target.value.trim(); save(); }
    },
  });
}

async function shareFile(text, name, type) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportBackup() {
  const data = { app: 'notespanel', version: APP_VERSION, exportedAt: new Date().toISOString() };
  for (const k of KINDS) data[k] = state[k];
  data.settings = { ...state.settings, syncSecret: '' };
  shareFile(JSON.stringify(data, null, 1), `notes-backup-${ymd()}.json`, 'application/json');
}

function importBackup() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    try {
      const data = JSON.parse(await inp.files[0].text());
      if (!KINDS.every((k) => Array.isArray(data[k]))) throw new Error();
      if (!confirm('Заменить текущие данные на устройстве данными из копии?')) return;
      const keepSync = { syncUrl: state.settings.syncUrl, syncSecret: state.settings.syncSecret };
      for (const k of KINDS) state[k] = data[k].map((e) => ({ ...e, _dirty: true }));
      state.settings = { ...defaultSettings(), ...(data.settings || {}), ...keepSync, lastSync: 1 };
      save();
      closeSheet();
      scheduleSync(500);
      toast('Данные восстановлены');
    } catch (e) {
      toast('Не удалось прочитать файл');
    }
  };
  inp.click();
}

/* ---------------- Действия ---------------- */

const ACTIONS = {
  'sheet-close': () => closeSheet(),
  'sheet-right': () => ui.sheets[ui.sheets.length - 1]?.onRight?.(),
  'toast-undo': () => { const u = toastUndo; toastUndo = null; $('#toast').classList.remove('show'); u?.(); },
  tab: (el) => { ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  settings: () => openSettings(),
  'sync-now': () => syncNow(true),
  'backup-export': () => exportBackup(),
  'backup-import': () => importBackup(),
  'hide-tip': () => { state.settings.hideInstallTip = true; save(); render(); },

  day: (el) => { ui.day = el.dataset.d; render(); },
  'day-shift': (el) => { ui.day = addDays(ui.day, Number(el.dataset.n)); render(); },
  'late-today': () => moveTasks(lateTasks().map((t) => t.id), ymd()),
  toggle: (el) => toggleTask(el.dataset.id, el.closest('.task')),
  task: (el) => openTask(el.dataset.id),

  folder: (el) => { ui.folder = el.dataset.id; ui.folderTab = 'tasks'; ui.showDone = false; render(); window.scrollTo(0, 0); },
  'folders-back': () => { ui.folder = ''; render(); },
  'folder-tab': (el) => { ui.folderTab = el.dataset.t; render(); },
  'folder-new': () => openFolderEdit(null),
  'folder-edit': (el) => openFolderEdit(el.dataset.id),
  'toggle-show-done': () => { ui.showDone = !ui.showDone; render(); },
  note: (el) => openNote(el.dataset.id),
  'note-new': (el) => openNote(null, el.dataset.folder || ''),

  'cal-month': (el) => { ui.calMonth = shiftMonth(ui.calMonth, Number(el.dataset.n)); render(); },
  'cal-day': (el) => { ui.calDay = el.dataset.d; ui.calMonth = el.dataset.d.slice(0, 7); render(); },
  'cal-today': () => { ui.calDay = ymd(); ui.calMonth = ymd().slice(0, 7); render(); },
  'open-day': (el) => { ui.day = el.dataset.d; ui.tab = 'today'; render(); window.scrollTo(0, 0); },
};

document.addEventListener('click', (e) => {
  if (Date.now() - ui.swallowClick < 400) { e.preventDefault(); return; }
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    if (ui.tab === tabBtn.dataset.tab && tabBtn.dataset.tab === 'folders') ui.folder = '';
    if (tabBtn.dataset.tab === 'today' && ui.tab === 'today') ui.day = ymd();
    ui.tab = tabBtn.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (e.target.closest('#fab')) { openCapture(); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  // Сначала ищем обработчик у листа, в котором произошёл клик
  const sheet = ui.sheets.find((s) => s.sh.contains(el));
  const fn = sheet?.actions?.[act] || ACTIONS[act];
  if (fn) { e.preventDefault(); fn(el); }
});

// Строка «+ Добавить дело»: Enter — сохранить и остаться в поле
function addFromInput(inp, keepFocus) {
  const title = inp.value.trim();
  if (!title) return false;
  newTask({ title, date: inp.dataset.date, folder: inp.dataset.folder });
  inp.value = '';
  if (keepFocus) ui.refocus = inp.dataset.add;
  return true;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); return; }
  if (e.key !== 'Enter' || e.isComposing) return;
  const inp = e.target.closest?.('[data-add]');
  if (inp) { e.preventDefault(); if (addFromInput(inp, true)) render(); else inp.blur(); return; }
  if (e.target.id === 'f-name') { e.preventDefault(); ui.sheets[ui.sheets.length - 1]?.onRight?.(); }
  if (e.target.matches?.('.note-title')) { e.preventDefault(); $('.note-body', e.target.closest('.sheet'))?.focus(); }
});
document.addEventListener('focusout', (e) => {
  const inp = e.target.closest?.('[data-add]');
  if (inp && addFromInput(inp, false)) setTimeout(render, 300);
});

/* ---------------- Смахивание дела вправо → перенос ---------------- */

let swipe = null;
const SWIPE_AT = 80;
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.task');
  if (!row || e.button > 0) return;
  swipe = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, active: false, pid: e.pointerId };
});
document.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.pid) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (dx > 10 && dx > Math.abs(dy) * 1.2) {
      swipe.active = true;
      swipe.bg = swipe.row.previousElementSibling;
      swipe.row.classList.remove('anim');
      try { swipe.row.setPointerCapture(e.pointerId); } catch (_) {}
    } else return;
  }
  swipe.dx = Math.max(0, dx - 10);
  const shift = swipe.dx < 110 ? swipe.dx : 110 + (swipe.dx - 110) * 0.35;
  swipe.row.style.transform = `translateX(${shift}px)`;
  swipe.bg.style.opacity = Math.min(1, swipe.dx / 50);
  if (!swipe.armed && swipe.dx > SWIPE_AT && navigator.vibrate) navigator.vibrate(8);
  swipe.armed = swipe.dx > SWIPE_AT;
});
function endSwipe(e, cancelled) {
  if (!swipe || e.pointerId !== swipe.pid) return;
  const s = swipe;
  swipe = null;
  if (!s.active) return;
  ui.swallowClick = Date.now();
  s.row.classList.add('anim');
  s.row.style.transform = '';
  s.bg.style.transition = 'opacity .2s';
  s.bg.style.opacity = 0;
  if (!cancelled && s.dx > SWIPE_AT) {
    const t = byId('tasks', s.id);
    openDatePicker({ current: t?.date || '', onPick: (d) => moveTasks([s.id], d) });
  }
}
document.addEventListener('pointerup', (e) => endSwipe(e, false));
document.addEventListener('pointercancel', (e) => endSwipe(e, true));

/* ---------------- Жизненный цикл ---------------- */

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state && state.settings.syncUrl && hasDirty()) syncNow(false);
  } else if (state) {
    // Наступил новый день — ежедневник переключается на него
    const t = ymd();
    if (ui.lastToday !== t) {
      if (ui.day === ui.lastToday) ui.day = t;
      if (ui.calDay === ui.lastToday) { ui.calDay = t; ui.calMonth = t.slice(0, 7); }
      ui.lastToday = t;
    }
    if (!ui.sheets.length) render();
    if (state.settings.syncUrl) scheduleSync(800);
  }
});
window.addEventListener('online', () => state && scheduleSync(500));

async function init() {
  const saved = await Store.get('state');
  if (saved && Array.isArray(saved.tasks)) {
    state = saved;
    for (const k of KINDS) state[k] = state[k] || [];
    state.settings = { ...defaultSettings(), ...(state.settings || {}) };
  } else {
    state = defaultState();
    save();
  }
  render();
  try { navigator.storage?.persist?.(); } catch (e) {}
  if (state.settings.syncUrl) scheduleSync(600);
}

// Обновления: проверяем при каждом возврате в приложение; новая версия
// перезагружает страницу сама (если не открыта форма — тогда при сворачивании).
let pendingReload = false;
if ('serviceWorker' in navigator && location.protocol !== 'file:' && location.hostname !== 'localhost') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || pendingReload) return;
    pendingReload = true;
    if (!ui.sheets.length) location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (pendingReload && document.visibilityState === 'hidden') location.reload();
  });
}

init();
