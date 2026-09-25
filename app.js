'use strict';

/* =========================================================
   Заметки — PWA: ежедневник, папки с темами (текст, чек-листы, файлы),
   календарь и напоминания.
   Данные: IndexedDB на телефоне + синхронизация с Google Sheets
   через Apps Script (см. google-apps-script/Code.gs). Файлы — в Google Диске.
   ========================================================= */

const APP_VERSION = '0.2.0';

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
const dayMonth = (s) => `${WD[parseYmd(s).getDay()]}, ${parseYmd(s).getDate()} ${MONTHS_SHORT[parseYmd(s).getMonth()]}`;
function nextMonday(s) { const d = parseYmd(s); return addDays(s, ((8 - d.getDay()) % 7) || 7); }
function fmtSize(n) {
  if (n < 1024) return n + ' Б';
  if (n < 1048576) return Math.round(n / 1024) + ' КБ';
  return (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bufToB64(buf) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(new Blob([buf]));
  });
}
function b64ToBuf(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer; }

const P = {
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  move: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  memo: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  inbox: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 13.5H9a3 3 0 0 0 6 0h5.5"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  checklist: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><path d="m5.4 7 1.3 1.3 2.2-2.5M14 7h7M3.5 17.5h7M14 17.5h7"/>',
  photo: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 8.5"/>',
  clip: '<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/>',
  dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  kbd: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8"/>',
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
const FOLDER_IMAGES = { MOST: 'icons/folders/most.png', 'Возвраты': 'icons/folders/vozvraty.png' };
const COLORS = ['blue', 'orange', 'pink', 'violet', 'green', 'teal', 'red', 'gray'];
const svg = (p, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24">${p}</svg>`;
const icon = (k) => svg(P[k]);
const folderIcon = (f) => (f?.image ? `<img src="${esc(f.image)}" alt="">` : svg(FOLDER_ICONS[f?.icon] || FOLDER_ICONS.folder));
const fc = (f) => `--fc:var(--c-${COLORS.includes(f?.color) ? f.color : 'gray'})`;

/* ---------------- Хранилище: состояние и файлы в IndexedDB ---------------- */

const Store = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('notespanel', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      r.onsuccess = () => { this.db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async req(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q?.result);
      t.onerror = () => rej(t.error);
    });
  },
  async get(k) {
    try { return await this.req('kv', 'readonly', (s) => s.get(k)); } catch (e) {
      try { const v = localStorage.getItem('np_' + k); return v ? JSON.parse(v) : undefined; } catch (_) { return undefined; }
    }
  },
  async set(k, v) {
    try { await this.req('kv', 'readwrite', (s) => s.put(v, k)); } catch (e) {
      try { localStorage.setItem('np_' + k, JSON.stringify(v)); } catch (_) { toast('Не удалось сохранить данные'); }
    }
  },
  getFile(id) { return this.req('files', 'readonly', (s) => s.get(id)).catch(() => undefined); },
  putFile(id, rec) { return this.req('files', 'readwrite', (s) => s.put(rec, id)); },
  delFile(id) { return this.req('files', 'readwrite', (s) => s.delete(id)).catch(() => {}); },
};

/* ---------------- Состояние ---------------- */

const KINDS = ['folders', 'notes', 'tasks', 'files'];
let state;
const ui = {
  tab: 'today', day: ymd(), lastToday: ymd(), weekAnim: 0,
  calMonth: ymd().slice(0, 7), calDay: ymd(),
  folder: '', arrange: false,
  sync: { status: 'idle', msg: '' }, sheets: [], refocus: '', swallowClick: 0,
};

function defaultSettings() {
  return {
    syncUrl: '', syncSecret: '', lastSync: 0, hideInstallTip: false,
    pushOn: false, vapidKey: '', digestOn: true, digest: '09:00', eveningOn: false, evening: '21:00',
  };
}

function defaultState() {
  const now = Date.now();
  const folders = [
    ['MOST', 'rocket', 'blue'],
    ['Возвраты', 'return', 'green'],
    ['Мой Instagram', 'camera', 'pink'],
    ['Мой Telegram', 'send', 'teal'],
    ['Дом, семья', 'home', 'orange'],
  ].map(([name, ic, color], i) => ({ id: uid('f'), name, icon: ic, color, image: FOLDER_IMAGES[name] || '', order: i, updatedAt: now, deleted: false, _dirty: true }));
  return { v: 2, folders, notes: [], tasks: [], files: [], settings: defaultSettings() };
}

function save() { Store.set('state', state); }

const live = (k) => state[k].filter((e) => !e.deleted);
const byId = (k, id) => (id ? state[k].find((e) => e.id === id) : undefined);
const liveById = (k, id) => { const e = byId(k, id); return e && !e.deleted ? e : undefined; };
const folders = () => live('folders').sort(byOrder);
const liveFolder = (id) => liveById('folders', id);

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
  const t = { id: uid('t'), title: '', noteId: '', folder: '', date: '', remind: '', note: '', done: false, doneAt: 0, order: now, createdAt: now, deleted: false, ...o };
  upsert('tasks', t);
  return t;
}
function newNote(o) {
  const now = Date.now();
  return { id: uid('n'), folder: '', title: '', blocks: [{ t: 'text', text: '' }], pinned: false, createdAt: now, deleted: false, ...o };
}

/* ---------------- Темы: блоки текста, дел и файлов ----------------
   note.blocks = [{t:'text', text}, {t:'task', id}, {t:'file', id}]
   Дела из тем — обычные задачи (state.tasks) с noteId, поэтому попадают в ежедневник. */

// Склеивает соседние тексты, убирает пустые и удалённое, оставляет текст в конце.
// focus = {block, pos} — блок, который нельзя выкидывать, и позиция курсора в нём.
function normalize(bl, focus) {
  const out = [];
  for (const b of bl) {
    if (b.t === 'task' && !liveById('tasks', b.id)) continue;
    if (b.t === 'file' && !liveById('files', b.id)) continue;
    const prev = out[out.length - 1];
    if (b.t === 'text' && prev?.t === 'text') {
      const sep = prev.text && b.text ? '\n' : '';
      if (focus?.block === b) { focus.block = prev; focus.pos = focus.pos === 'end' ? 'end' : prev.text.length + sep.length + focus.pos; }
      prev.text += sep + b.text;
      continue;
    }
    out.push(b);
  }
  const res = out.filter((b, i) => b.t !== 'text' || b.text || i === out.length - 1 || focus?.block === b);
  if (!res.length || res[res.length - 1].t !== 'text') res.push({ t: 'text', text: '' });
  return res;
}
const copyBlocks = (bl) => (bl || []).map((b) => ({ ...b }));

function noteTasks(n) { return live('tasks').filter((t) => t.noteId === n.id); }
function noteTitle(n) {
  if (n.title.trim()) return n.title.trim();
  for (const b of n.blocks) {
    if (b.t === 'text' && b.text.trim()) return b.text.trim().split('\n')[0].slice(0, 80);
    if (b.t === 'task') { const t = liveById('tasks', b.id); if (t?.title.trim()) return t.title.trim(); }
  }
  return 'Новая тема';
}
function noteText(n) {
  return n.blocks.map((b) => {
    if (b.t === 'text') return b.text;
    if (b.t === 'task') { const t = liveById('tasks', b.id); return t ? (t.done ? '☑ ' : '☐ ') + t.title : ''; }
    const f = liveById('files', b.id);
    return f ? '📎 ' + f.name : '';
  }).filter(Boolean).join('\n');
}
function notePreview(n) {
  const lines = noteText(n).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!n.title.trim()) lines.shift();
  return lines.join(' · ').slice(0, 160);
}
function noteStats(n) {
  const ts = noteTasks(n);
  return { open: ts.filter((t) => !t.done).length, total: ts.length, files: n.blocks.filter((b) => b.t === 'file' && liveById('files', b.id)).length };
}

