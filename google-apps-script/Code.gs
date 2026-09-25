/**
 * Синхронизация приложения «Заметки» с Google Таблицей.
 *
 * 1. Открой таблицу → Расширения → Apps Script, вставь этот код целиком.
 * 2. Придумай длинный секрет и впиши его в SECRET ниже (тот же — в настройках приложения).
 * 3. Начать развёртывание → Новое развёртывание → Тип: Веб-приложение,
 *    «Выполнять как»: Я, «Кто имеет доступ»: Все. Скопируй URL (…/exec) в приложение.
 */
const SECRET = 'ЗАМЕНИ-НА-СВОЙ-ДЛИННЫЙ-СЕКРЕТ';

// Порядок колонок в листах. Слева — читаемые, справа — технические (серые).
// Не переставляй колонки вручную.
const SHEETS = {
  folders: {
    name: 'Папки',
    cols: [['name', 'Название'], ['icon', 'Значок'], ['color', 'Цвет'],
      ['id', 'id'], ['order', 'order'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  tasks: {
    name: 'Дела',
    cols: [['date', 'Дата'], ['title', 'Дело'], ['folderName', 'Папка'], ['done', 'Сделано'], ['note', 'Заметка'],
      ['id', 'id'], ['folder', 'folder'], ['order', 'order'], ['doneAt', 'doneAt'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
  notes: {
    name: 'Заметки',
    cols: [['folderName', 'Папка'], ['title', 'Заголовок'], ['body', 'Текст'], ['pinned', 'Закреплена'],
      ['id', 'id'], ['folder', 'folder'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt'], ['deleted', 'deleted']],
  },
};
const TEXT_KEYS = ['id', 'name', 'icon', 'color', 'title', 'folder', 'folderName', 'note', 'body'];

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

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const changes = body.changes || {};
    const data = {};
    Object.keys(SHEETS).forEach(function (kind) {
      const def = SHEETS[kind];
      const sh = ensureSheet(ss, def);
      if (changes[kind] && changes[kind].length) upsert(sh, def, changes[kind]);
      data[kind] = readAll(sh, def, tz);
    });
    return json({ ok: true, data: data, serverTime: Date.now() });
  } finally {
    lock.releaseLock();
  }
}

function ensureSheet(ss, def) {
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    const keys = def.cols.map(function (c) { return c[0]; });
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols.map(function (c) { return c[1]; })]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Текстовые колонки — как текст, чтобы Таблица не превращала их в даты/числа
    keys.forEach(function (k, i) {
      const col = sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1);
      if (TEXT_KEYS.indexOf(k) >= 0) col.setNumberFormat('@');
      if (['createdAt', 'updatedAt', 'doneAt', 'order'].indexOf(k) >= 0) col.setNumberFormat('0');
      if (k === 'date') col.setNumberFormat('yyyy-mm-dd');
    });
    const techStart = keys.indexOf('id') + 1;
    if (techStart > 0) sh.getRange(1, techStart, 1, keys.length - techStart + 1).setFontColor('#999999');
  }
  return sh;
}

function upsert(sh, def, rows) {
  const keys = def.cols.map(function (c) { return c[0]; });
  const idCol = keys.indexOf('id') + 1;
  const last = sh.getLastRow();
  const index = {};
  if (last > 1) {
    sh.getRange(2, idCol, last - 1, 1).getValues().forEach(function (r, i) { if (r[0]) index[String(r[0])] = i + 2; });
  }
  const appends = [];
  rows.forEach(function (r) {
    if (!r || !r.id) return;
    const vals = keys.map(function (k) {
      const v = r[k];
      if (v === undefined || v === null) return '';
      if (k === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const p = v.split('-');
        return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      }
      return v;
    });
    const rowNum = index[r.id];
    if (rowNum) sh.getRange(rowNum, 1, 1, keys.length).setValues([vals]);
    else { appends.push(vals); index[r.id] = -1; }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, keys.length).setValues(appends);
}

function readAll(sh, def, tz) {
  const keys = def.cols.map(function (c) { return c[0]; });
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, keys.length).getValues()
    .map(function (row) {
      const o = {};
      keys.forEach(function (k, i) {
        let v = row[i];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        o[k] = v;
      });
      return o;
    })
    .filter(function (o) { return o.id; });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