// Тема «Дела» в папке — сюда попадают дела, добавленные в папку без темы
function defaultTopic(folderId) {
  let n = live('notes').find((x) => x.folder === folderId && x.title === 'Дела');
  if (!n) { n = newNote({ folder: folderId, title: 'Дела' }); upsert('notes', n); }
  return n;
}
function detachTask(t) {
  const n = t.noteId && byId('notes', t.noteId);
  if (!n) return;
  const blocks = n.blocks.filter((b) => !(b.t === 'task' && b.id === t.id));
  if (blocks.length !== n.blocks.length) upsert('notes', { ...n, blocks: normalize(copyBlocks(blocks)) });
}
function attachTask(id, folderId, noteId) {
  const t = byId('tasks', id);
  if (!t) return;
  detachTask(t);
  if (!folderId && !noteId) { patch('tasks', id, { noteId: '', folder: '' }); return; }
  const n = (noteId && liveById('notes', noteId)) || defaultTopic(folderId);
  const blocks = copyBlocks(n.blocks);
  const last = blocks[blocks.length - 1];
  blocks.splice(last?.t === 'text' && !last.text ? blocks.length - 1 : blocks.length, 0, { t: 'task', id });
  patch('tasks', id, { noteId: n.id, folder: n.folder });
  upsert('notes', { ...n, blocks: normalize(blocks) });
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
const inboxTasks = () => live('tasks').filter((t) => !t.done && !t.date && !t.noteId && !liveFolder(t.folder)).sort(sortOpen);
const inboxCount = () => inboxNotes().length + inboxTasks().length;

function when(ts) {
  const d = new Date(ts), s = ymd(d);
  if (s === ymd()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return dateShort(s);
}

/* ---------------- Синхронизация с Google Таблицей ---------------- */

const FIELDS = {
  folders: { s: ['id', 'name', 'icon', 'color', 'image'], n: ['order', 'updatedAt'], b: ['deleted'] },
  notes: { s: ['id', 'folder', 'title'], n: ['createdAt', 'updatedAt'], b: ['pinned', 'deleted'] },
  tasks: { s: ['id', 'title', 'noteId', 'folder', 'date', 'remind', 'note'], n: ['order', 'doneAt', 'createdAt', 'updatedAt'], b: ['done', 'deleted'] },
  files: { s: ['id', 'noteId', 'name', 'mime', 'driveId'], n: ['size', 'createdAt', 'updatedAt'], b: ['deleted'] },
};

function norm(k, r) {
  const f = FIELDS[k], o = {};
  f.s.forEach((x) => (o[x] = r[x] == null ? '' : String(r[x])));
  f.n.forEach((x) => { const n = Number(r[x]); o[x] = isFinite(n) ? n : 0; });
  f.b.forEach((x) => (o[x] = r[x] === true || String(r[x]).toUpperCase() === 'TRUE'));
  if (k === 'notes') {
    let bl = r.blocks;
    if (typeof bl === 'string') { try { bl = JSON.parse(bl); } catch (e) { bl = null; } }
    o.blocks = Array.isArray(bl) && bl.length ? bl : [{ t: 'text', text: String(r.body ?? r.text ?? '') }];
  }
  return o;
}
// Строка для таблицы: технические поля + читаемые названия
function outRow(k, e) {
  const o = norm(k, e);
  if (k === 'notes') { o.blocks = JSON.stringify(e.blocks); o.text = noteText(e); }
  if (k === 'notes' || k === 'tasks') o.folderName = liveFolder(e.folder)?.name || 'Входящие';
  if (k === 'tasks' || k === 'files') { const n = byId('notes', e.noteId); o.noteTitle = n ? noteTitle(n) : ''; }
  return o;
}
function prefs() {
  const s = state.settings;
  return { digest: s.digestOn ? s.digest : '', evening: s.eveningOn ? s.evening : '' };
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

async function api(action, extra = {}) {
  const s = state.settings;
  if (!s.syncUrl) throw new Error('Сначала подключи Google-таблицу');
  let r;
  try {
    r = await fetch(s.syncUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: s.syncSecret, action, ...extra }),
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
      const data = await api('sync', { changes: {}, prefs: prefs() });
      if (KINDS.some((k) => (data[k] || []).length)) {
        for (const k of KINDS) state[k] = (data[k] || []).map((r) => norm(k, r)).filter((e) => e.id);
      } else {
        const { changes, sent } = collectChanges();
        mergeRemote(await api('sync', { changes, prefs: prefs() }));
        clearDirty(sent);
      }
    } else {
      const { changes, sent } = collectChanges();
      const data = await api('sync', { changes, prefs: prefs() });
      clearDirty(sent);
      mergeRemote(data);
    }
    s.lastSync = Date.now();
    save();
    setSync('ok');
    if (!ui.sheets.length) render();
    await uploadFiles();
    if (manual) toast('Синхронизировано ✓');
  } catch (e) {
    setSync('error', e.message);
    if (manual) toast(e.message);
  } finally {
    syncBusy = false;
  }
}

// Файлы, которые ещё не лежат в Google Диске, выгружаем по одному
async function uploadFiles() {
  for (const f of live('files')) {
    if (f.driveId) continue;
    const rec = await Store.getFile(f.id);
    if (!rec) continue;
    const res = await api('upload', { name: f.name, mime: f.mime, data: await bufToB64(rec.buf) });
    patch('files', f.id, { driveId: res.driveId });
  }
}

/* ---------------- Файлы ---------------- */

const fileCache = new Map(); // id → { url, file }

async function loadFile(id) {
  if (fileCache.has(id)) return fileCache.get(id);
  const f = byId('files', id);
  if (!f) return null;
  let rec = await Store.getFile(id);
  if (!rec && f.driveId && state.settings.syncUrl) {
    try {
      const d = await api('download', { driveId: f.driveId });
      rec = { buf: b64ToBuf(d.data), type: f.mime };
      await Store.putFile(id, rec);
    } catch (e) { return null; }
  }
  if (!rec) return null;
  const file = new File([rec.buf], f.name, { type: f.mime || rec.type });
  const entry = { url: URL.createObjectURL(file), file };
  fileCache.set(id, entry);
  return entry;
}

function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { res(img); URL.revokeObjectURL(url); };
    img.onerror = () => { rej(new Error('image')); URL.revokeObjectURL(url); };
    img.src = url;
  });
}
// Большие фото ужимаем до 2400 px, чтобы не забивать телефон и Диск
async function prepareFile(file) {
  const mime = file.type || 'application/octet-stream';
  if (/^image\/(jpeg|png|heic|heif|webp)$/.test(mime) && file.size > 1.5e6) {
    try {
      const img = await loadImage(file);
      const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (blob) return { blob, name: (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg' };
    } catch (e) { /* оставляем как есть */ }
  }
  return { blob: file, name: file.name || 'file', mime };
}
function pickFiles(accept, multiple, onPick) {
  const inp = document.createElement('input');
  inp.type = 'file';
  if (accept) inp.accept = accept;
  inp.multiple = multiple;
  inp.onchange = () => { if (inp.files?.length) onPick([...inp.files]); };
  inp.click();
}

function openViewer(id) {
  const f = byId('files', id), c = fileCache.get(id);
  if (!f || !c) { toast('Файл ещё загружается…'); loadFile(id); return; }
  if (!f.mime.startsWith('image/')) { shareFile(c.file, c.url); return; }
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<img src="${c.url}" alt=""><div class="viewer-bar"><button data-act="viewer-share" data-fid="${id}">Поделиться</button><button data-act="viewer-close">Закрыть</button></div>`;
  document.body.append(v);
  requestAnimationFrame(() => v.classList.add('show'));
}
function shareFile(file, url) {
  if (navigator.canShare?.({ files: [file] })) { navigator.share({ files: [file] }).catch(() => {}); return; }
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.target = '_blank';
  document.body.append(a); a.click(); a.remove();
}

/* ---------------- Листы (модальные окна) ---------------- */

function openSheet({ title, left = 'Отмена', right = '', onRight, actions = {}, onInput, refresh, onClose, tall, cls = '' }) {
  const root = $('#sheet-root');
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  const sh = document.createElement('div');
  sh.className = 'sheet' + (tall ? ' tall' : '') + (cls ? ' ' + cls : '');
  sh.setAttribute('role', 'dialog');
  sh.innerHTML = `<div class="sheet-head"><button data-act="sheet-close">${left}</button><h2>${esc(title)}</h2><button data-act="sheet-right">${right}</button></div><div class="sheet-body"></div>`;
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
  toastTimer = setTimeout(() => { t.classList.remove('show'); toastUndo = null; }, undo ? 4000 : 2400);
}

function autoGrow(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

/* ---------------- Строки списков ---------------- */

function taskTag(t) {
  const f = liveFolder(t.folder);
  const n = liveById('notes', t.noteId);
  const topic = n && n.title !== 'Дела' ? noteTitle(n) : '';
  if (!f && !topic) return '';
  const ico = f ? (f.image ? `<img src="${esc(f.image)}" alt="">` : folderIcon(f)) : icon('memo');
  return `<span class="tag" style="${fc(f)}">${ico}${esc([f?.name, topic].filter(Boolean).join(' · '))}</span>`;
}

// opts: showTag, showDate
function taskRow(t, opts = {}) {
  const today = ymd();
  const meta = [];
  if (opts.showDate && t.date) meta.push(`<span class="${!t.done && t.date < today ? 'late' : ''}">${esc(dateShort(t.date))}</span>`);
  if (t.remind && t.date) meta.push(`<span class="has-note">${icon('bell')} ${esc(t.remind)}</span>`);
  if (opts.showTag !== false) meta.push(taskTag(t));
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

function addRow(placeholder, { date = '', key }) {
  return `<label class="add-row"><span class="plus">${icon('plus')}</span>
    <input data-add="${key}" data-date="${date}" placeholder="${esc(placeholder)}" enterkeyhint="done" autocomplete="off"></label>`;
}

function noteRow(n, opts = {}) {
  const st = noteStats(n);
  const prev = notePreview(n);
  const side = [
    st.total ? `<span class="n-stat${st.open ? '' : ' ok'}">${icon('check')}${st.total - st.open}/${st.total}</span>` : '',
    st.files ? `<span class="n-stat">${icon('clip')}${st.files}</span>` : '',
  ].join('');
  return `<button class="note-row" data-act="note" data-id="${n.id}">
    <div class="n-main">
      <div class="n-title">${esc(noteTitle(n))}</div>
      <div class="n-prev"><b>${esc(when(n.updatedAt))}</b>${esc(prev) || 'Пусто'}</div>
      ${opts.showFolder ? taskTag({ folder: n.folder, noteId: '' }) : ''}
    </div>
    ${side ? `<div class="n-side">${side}</div>` : ''}
  </button>`;
}

function calGrid(month, sel, act, stats = dayStats()) {
  const today = ymd();
  let d = weekStart(month + '-01');
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
  const anim = ui.weekAnim ? (ui.weekAnim > 0 ? ' in-next' : ' in-prev') : '';
  ui.weekAnim = 0;
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
    <div class="week-clip"><div class="week${anim}">${week}</div></div>
    <button class="arrow" data-act="day-shift" data-n="1" aria-label="Следующий день">${icon('chevR')}</button>
  </div>

  ${late.length ? `
    <div class="section-title late-head"><span>Не сделано раньше · ${late.length}</span><button data-act="late-today">Всё на сегодня</button></div>
    <div class="tasks">${late.map((t) => taskRow(t, { showDate: true })).join('')}</div>` : ''}

  ${total ? `<div class="progress-line"><span>${done.length} из ${total} ${plural(total, ['дела', 'дел', 'дел'])}</span><span class="bar"><i style="width:${Math.round(done.length / total * 100)}%"></i></span></div>`
    : `<div class="section-title"><span>Дела</span></div>`}
  <div class="tasks">
    ${open.map((t) => taskRow(t)).join('')}
    ${addRow(d === today ? 'Что сделать сегодня?' : 'Добавить дело', { date: d, key: 'day' })}
    ${done.map((t) => taskRow(t)).join('')}
  </div>
  <div class="hint" style="text-align:center;margin-top:14px">Смахни неделю влево или вправо, дело — вправо, чтобы перенести</div>`;
}

// Папки стоят в ячейках сетки 3×N; order — номер ячейки, пустые ячейки допустимы
const COLS = 3;
function placeFolders() {
  const used = new Set();
  let changed = false;
  for (const f of folders()) {
    let s = Math.max(0, Math.floor(f.order || 0));
    while (used.has(s)) s++;
    used.add(s);
    if (s !== f.order) { f.order = s; f._dirty = true; f.updatedAt = Date.now(); changed = true; }
  }
  if (changed) { save(); scheduleSync(); }
  return folders();
}
function freeSlot() {
  const used = new Set(folders().map((f) => f.order));
  let s = 0;
  while (used.has(s)) s++;
  return s;
}
function moveFolderToSlot(id, slot) {
  const f = byId('folders', id);
  if (!f || f.order === slot) return;
  const other = folders().find((x) => x.order === slot && x.id !== id);
  if (other) patch('folders', other.id, { order: f.order });
  patch('folders', id, { order: slot });
}

function viewFolders() {
  if (ui.folder && liveFolder(ui.folder)) return viewFolder(liveFolder(ui.folder));
  ui.folder = '';
  const list = placeFolders();
  const today = ymd();
  const bySlot = {};
  list.forEach((f) => (bySlot[f.order] = f));
  const maxSlot = list.reduce((m, f) => Math.max(m, f.order), -1);
  let total = Math.max(COLS, Math.ceil((maxSlot + 1) / COLS) * COLS);
  if (ui.arrange) total = Math.max(total + COLS, 18);
  const due = {};
  for (const t of live('tasks')) if (!t.done && t.date && t.date <= today && t.folder) due[t.folder] = (due[t.folder] || 0) + 1;
  let cells = '';
  for (let i = 0; i < total; i++) {
    const f = bySlot[i];
    if (f) {
      cells += `<div class="slot" data-slot="${i}"><button class="tile" data-id="${f.id}" data-act="${ui.arrange ? 'folder-edit' : 'folder'}" style="${fc(f)}">
        <span class="t-ico${f.image ? ' img' : ''}">${folderIcon(f)}</span><span class="t-name">${esc(f.name)}</span>
        ${due[f.id] && !ui.arrange ? `<i class="t-badge">${due[f.id]}</i>` : ''}</button></div>`;
    } else {
      cells += `<div class="slot empty" data-slot="${i}"${ui.arrange ? ` data-act="slot-new" data-slot-n="${i}"` : ''}>${ui.arrange ? '<span class="slot-plus">+</span>' : ''}</div>`;
    }
  }
  const inbox = inboxCount();
  return `
  <div class="topbar"><div><h1>Папки</h1></div>
    <div class="top-actions">
      ${ui.arrange ? '<button class="pill-btn" data-act="arrange-done">Готово</button>'
        : `<button class="pill-btn" data-act="arrange">Изменить</button><button class="icon-btn" data-act="settings" aria-label="Настройки">${icon('gear')}</button>`}
    </div></div>
  ${ui.arrange ? '<div class="hint" style="margin:-6px 4px 12px">Перетащи папку в любую ячейку. Нажми на папку, чтобы переименовать, на «+» — чтобы создать.</div>' : ''}
  <div class="fgrid${ui.arrange ? ' arranging' : ''}">${cells}</div>
  ${inbox && !ui.arrange ? `<div class="section-title"><span>Не разложено</span></div>
    <div class="card"><button class="note-row" data-act="tab" data-tab="inbox"><div class="n-main"><div class="n-title">Входящие · ${inbox}</div><div class="n-prev">Темы и дела без папки</div></div></button></div>` : ''}
  ${!ui.arrange ? '<div class="hint" style="text-align:center;margin-top:18px">Удерживай папку, чтобы переставить</div>' : ''}`;
}

function viewFolder(f) {
  const notes = live('notes').filter((n) => n.folder === f.id).sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt);
  return `
  <button class="back" data-act="folders-back">${icon('chevL')}Папки</button>
  <div class="topbar">
    <div class="folder-head" style="${fc(f)}"><span class="f-ico${f.image ? ' img' : ''}">${folderIcon(f)}</span><h1>${esc(f.name)}</h1></div>
    <div class="top-actions"><button class="icon-btn" data-act="folder-edit" data-id="${f.id}" aria-label="Изменить папку">${icon('edit')}</button></div>
  </div>
  <div class="sub-count">${notes.length} ${plural(notes.length, ['тема', 'темы', 'тем'])}</div>
  ${notes.length ? `<div class="card">${notes.map((n) => noteRow(n)).join('')}</div>`
    : `<div class="empty">Тем пока нет.<br>Нажми <b>+</b>, чтобы создать первую.</div>`}`;
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
    ${open.map((t) => taskRow(t)).join('')}
    ${addRow('Добавить дело', { date: d, key: 'cal' })}
    ${done.map((t) => taskRow(t)).join('')}
  </div>`;
}

function viewInbox() {
  const notes = inboxNotes(), tasks = inboxTasks();
  return `
  <div class="topbar"><div><h1>Входящие</h1><div class="sub">Всё, что добавлено без папки</div></div></div>
  <div class="card info-card"><div>Скоро здесь заработает <b>автосортировка</b>: новые записи будут сами раскладываться по папкам. Пока — открой тему и выбери папку через <b>•••</b>.</div></div>
  <div class="section-title"><span>Темы</span><button data-act="note-new" data-folder="">+ Тема</button></div>
  ${notes.length ? `<div class="card">${notes.map((n) => noteRow(n)).join('')}</div>` : '<div class="empty">Пусто — всё разложено</div>'}
  <div class="section-title"><span>Дела без даты</span></div>
  <div class="tasks">
    ${addRow('Быстрое дело', { key: 'inbox' })}
    ${tasks.map((t) => taskRow(t)).join('')}
  </div>`;
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

/* ---------------- Выбор даты (и времени напоминания) ---------------- */

function openDatePicker({ title = 'Перенести на', current = '', time = '', withTime = false, allowNone = true, onPick }) {
  const today = ymd();
  const quick = [
    ['Сегодня', today], ['Завтра', addDays(today, 1)],
    ['Послезавтра', addDays(today, 2)], ['В понедельник', nextMonday(today)],
    ['Через неделю', addDays(today, 7)],
  ];
  if (allowNone) quick.push(['Без даты', '']);
  const timeVal = () => (withTime ? $('#dp-time', entry.body)?.value || '' : time);
  const entry = openSheet({
    title,
    right: withTime ? 'Готово' : '',
    onRight: () => { const t = timeVal(); closeSheet(); onPick(current || (t ? today : ''), t); },
    refresh: (e) => {
      e.m ||= (current || today).slice(0, 7);
      const keepTime = $('#dp-time', e.body)?.value ?? time;
      e.body.innerHTML = `
      ${withTime ? `<div class="remind-row">${icon('bell')}<span>Напомнить в</span><input type="time" id="dp-time" value="${esc(keepTime)}"><button data-act="dp-notime">Без времени</button></div>` : ''}
      <div class="quick-dates">${quick.map(([l, d]) => `<button class="${d === current ? 'on' : ''}" data-act="pick" data-d="${d}">${l}<small>${d ? dayMonth(d) : ''}</small></button>`).join('')}</div>
      <div class="month-switch" style="margin-top:14px">
        <button data-act="m" data-n="-1">${icon('chevL')}</button><span>${monthLabel(e.m)}</span><button data-act="m" data-n="1">${icon('chevR')}</button>
      </div>
      <div class="card" style="margin-top:10px">${calGrid(e.m, current, 'pick')}</div>`;
    },
    actions: {
      pick: (el) => { const t = timeVal(); closeSheet(); onPick(el.dataset.d, el.dataset.d ? t : ''); },
      m: (el) => { entry.m = shiftMonth(entry.m, Number(el.dataset.n)); refreshTopSheet(); },
      'dp-notime': () => { $('#dp-time', entry.body).value = ''; },
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

function folderChips(sel, act, noneLabel) {
  return `<div class="chips">
    <button class="chip${!liveFolder(sel) ? ' on' : ''}" data-act="${act}" data-id="">${icon('inbox')}${noneLabel}</button>
    ${folders().map((f) => `<button class="chip${sel === f.id ? ' on' : ''}" style="${fc(f)}" data-act="${act}" data-id="${f.id}">${f.image ? `<img src="${esc(f.image)}" alt="">` : folderIcon(f)}${esc(f.name)}</button>`).join('')}
  </div>`;
}

function openCapture() {
  const c = { kind: 'task', date: '', folder: '', noteId: '' };
  if (ui.tab === 'today') c.date = ui.day;
  if (ui.tab === 'calendar') c.date = ui.calDay;
  const today = ymd();

  const paintOpts = (e) => {
    const dates = [['Сегодня', today], ['Завтра', addDays(today, 1)], ['Без даты', '']];
    const custom = c.date && !dates.some(([, d]) => d === c.date);
    const topics = c.folder ? live('notes').filter((n) => n.folder === c.folder && n.title !== 'Дела').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8) : [];
    $('.opts', e.body).innerHTML = `
      <div class="field-label" style="margin-top:12px">Тип</div>
      <div class="seg"><button class="${c.kind === 'task' ? 'on' : ''}" data-act="kind" data-k="task">Дело</button><button class="${c.kind === 'note' ? 'on' : ''}" data-act="kind" data-k="note">Тема</button></div>
      ${c.kind === 'task' ? `
      <div class="field-label">Когда</div>
      <div class="chips">
        ${dates.map(([l, d]) => `<button class="chip${c.date === d ? ' on' : ''}" data-act="date" data-d="${d}">${l}</button>`).join('')}
        <button class="chip${custom ? ' on' : ''}" data-act="date-pick">${icon('cal')}${custom ? esc(dateShort(c.date)) : 'Дата…'}</button>
      </div>` : ''}
      <div class="field-label">Папка</div>
      ${folderChips(c.folder, 'folder-pick', c.kind === 'task' ? 'Без папки' : 'Входящие')}
      ${c.kind === 'task' && c.folder ? `
      <div class="field-label">В тему</div>
      <div class="chips">
        <button class="chip${!c.noteId ? ' on' : ''}" data-act="topic-pick" data-id="">${icon('checklist')}Дела</button>
        ${topics.map((n) => `<button class="chip${c.noteId === n.id ? ' on' : ''}" data-act="topic-pick" data-id="${n.id}">${esc(noteTitle(n).slice(0, 40))}</button>`).join('')}
      </div>` : ''}
      <button class="btn" data-act="save">Добавить</button>`;
  };

  const submit = () => {
    const text = $('.capture', entry.body).value.trim();
    if (!text) { toast('Напиши текст'); return; }
    if (c.kind === 'task') {
      // Несколько строк — несколько дел
      const lines = text.split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
      lines.forEach((title, i) => {
        const t = newTask({ title, date: c.date, order: Date.now() + i });
        if (c.folder) attachTask(t.id, c.folder, c.noteId);
      });
      closeSheet();
      toast(lines.length > 1 ? `Добавлено ${lines.length} ${plural(lines.length, ['дело', 'дела', 'дел'])}` : 'Дело добавлено');
    } else {
      const [first, ...rest] = text.split('\n');
      const n = newNote({ folder: c.folder, title: first.trim().slice(0, 120), blocks: normalize([{ t: 'text', text: rest.join('\n').trim() }]) });
      upsert('notes', n);
      closeSheet();
      toast(c.folder ? `Тема в «${liveFolder(c.folder).name}»` : 'Тема во «Входящих»');
    }
  };

  const entry = openSheet({
    title: 'Новая запись',
    right: 'Добавить',
    onRight: submit,
    refresh: (e) => {
      if (!$('.capture', e.body)) e.body.innerHTML = `<textarea class="textarea capture" rows="3" placeholder="Что нужно сделать или запомнить?"></textarea><div class="opts"></div>`;
      paintOpts(e);
    },
    actions: {
      kind: (el) => { c.kind = el.dataset.k; paintOpts(entry); },
      date: (el) => { c.date = el.dataset.d; paintOpts(entry); },
      'date-pick': () => openDatePicker({ title: 'Дата', current: c.date, onPick: (d) => { c.date = d; paintOpts(entry); } }),
      'folder-pick': (el) => { c.folder = el.dataset.id; c.noteId = ''; paintOpts(entry); },
      'topic-pick': (el) => { c.noteId = el.dataset.id; paintOpts(entry); },
      save: submit,
    },
    onInput: (e) => { if (e.target.matches('.capture')) autoGrow(e.target); },
  });
  setTimeout(() => $('.capture', entry.body)?.focus(), 50);
}

/* ---------------- Дело ---------------- */

function openTask(id) {
  if (!byId('tasks', id)) return;
  let timer;
  const cur = () => byId('tasks', id);
  const flush = () => {
    clearTimeout(timer);
    const title = $('.t-edit', entry.body)?.value.replace(/\n/g, ' ').trim() ?? '';
    const note = $('.t-note', entry.body)?.value ?? '';
    const t = cur();
    if (t && !t.deleted && (t.title !== title || t.note !== note)) patch('tasks', id, { title: title || t.title, note });
  };
  const paintOpts = (e) => {
    const t = cur();
    if (!t) return;
    const today = ymd();
    const dates = [['Сегодня', today], ['Завтра', addDays(today, 1)], ['Без даты', '']];
    const custom = t.date && !dates.some(([, d]) => d === t.date);
    const n = liveById('notes', t.noteId);
    $('.opts', e.body).innerHTML = `
      <div class="field-label">Когда</div>
      <div class="chips">
        ${dates.map(([l, d]) => `<button class="chip${t.date === d ? ' on' : ''}" data-act="date" data-d="${d}">${l}</button>`).join('')}
        <button class="chip${custom ? ' on' : ''}" data-act="date-pick">${icon('cal')}${custom ? esc(dateShort(t.date)) : 'Дата…'}</button>
      </div>
      ${t.date ? `<div class="remind-row" style="margin-top:10px">${icon('bell')}<span>Напомнить в</span><input type="time" class="t-remind" value="${esc(t.remind)}">${t.remind ? '<button data-act="remind-clear">Убрать</button>' : ''}</div>` : ''}
      <div class="field-label">Папка</div>
      ${folderChips(t.folder, 'folder-pick', 'Без папки')}
      ${n ? `<button class="btn secondary small" data-act="open-topic" style="margin-top:14px">Открыть тему «${esc(noteTitle(n).slice(0, 40))}»</button>` : ''}
      <button class="btn${t.done ? ' secondary' : ''}" data-act="done">${t.done ? 'Вернуть в работу' : 'Готово ✓'}</button>
      <button class="btn danger small" data-act="del">Удалить дело</button>`;
  };
  const entry = openSheet({
    title: 'Дело',
    left: 'Закрыть',
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
      if (e.target.matches('.t-remind')) {
        if (e.type === 'change') { patch('tasks', id, { remind: e.target.value }); paintOpts(entry); }
        return;
      }
      if (e.target.tagName !== 'TEXTAREA') return;
      autoGrow(e.target);
      clearTimeout(timer);
      timer = setTimeout(flush, 600);
    },
    onClose: flush,
    actions: {
      date: (el) => { flush(); patch('tasks', id, { date: el.dataset.d, remind: el.dataset.d ? cur().remind : '' }); paintOpts(entry); },
      'date-pick': () => { flush(); openDatePicker({ title: 'Дата', current: cur().date, time: cur().remind, withTime: true, onPick: (d, tm) => { patch('tasks', id, { date: d, remind: tm }); paintOpts(entry); } }); },
      'remind-clear': () => { patch('tasks', id, { remind: '' }); paintOpts(entry); },
      'folder-pick': (el) => { flush(); attachTask(id, el.dataset.id, ''); paintOpts(entry); },
      'open-topic': () => { const nid = cur().noteId; flush(); closeSheet(); openNote(nid); },
      done: () => { flush(); toggleTask(id); closeSheet(); },
      del: () => {
        flush();
        deleteTask(id);
        closeSheet();
      },
    },
  });
}

function deleteTask(id) {
  const t = byId('tasks', id);
  if (!t) return;
  const n = liveById('notes', t.noteId);
  const pos = n ? n.blocks.findIndex((b) => b.t === 'task' && b.id === id) : -1;
  patch('tasks', id, { deleted: true });
  if (n) upsert('notes', { ...n, blocks: normalize(copyBlocks(n.blocks)) });
  toast('Дело удалено', () => {
    patch('tasks', id, { deleted: false });
    const cur = liveById('notes', t.noteId);
    if (cur && pos >= 0) { const bl = copyBlocks(cur.blocks); bl.splice(Math.min(pos, bl.length), 0, { t: 'task', id }); upsert('notes', { ...cur, blocks: normalize(bl) }); }
    render();
  });
}

function toggleTask(id, rowEl) {
  const t = byId('tasks', id);
  if (!t) return;
  const done = !t.done;
  patch('tasks', id, { done, doneAt: done ? Date.now() : 0 });
  if (navigator.vibrate) navigator.vibrate(10);
  if (rowEl) {
    rowEl.classList.toggle('done', done);
    clearTimeout(toggleTask.timer);
    toggleTask.timer = setTimeout(render, 550);
  } else render();
}

/* ---------------- Тема: редактор как в iOS Заметках ---------------- */

function openNote(id, folder = '') {
  const existing = id && liveById('notes', id);
  if (id && !existing) return;
  let note = existing ? { ...existing } : newNote({ folder });
  let blocks = normalize(copyBlocks(note.blocks));
  let saved = !!existing, timer = null, lastFocus = null;
  let ctx = null; // лист редактора (доступен уже во время его построения)
  const pending = {}; // id дела → название, пока печатают

  const titleEl = () => $('.note-title', ctx.body);
  const isEmpty = () => !titleEl().value.trim() && blocks.every((b) => b.t === 'text' && !b.text.trim());

  function saveNote(force) {
    clearTimeout(timer);
    for (const [tid, title] of Object.entries(pending)) {
      const t = byId('tasks', tid);
      if (t && t.title !== title) patch('tasks', tid, { title });
      delete pending[tid];
    }
    if (!saved && isEmpty() && !force) return;
    const title = titleEl().value;
    const nb = normalize(copyBlocks(blocks));
    const cur = byId('notes', note.id);
    if (cur && !cur.deleted && cur.title === title && cur.folder === note.folder && JSON.stringify(cur.blocks) === JSON.stringify(nb)) return;
    note = { ...(cur || note), title, blocks: nb, folder: note.folder, deleted: false };
    upsert('notes', note);
    saved = true;
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(() => saveNote(), 600); };

  function blockHtml(b, i) {
    if (b.t === 'text') {
      const ph = blocks.length === 1 ? 'Текст, чек-листы, файлы…' : '';
      return `<textarea class="b-text" data-i="${i}" rows="1" placeholder="${ph}">${esc(b.text)}</textarea>`;
    }
    if (b.t === 'task') {
      const t = liveById('tasks', b.id);
      if (!t) return `<div data-i="${i}" hidden></div>`;
      const late = !t.done && t.date && t.date < ymd();
      return `<div class="b-task${t.done ? ' done' : ''}" data-i="${i}">
        <button class="check" data-act="b-toggle" data-i="${i}" aria-label="Готово">${icon('check')}</button>
        <textarea class="b-ttl" data-i="${i}" rows="1" enterkeyhint="next">${esc(pending[t.id] ?? t.title)}</textarea>
        <button class="b-date${t.date ? ' set' : ''}${late ? ' late' : ''}" data-act="b-date" data-i="${i}" aria-label="Дата">${t.date ? esc(dateShort(t.date)) + (t.remind ? ' · ' + esc(t.remind) : '') : icon('cal')}</button>
      </div>`;
    }
    const f = liveById('files', b.id);
    if (!f) return `<div data-i="${i}" hidden></div>`;
    const img = f.mime.startsWith('image/');
    return `<div class="b-file${img ? ' is-img' : ''}" data-i="${i}">
      <button class="f-open" data-act="f-open" data-fid="${f.id}">
        ${img ? `<span class="f-thumb" data-fid="${f.id}"></span>` : `<span class="f-icon">${icon('file')}</span><span class="f-meta"><b>${esc(f.name)}</b><small>${fmtSize(f.size)}</small></span>`}
      </button>
      <button class="f-del" data-act="f-del" data-i="${i}" aria-label="Удалить файл">${icon('x')}</button>
    </div>`;
  }

  function renderBlocks() {
    const wrap = $('.blocks', ctx.body);
    wrap.innerHTML = blocks.map(blockHtml).join('');
    wrap.querySelectorAll('textarea').forEach(autoGrow);
    wrap.querySelectorAll('.b-file').forEach((el) => {
      const fid = $('.f-open', el).dataset.fid;
      loadFile(fid).then((c) => {
        const th = $('.f-thumb', el);
        if (!th) return;
        th.innerHTML = c ? `<img src="${c.url}" alt="">` : '<span class="f-wait">Файл ещё не выгружен с другого устройства</span>';
      });
    });
  }

  function focusAt(block, pos) {
    const i = blocks.indexOf(block);
    if (i < 0) return;
    const el = $(`.blocks [data-i="${i}"]`, ctx.body);
    const ta = el?.matches('textarea') ? el : el?.querySelector('textarea');
    if (!ta) return;
    const p = pos === 'end' ? ta.value.length : Math.min(pos, ta.value.length);
    ta.focus();
    ta.setSelectionRange(p, p);
    lastFocus = { i, pos: p };
  }
  function restructure(focus) {
    blocks = normalize(blocks, focus);
    renderBlocks();
    if (focus) focusAt(focus.block, focus.pos);
    saveNote(true);
  }
  function makeTask(title) {
    saveNote(true);
    return newTask({ title, noteId: note.id, folder: note.folder });
  }
  function dropTask(tid) {
    delete pending[tid];
    patch('tasks', tid, { deleted: true });
  }
  const titleOf = (b) => pending[b.id] ?? byId('tasks', b.id)?.title ?? '';
  const prevEditable = (i) => { for (let j = i - 1; j >= 0; j--) if (blocks[j].t !== 'file') return blocks[j]; return null; };

  // Enter в пункте списка: новый пункт; на пустом — выход из списка
  function enterInTask(i, el) {
    const b = blocks[i];
    const v = el.value, c = el.selectionStart;
    if (!v.trim()) {
      dropTask(b.id);
      const nb = { t: 'text', text: '' };
      blocks.splice(i, 1, nb);
      restructure({ block: nb, pos: 0 });
      return;
    }
    if (c === 0) {
      const t = makeTask('');
      blocks.splice(i, 0, { t: 'task', id: t.id });
      restructure({ block: b, pos: 0 });
      return;
    }
    pending[b.id] = v.slice(0, c).trimEnd();
    const t = makeTask(v.slice(c).trimStart());
    const nb = { t: 'task', id: t.id };
    blocks.splice(i + 1, 0, nb);
    restructure({ block: nb, pos: 0 });
  }
  function backspaceAtStart(i, el) {
    const b = blocks[i];
    if (b.t === 'task') {
      const v = el.value;
      dropTask(b.id);
      if (!v) {
        blocks.splice(i, 1);
        const prev = prevEditable(i);
        restructure(prev ? { block: prev, pos: 'end' } : null);
      } else {
        const nb = { t: 'text', text: v };
        blocks.splice(i, 1, nb);
        restructure({ block: nb, pos: 0 });
      }
      return true;
    }
    if (b.t === 'text' && i > 0) {
      const prev = prevEditable(i);
      if (!prev) return false;
      if (!el.value && i !== blocks.length - 1) blocks.splice(i, 1);
      restructure({ block: prev, pos: 'end' });
      return true;
    }
    return false;
  }

  // Кнопка «чек-лист»: строка под курсором ↔ пункт списка
  function toggleChecklist() {
    const lf = lastFocus && blocks[lastFocus.i] ? lastFocus : null;
    const b = lf && blocks[lf.i];
    if (b?.t === 'text') {
      const text = b.text, pos = Math.min(lf.pos, text.length);
      const ls = text.lastIndexOf('\n', pos - 1) + 1;
      let le = text.indexOf('\n', pos);
      if (le < 0) le = text.length;
      const t = makeTask(text.slice(ls, le).trim());
      const nb = { t: 'task', id: t.id };
      const parts = [];
      if (ls > 0) parts.push({ t: 'text', text: text.slice(0, ls - 1) });
      parts.push(nb);
      if (le < text.length) parts.push({ t: 'text', text: text.slice(le + 1) });
      blocks.splice(lf.i, 1, ...parts);
      restructure({ block: nb, pos: 'end' });
      return;
    }
    if (b?.t === 'task') {
      const v = titleOf(b);
      dropTask(b.id);
      const nb = { t: 'text', text: v };
      blocks.splice(lf.i, 1, nb);
      restructure({ block: nb, pos: 'end' });
      return;
    }
    const t = makeTask('');
    const nb = { t: 'task', id: t.id };
    const last = blocks[blocks.length - 1];
    blocks.splice(last.t === 'text' && !last.text ? blocks.length - 1 : blocks.length, 0, nb);
    restructure({ block: nb, pos: 0 });
  }

  async function addFiles(list) {
    saveNote(true);
    const lf = lastFocus && blocks[lastFocus.i] ? lastFocus : null;
    let idx;
    if (lf && blocks[lf.i].t === 'text') {
      const b = blocks[lf.i], p = Math.min(lf.pos, b.text.length);
      blocks.splice(lf.i, 1, { t: 'text', text: b.text.slice(0, p).replace(/\n$/, '') }, { t: 'text', text: b.text.slice(p).replace(/^\n/, '') });
      idx = lf.i + 1;
    } else if (lf) idx = lf.i + 1;
    else idx = blocks.length - 1;
    let added = 0;
    for (const file of list) {
      if (file.size > 25e6) { toast(`«${file.name}» больше 25 МБ`); continue; }
      const p = await prepareFile(file);
      const rec = { id: uid('a'), noteId: note.id, name: p.name, mime: p.mime, size: p.blob.size, driveId: '', createdAt: Date.now(), deleted: false };
      await Store.putFile(rec.id, { buf: await p.blob.arrayBuffer(), type: p.mime });
      upsert('files', rec);
      blocks.splice(idx++, 0, { t: 'file', id: rec.id });
      added++;
    }
    lastFocus = null;
    restructure(null);
    if (added && !state.settings.syncUrl) toast('Файл сохранён на телефоне. Чтобы он был и в облаке — подключи Google-таблицу');
  }

  const folderName = () => liveFolder(note.folder)?.name || 'Входящие';
  const entry = openSheet({
    title: '',
    left: `${svg(P.chevL)}<span class="back-label">${esc(folderName())}</span>`,
    right: svg(P.dots),
    tall: true,
    cls: 'editor',
    onRight: () => openNoteMenu(),
    refresh: (e) => {
      ctx = e;
      if ($('.blocks', e.body)) return;
      e.body.insertAdjacentHTML('beforebegin', `<div class="note-tools">
        <button data-act="tb-check">${icon('checklist')}<span>Чек-лист</span></button>
        <button data-act="tb-photo">${icon('photo')}<span>Фото</span></button>
        <button data-act="tb-file">${icon('clip')}<span>Файл</span></button>
        <button data-act="tb-kbd" class="kbd" aria-label="Скрыть клавиатуру">${icon('kbd')}</button>
      </div>`);
      e.body.innerHTML = `
        <input class="note-title" placeholder="Тема" value="${esc(note.title)}" enterkeyhint="next">
        <div class="blocks"></div>
        <div class="note-foot">${saved ? 'Изменено ' + esc(when(note.updatedAt || Date.now())) : ''}</div>`;
      renderBlocks();
    },
    onInput: (e) => {
      const el = e.target;
      if (e.type === 'change') return;
      if (el.matches('.b-text')) { blocks[+el.dataset.i].text = el.value; autoGrow(el); }
      else if (el.matches('.b-ttl')) { pending[blocks[+el.dataset.i].id] = el.value.replace(/\n/g, ' '); autoGrow(el); }
      else if (!el.matches('.note-title')) return;
      if (el.dataset.i != null) lastFocus = { i: +el.dataset.i, pos: el.selectionStart };
      later();
    },
    onClose: () => {
      document.removeEventListener('selectionchange', onSel);
      saveNote();
      const cur = liveById('notes', note.id);
      if (cur && isEmpty()) upsert('notes', { ...cur, deleted: true });
    },
    actions: {
      'tb-check': () => toggleChecklist(),
      'tb-photo': () => pickFiles('image/*', true, addFiles),
      'tb-file': () => pickFiles('', true, addFiles),
      'tb-kbd': () => document.activeElement?.blur?.(),
      'b-toggle': (el) => {
        const b = blocks[+el.dataset.i];
        toggleTask(b.id);
        el.closest('.b-task').classList.toggle('done', byId('tasks', b.id)?.done);
      },
      'b-date': (el) => {
        const b = blocks[+el.dataset.i];
        saveNote(true);
        const t = byId('tasks', b.id);
        openDatePicker({ title: 'Когда сделать', current: t.date, time: t.remind, withTime: true, onPick: (d, tm) => { patch('tasks', b.id, { date: d, remind: tm }); renderBlocks(); } });
      },
      'f-open': (el) => openViewer(el.dataset.fid),
      'f-del': (el) => {
        const i = +el.dataset.i, b = blocks[i];
        if (!confirm('Удалить файл из темы?')) return;
        patch('files', b.id, { deleted: true });
        Store.delFile(b.id);
        blocks.splice(i, 1);
        restructure(null);
      },
    },
  });

  // Запоминаем, где стоит курсор: туда вставляются чек-лист и файлы
  const onSel = () => {
    const a = document.activeElement;
    if (a?.dataset?.i != null && ctx.sh.contains(a)) lastFocus = { i: +a.dataset.i, pos: a.selectionStart };
  };
  document.addEventListener('selectionchange', onSel);

  ctx.sh.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.matches('.note-title') && e.key === 'Enter') { e.preventDefault(); focusAt(blocks[0], 0); return; }
    if (el.dataset.i == null) return;
    const i = +el.dataset.i;
    if (el.matches('.b-ttl') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enterInTask(i, el); return; }
    if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (backspaceAtStart(i, el)) e.preventDefault();
    }
  });
  // Запасной путь для клавиатур, которые не шлют keydown Enter
  ctx.sh.addEventListener('beforeinput', (e) => {
    const el = e.target;
    if (el.matches?.('.b-ttl') && (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph')) {
      e.preventDefault();
      enterInTask(+el.dataset.i, el);
    }
  });

  function openNoteMenu() {
    saveNote(true);
    openSheet({
      title: 'Тема',
      left: 'Закрыть',
      refresh: (m) => {
        m.body.innerHTML = `
          <div class="field-label" style="margin-top:6px">Папка</div>
          ${folderChips(note.folder, 'move', 'Входящие')}
          <button class="btn danger small" data-act="del" style="margin-top:24px">Удалить тему</button>
          <div class="hint">Вместе с темой удалятся её дела и файлы.</div>`;
      },
      actions: {
        move: (el) => {
          note.folder = el.dataset.id;
          saveNote(true);
          for (const t of noteTasks(note)) patch('tasks', t.id, { folder: note.folder });
          $('.back-label', ctx.sh).textContent = folderName();
          refreshTopSheet();
          toast(`Перенесено в «${folderName()}»`);
        },
        del: () => {
          const tids = noteTasks(note).map((t) => t.id);
          const fids = blocks.filter((b) => b.t === 'file').map((b) => b.id);
          for (const t of tids) patch('tasks', t, { deleted: true });
          for (const f of fids) patch('files', f, { deleted: true });
          const n = byId('notes', note.id);
          if (n) upsert('notes', { ...n, deleted: true });
          saved = false;
          titleEl().value = '';
          blocks = [{ t: 'text', text: '' }];
          closeSheet();
          closeSheet();
          toast('Тема удалена', () => {
            for (const t of tids) patch('tasks', t, { deleted: false });
            for (const f of fids) patch('files', f, { deleted: false });
            const c = byId('notes', note.id);
            if (c) upsert('notes', { ...c, deleted: false });
            render();
          });
        },
      },
    });
  }

  if (!existing) setTimeout(() => titleEl()?.focus(), 60);
}

/* ---------------- Папка: создание и настройка ---------------- */

async function imageToIcon(file) {
  const img = await loadImage(file);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 128, 128);
  let url = c.toDataURL('image/png');
  if (url.length > 45000) url = c.toDataURL('image/jpeg', 0.85);
  return url;
}

function openFolderEdit(id, slot) {
  const f = id ? { ...byId('folders', id) } : { id: uid('f'), name: '', icon: 'folder', image: '', color: COLORS[folders().length % COLORS.length], order: slot ?? freeSlot(), deleted: false };
  const commit = () => {
    const name = $('#f-name', entry.body).value.trim();
    if (!name) { toast('Назови папку'); return; }
    upsert('folders', { ...f, name });
    closeSheet();
  };
  const entry = openSheet({
    title: id ? 'Папка' : 'Новая папка',
    right: 'Готово',
    onRight: commit,
    refresh: (e) => {
      if (!$('#f-name', e.body)) e.body.innerHTML = `<input class="input" id="f-name" placeholder="Название" value="${esc(f.name)}" style="margin-top:6px"><div class="opts"></div>`;
      $('.opts', e.body).innerHTML = `
        <div class="field-label">Картинка</div>
        <div class="img-row" style="${fc(f)}">
          <span class="t-ico${f.image ? ' img' : ''}">${folderIcon(f)}</span>
          <button class="btn secondary small" data-act="img-pick" style="margin:0">Загрузить свою</button>
          ${f.image ? '<button class="btn danger small" data-act="img-clear" style="margin:0">Убрать</button>' : ''}
        </div>
        <div class="field-label">Цвет</div>
        <div class="color-row">${COLORS.map((c) => `<button class="color-opt${f.color === c ? ' on' : ''}" style="--fc:var(--c-${c})" data-act="color" data-c="${c}" aria-label="${c}"></button>`).join('')}</div>
        ${f.image ? '' : `<div class="field-label">Значок</div>
        <div class="icon-grid">${Object.keys(FOLDER_ICONS).map((k) => `<button class="icon-opt${f.icon === k ? ' on' : ''}" data-act="ic" data-k="${k}">${svg(FOLDER_ICONS[k])}</button>`).join('')}</div>`}
        ${id ? `<button class="btn danger small" data-act="del" style="margin-top:24px">Удалить папку</button>
        <div class="hint">Темы из неё переедут во «Входящие».</div>` : ''}`;
    },
    actions: {
      color: (el) => { f.color = el.dataset.c; refreshTopSheet(); },
      ic: (el) => { f.icon = el.dataset.k; refreshTopSheet(); },
      'img-pick': () => pickFiles('image/*', false, async ([file]) => {
        try { f.image = await imageToIcon(file); refreshTopSheet(); } catch (e) { toast('Не удалось открыть картинку'); }
      }),
      'img-clear': () => { f.image = ''; refreshTopSheet(); },
      del: () => {
        if (!confirm(`Удалить папку «${f.name}»? Её темы переедут во «Входящие».`)) return;
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

/* ---------------- Уведомления ---------------- */

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function enablePush() {
  const s = state.settings;
  if (!s.syncUrl) { toast('Сначала подключи Google-таблицу'); return; }
  if (!pushSupported()) { toast('Открой приложение с экрана «Домой» (нужна iOS 16.4 или новее)'); return; }
  let perm = 'denied';
  try { perm = await Notification.requestPermission(); } catch (e) {}
  if (perm !== 'granted') { toast('Уведомления запрещены — разреши их в Настройках iPhone → Заметки'); return; }
  try {
    const { publicKey } = await api('vapid');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && s.vapidKey && s.vapidKey !== publicKey) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    await api('subscribe', { subscription: sub.toJSON() });
    s.pushOn = true;
    s.vapidKey = publicKey;
    save();
    scheduleSync(300);
    refreshTopSheet();
    toast('Уведомления включены');
  } catch (e) {
    toast(e.message || 'Не удалось включить уведомления');
  }
}
async function testPush() {
  try {
    const r = await api('test');
    const res = r.results || [];
    toast(!res.length ? 'Нет подписанных устройств' : res.every((x) => /^20/.test(x)) ? 'Отправлено — жди уведомление' : 'Ответ Apple: ' + res.join('; '));
  } catch (e) { toast(e.message); }
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
      const perm = pushSupported() ? Notification.permission : 'unsupported';
      entry.body.innerHTML = `
      <div class="section-title" style="margin-top:8px"><span>Уведомления</span></div>
      <div class="card" style="padding:16px">
        ${s.pushOn && perm === 'granted'
          ? `<div class="push-ok">${icon('bell')}<span>Включены на этом устройстве</span><button data-act="push-test">Проверить</button></div>`
          : `<button class="btn small" data-act="push-on" style="margin-top:0">Включить уведомления</button>`}
        <label class="set-row"><input type="checkbox" id="s-digest"${s.digestOn ? ' checked' : ''}><span>Утром — план на день</span><input type="time" id="s-digest-t" value="${esc(s.digest)}"></label>
        <label class="set-row"><input type="checkbox" id="s-evening"${s.eveningOn ? ' checked' : ''}><span>Вечером — что не закрыто</span><input type="time" id="s-evening-t" value="${esc(s.evening)}"></label>
        <div class="hint">Напоминание о конкретном деле ставится в самом деле: дата → «Напомнить в». Приходит с точностью до 5 минут. Нужны: приложение на экране «Домой», iOS 16.4+ и подключённая таблица.</div>
      </div>
      <div class="section-title"><span>Google Таблица</span></div>
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
      <div class="hint" style="text-align:center;margin:18px 0 0">Заметки ${APP_VERSION} · данные хранятся на телефоне${s.syncUrl ? ', в твоей Google-таблице и на Диске' : ''}</div>`;
    },
    onInput: (e) => {
      if (e.type !== 'change') return;
      const s = state.settings, id = e.target.id;
      if (id === 's-url') s.syncUrl = e.target.value.trim();
      else if (id === 's-secret') s.syncSecret = e.target.value.trim();
      else if (id === 's-digest') s.digestOn = e.target.checked;
      else if (id === 's-evening') s.eveningOn = e.target.checked;
      else if (id === 's-digest-t') s.digest = e.target.value || '09:00';
      else if (id === 's-evening-t') s.evening = e.target.value || '21:00';
      else return;
      save();
      if (id !== 's-url' && id !== 's-secret') scheduleSync(500);
    },
    actions: {
      'push-on': () => enablePush(),
      'push-test': () => testPush(),
    },
  });
}

async function exportFile(text, name, type) {
  const file = new File([text], name, { type });
  shareFile(file, URL.createObjectURL(file));
}

function exportBackup() {
  const data = { app: 'notespanel', version: APP_VERSION, exportedAt: new Date().toISOString() };
  for (const k of KINDS) data[k] = state[k];
  data.v = state.v;
  data.settings = { ...state.settings, syncSecret: '' };
  exportFile(JSON.stringify(data, null, 1), `notes-backup-${ymd()}.json`, 'application/json');
}

function importBackup() {
  pickFiles('.json,application/json', false, async ([file]) => {
    try {
      const data = JSON.parse(await file.text());
      if (!['folders', 'notes', 'tasks'].every((k) => Array.isArray(data[k]))) throw new Error();
      if (!confirm('Заменить текущие данные на устройстве данными из копии? Файлы-вложения подтянутся из Google Диска.')) return;
      const keepSync = { syncUrl: state.settings.syncUrl, syncSecret: state.settings.syncSecret };
      for (const k of KINDS) state[k] = (data[k] || []).map((e) => ({ ...e, _dirty: true }));
      state.v = data.v || (data.version === '0.1.0' ? 1 : 2);
      state.settings = { ...defaultSettings(), ...(data.settings || {}), ...keepSync, lastSync: 1 };
      migrate();
      save();
      closeSheet();
      scheduleSync(500);
      toast('Данные восстановлены');
    } catch (e) {
      toast('Не удалось прочитать файл');
    }
  });
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
  'viewer-close': () => { const v = $('.viewer'); if (v) { v.classList.remove('show'); setTimeout(() => v.remove(), 200); } },
  'viewer-share': (el) => { const c = fileCache.get(el.dataset.fid); if (c) shareFile(c.file, c.url); },

  day: (el) => { ui.day = el.dataset.d; render(); },
  'day-shift': (el) => { ui.day = addDays(ui.day, Number(el.dataset.n)); render(); },
  'late-today': () => moveTasks(lateTasks().map((t) => t.id), ymd()),
  toggle: (el) => toggleTask(el.dataset.id, el.closest('.task')),
  task: (el) => openTask(el.dataset.id),

  folder: (el) => { ui.folder = el.dataset.id; render(); window.scrollTo(0, 0); },
  'folders-back': () => { ui.folder = ''; render(); },
  arrange: () => { ui.arrange = true; render(); },
  'arrange-done': () => { ui.arrange = false; render(); },
  'slot-new': (el) => openFolderEdit(null, Number(el.dataset.slotN)),
  'folder-edit': (el) => openFolderEdit(el.dataset.id),
  note: (el) => openNote(el.dataset.id),
  'note-new': (el) => openNote(null, el.dataset.folder || ''),

  'cal-month': (el) => { ui.calMonth = shiftMonth(ui.calMonth, Number(el.dataset.n)); render(); },
  'cal-day': (el) => { ui.calDay = el.dataset.d; ui.calMonth = el.dataset.d.slice(0, 7); render(); },
  'cal-today': () => { ui.calDay = ymd(); ui.calMonth = ymd().slice(0, 7); render(); },
  'open-day': (el) => { ui.day = el.dataset.d; ui.tab = 'today'; render(); window.scrollTo(0, 0); },
};

document.addEventListener('click', (e) => {
  if (Date.now() - ui.swallowClick < 400) { e.preventDefault(); e.stopPropagation(); return; }
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    if (ui.tab === tabBtn.dataset.tab && tabBtn.dataset.tab === 'folders') ui.folder = '';
    if (tabBtn.dataset.tab === 'today' && ui.tab === 'today') ui.day = ymd();
    ui.tab = tabBtn.dataset.tab;
    ui.arrange = false;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (e.target.closest('#fab')) {
    if (ui.tab === 'folders' && ui.folder) openNote(null, ui.folder);
    else openCapture();
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  // Сначала ищем обработчик у листа, в котором произошёл клик
  const sheet = ui.sheets.find((s) => s.sh.contains(el));
  const fn = sheet?.actions?.[act] || ACTIONS[act];
  if (fn) { e.preventDefault(); fn(el); }
}, true);
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.tile, .task, .week')) e.preventDefault(); });

// Строка «+ Добавить дело»: Enter — сохранить и остаться в поле
function addFromInput(inp, keepFocus) {
  const title = inp.value.trim();
  if (!title) return false;
  newTask({ title, date: inp.dataset.date });
  inp.value = '';
  if (keepFocus) ui.refocus = inp.dataset.add;
  return true;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if ($('.viewer')) ACTIONS['viewer-close'](); else closeSheet(); return; }
  if (e.key !== 'Enter' || e.isComposing) return;
  const inp = e.target.closest?.('[data-add]');
  if (inp) { e.preventDefault(); if (addFromInput(inp, true)) render(); else inp.blur(); return; }
  if (e.target.id === 'f-name') { e.preventDefault(); ui.sheets[ui.sheets.length - 1]?.onRight?.(); }
});
document.addEventListener('focusout', (e) => {
  const inp = e.target.closest?.('[data-add]');
  if (inp && addFromInput(inp, false)) setTimeout(render, 300);
});

/* ---------------- Жесты ----------------
   • дело вправо → перенос на другой день
   • неделя влево/вправо → следующая/предыдущая неделя
   • папка: удержание → режим перестановки, перетаскивание → в любую ячейку */

let g = null;
const SWIPE_AT = 80;
document.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  const base = { x: e.clientX, y: e.clientY, pid: e.pointerId };
  const task = e.target.closest('.task');
  if (task) { g = { ...base, type: 'task', row: task, id: task.dataset.id }; return; }
  const week = e.target.closest('.week');
  if (week) { g = { ...base, type: 'week', el: week }; return; }
  const tile = e.target.closest('.tile');
  if (tile) {
    g = { ...base, type: ui.arrange ? 'drag' : 'press', tile, id: tile.dataset.id };
    if (!ui.arrange) {
      const mine = g;
      g.timer = setTimeout(() => {
        if (g !== mine) return;
        mine.fired = true;
        ui.arrange = true;
        navigator.vibrate?.(15);
        render();
      }, 450);
    }
    return;
  }
  g = null;
});

document.addEventListener('pointermove', (e) => {
  if (!g || e.pointerId !== g.pid) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (g.type === 'press') { if (Math.hypot(dx, dy) > 8) { clearTimeout(g.timer); g = null; } return; }
  if (g.type === 'drag') { dragMove(e, dx, dy); return; }
  if (!g.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }
    const horiz = (g.type === 'task' ? dx > 10 : Math.abs(dx) > 10) && Math.abs(dx) > Math.abs(dy) * 1.2;
    if (!horiz) return;
    g.active = true;
    if (g.type === 'task') { g.bg = g.row.previousElementSibling; g.row.classList.remove('anim'); }
    else g.el.style.transition = 'none';
    try { (g.row || g.el).setPointerCapture(e.pointerId); } catch (_) {}
  }
  if (g.type === 'task') {
    g.dx = Math.max(0, dx - 10);
    const shift = g.dx < 110 ? g.dx : 110 + (g.dx - 110) * 0.35;
    g.row.style.transform = `translateX(${shift}px)`;
    g.bg.style.opacity = Math.min(1, g.dx / 50);
    if (!g.armed && g.dx > SWIPE_AT && navigator.vibrate) navigator.vibrate(8);
    g.armed = g.dx > SWIPE_AT;
  } else {
    g.dx = dx;
    g.el.style.transform = `translateX(${dx}px)`;
    g.el.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 300));
  }
});

function dragMove(e, dx, dy) {
  if (!g.active) {
    if (Math.hypot(dx, dy) < 6) return;
    g.active = true;
    const r = g.tile.getBoundingClientRect();
    g.ghost = g.tile.cloneNode(true);
    g.ghost.classList.add('drag-ghost');
    g.ghost.style.width = r.width + 'px';
    document.body.append(g.ghost);
    g.tile.classList.add('dragging');
    g.ox = g.x - (r.left + r.width / 2);
    g.oy = g.y - (r.top + r.height / 2);
    navigator.vibrate?.(8);
  }
  g.ghost.style.left = e.clientX - g.ox + 'px';
  g.ghost.style.top = e.clientY - g.oy + 'px';
  const slot = document.elementFromPoint(e.clientX, e.clientY)?.closest('.slot');
  if (g.over !== slot) { g.over?.classList.remove('over'); slot?.classList.add('over'); g.over = slot; }
  if (e.clientY < 90) window.scrollBy(0, -10);
  else if (e.clientY > window.innerHeight - 130) window.scrollBy(0, 10);
}

function endGesture(e, cancelled) {
  if (!g || e.pointerId !== g.pid) return;
  const s = g;
  g = null;
  if (s.type === 'press') { clearTimeout(s.timer); if (s.fired) ui.swallowClick = Date.now(); return; }
  if (s.type === 'drag') {
    if (!s.active) return;
    ui.swallowClick = Date.now();
    s.ghost.remove();
    s.over?.classList.remove('over');
    if (!cancelled && s.over) moveFolderToSlot(s.id, Number(s.over.dataset.slot));
    render();
    return;
  }
  if (!s.active) return;
  ui.swallowClick = Date.now();
  if (s.type === 'task') {
    s.row.classList.add('anim');
    s.row.style.transform = '';
    s.bg.style.transition = 'opacity .2s';
    s.bg.style.opacity = 0;
    if (!cancelled && s.dx > SWIPE_AT) {
      const t = byId('tasks', s.id);
      openDatePicker({ current: t?.date || '', onPick: (d) => moveTasks([s.id], d) });
    }
    return;
  }
  // Неделя
  if (!cancelled && Math.abs(s.dx) > 50) {
    const dir = s.dx < 0 ? 1 : -1;
    s.el.style.transition = 'transform .15s ease, opacity .15s';
    s.el.style.transform = `translateX(${-dir * 100}%)`;
    s.el.style.opacity = '0';
    setTimeout(() => { ui.day = addDays(ui.day, 7 * dir); ui.weekAnim = dir; render(); }, 140);
  } else {
    s.el.style.transition = 'transform .2s, opacity .2s';
    s.el.style.transform = '';
    s.el.style.opacity = '';
  }
}
document.addEventListener('pointerup', (e) => endGesture(e, false));
document.addEventListener('pointercancel', (e) => endGesture(e, true));

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

// Данные прошлой версии: заметки с текстом → темы с блоками, дела папок → тема «Дела»
function migrate() {
  state.files ||= [];
  for (const n of state.notes) {
    if (!Array.isArray(n.blocks)) { n.blocks = [{ t: 'text', text: n.body || '' }]; delete n.body; n._dirty = true; }
  }
  for (const t of state.tasks) {
    if (t.noteId === undefined) { t.noteId = ''; t._dirty = true; }
    if (t.remind === undefined) t.remind = '';
  }
  for (const f of state.folders) {
    if (f.image === undefined) { f.image = FOLDER_IMAGES[f.name] || ''; f._dirty = true; }
  }
  if ((state.v || 1) < 2) {
    for (const t of live('tasks')) if (!t.noteId && liveFolder(t.folder)) attachTask(t.id, t.folder, '');
    state.v = 2;
  }
}

async function init() {
  const saved = await Store.get('state');
  if (saved && Array.isArray(saved.tasks)) {
    state = saved;
    for (const k of KINDS) state[k] = state[k] || [];
    state.settings = { ...defaultSettings(), ...(state.settings || {}) };
    migrate();
    save();
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
