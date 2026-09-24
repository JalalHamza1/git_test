/**
 * Task Manager — server (Google Apps Script)
 * ---------------------------------------------------------------------------
 * Data lives in a Google Sheet (one row per task); the UI is index.html.
 * Every write runs under one script lock, edits rows in memory and flushes
 * them in a single setValues call, then returns only the rows it touched.
 */

/*** ===== CONFIG ===== ***/
const SS_ID = '';

const CONFIG = {
  CALENDAR_NAME: 'My Tasks',
  SHEET_NAME: 'Tasks',
  SKIP_WEEKENDS: true,
  BLACKOUT_DATES: ['2026-09-23'],
  ALLDAY_REMINDER_MINUTES: 600,
  TIMED_REMINDER_MINUTES: 30,
  EVENT_MINUTES: 30,
  TAG_KEY: 'taskRowId',
  DEFAULT_LIST: 'General',
  SHOW_LIST_IN_TITLE: true,
  DIGEST_HOUR: 7,
  LIST_COLORS: {
    Onboarding: 'BLUE',
    Training: 'GREEN',
    Admin: 'ORANGE',
    Meetings: 'MAUVE',
    General: 'GRAY',
  },
};

const HEADERS = ['ID', 'Task', 'Description', 'Due Date', 'Status', 'Priority', 'Event ID', 'Last Synced', 'List', 'Archived',
  'Starred', 'Parent', 'Order', 'Repeat', 'Due Time', 'Created', 'Completed'];
// 0-based indexes into a row array (sheet column = index + 1)
const C = { ID: 0, TITLE: 1, DESC: 2, DUE: 3, STATUS: 4, PRIORITY: 5, EVENT: 6, SYNCED: 7, LIST: 8, ARCH: 9,
  STAR: 10, PARENT: 11, ORDER: 12, REPEAT: 13, TIME: 14, CREATED: 15, DONE_AT: 16 };

const STATUSES = ['Not started', 'In progress', 'Blocked', 'Done'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const REPEATS = ['', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const COLORS = ['BLUE', 'GREEN', 'RED', 'ORANGE', 'YELLOW', 'MAUVE', 'CYAN', 'PALE_BLUE', 'PALE_GREEN', 'PALE_RED', 'GRAY'];
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const SCHEMA_KEY = 'schemaVersion';
const SCHEMA_VERSION = '2';
const LISTS_KEY = 'lists_v2';
const LEGACY_LISTS_KEY = 'customLists';
const SETTINGS_KEY = 'settings';

const _cache = {};

/*** ===== SHEET ACCESS ===== ***/
function ss_() {
  return _cache.ss || (_cache.ss = SS_ID ? SpreadsheetApp.openById(SS_ID) : SpreadsheetApp.getActive());
}

function tz_() {
  return _cache.tz || (_cache.tz = ss_().getSpreadsheetTimeZone());
}

function props_() {
  return _cache.props || (_cache.props = PropertiesService.getDocumentProperties() || PropertiesService.getScriptProperties());
}

function sheet_() {
  if (_cache.sheet) return _cache.sheet;
  const ss = ss_();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME), fresh = false;
  if (!sh) { sh = ss.insertSheet(CONFIG.SHEET_NAME); fresh = true; }
  if (fresh || props_().getProperty(SCHEMA_KEY) !== SCHEMA_VERSION) migrate_(sh, fresh);
  return (_cache.sheet = sh);
}

// Adds the new columns at the end so existing rows keep working, and stores
// free-text columns as plain text so titles like "1/2" or "=A1" stay literal.
function migrate_(sh, fresh) {
  const missing = HEADERS.length - sh.getMaxColumns();
  if (missing > 0) sh.insertColumnsAfter(sh.getMaxColumns(), missing);
  if (sh.getMaxRows() < 2) sh.insertRowsAfter(1, 100);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#0d1117').setFontColor('#58a6ff');
  sh.setFrozenRows(1);
  sh.getRangeList(['A2:C', 'E2:G', 'I2:J', 'L2:L', 'N2:O']).setNumberFormat('@');
  sh.getRange('D2:D').setNumberFormat('yyyy-mm-dd');
  sh.getRangeList(['H2:H', 'P2:Q']).setNumberFormat('yyyy-mm-dd hh:mm');
  if (fresh) {
    sh.setColumnWidth(C.TITLE + 1, 280);
    sh.setColumnWidth(C.DESC + 1, 420);
  }
  props_().setProperty(SCHEMA_KEY, SCHEMA_VERSION);
}

function grid_() {
  if (_cache.grid) return _cache.grid;
  const sh = sheet_(), last = sh.getLastRow();
  _cache.grid = last < 2 ? [] : sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  _cache.readLen = _cache.grid.length;
  return _cache.grid;
}

function dirty_() {
  delete _cache.grid;
  delete _cache.index;
  delete _cache.touched;
}

function index_() {
  if (_cache.index) return _cache.index;
  const map = new Map();
  grid_().forEach((r, i) => { if (r[C.ID] !== '') map.set(String(r[C.ID]), i); });
  return (_cache.index = map);
}

function find_(id) {
  const i = index_().get(String(id));
  return i === undefined ? -1 : i;
}

function must_(id) {
  const i = find_(id);
  if (i < 0) throw new Error('Task not found. It may have been deleted — refresh to see the latest.');
  return i;
}

function touch_(i) {
  (_cache.touched || (_cache.touched = new Set())).add(i);
}

function flush_() {
  const t = _cache.touched;
  if (!t || !t.size) return;
  const g = grid_(), sorted = [...t].sort((a, b) => a - b);
  const lo = sorted[0], hi = sorted[sorted.length - 1], sh = sheet_();
  if (hi >= _cache.readLen) {
    const needRows = hi + 2 - sh.getMaxRows();
    if (needRows > 0) sh.insertRowsAfter(sh.getMaxRows(), needRows);
  }
  sh.getRange(lo + 2, 1, hi - lo + 1, HEADERS.length).setValues(g.slice(lo, hi + 1));
  t.clear();
}

function appendRow_(row) {
  const g = grid_();
  g.push(row);
  const i = g.length - 1;
  index_().set(String(row[C.ID]), i);
  touch_(i);
  return i;
}

// Deletes whole rows bottom-up in contiguous runs. Call after flush_().
function removeRows_(idxs) {
  const sorted = [...new Set(idxs)].sort((a, b) => b - a);
  if (!sorted.length) return;
  flush_();
  const sh = sheet_(), g = grid_();
  // Sheets refuses to delete every non-frozen row, so keep one spare.
  if (sorted.length >= sh.getMaxRows() - 1) sh.insertRowsAfter(sh.getMaxRows(), 1);
  let runEnd = sorted[0], runStart = sorted[0];
  const drop = () => sh.deleteRows(runStart + 2, runEnd - runStart + 1);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] === runStart - 1) { runStart = sorted[k]; continue; }
    drop();
    runEnd = runStart = sorted[k];
  }
  drop();
  sorted.forEach(i => g.splice(i, 1));
  delete _cache.index;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    dirty_();
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/*** ===== SERIALISATION ===== ***/
function isoDate_(v) {
  if (v === '' || v == null) return '';
  if (!(v instanceof Date)) {
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const parsed = new Date(s);
    if (isNaN(parsed)) return '';
    v = parsed;
  }
  if (_cache.sameTz === undefined) _cache.sameTz = Session.getScriptTimeZone() === tz_();
  if (!_cache.sameTz) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const m = v.getMonth() + 1, d = v.getDate();
  return v.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

function hhmm_(v) {
  if (v === '' || v == null) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'HH:mm');
  const m = String(v).trim().match(TIME_RE);
  return m ? (m[1].length === 1 ? '0' : '') + m[1] + ':' + m[2] : '';
}

function stamp_(v) {
  if (v === '' || v == null) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? '' : d.toISOString();
}

function str_(v) {
  if (v == null) return '';
  return v instanceof Date ? isoDate_(v) : String(v);
}

function truthy_(v) {
  return v === true || ['true', 'yes', 'y', 'x', '1', '★'].includes(String(v).trim().toLowerCase());
}

function arch_(r) {
  const a = String(r[C.ARCH]).trim().toLowerCase();
  if (a === 'completed') return 'Completed';
  if (a === 'deleted') return 'Deleted';
  if (a === 'yes') return r[C.STATUS] === 'Done' ? 'Completed' : 'Deleted';
  return r[C.STATUS] === 'Done' ? 'Completed' : '';
}

function listOf_(r) {
  return str_(r[C.LIST]).trim() || CONFIG.DEFAULT_LIST;
}

function orderOf_(r, i) {
  const ord = Number(r[C.ORDER]);
  return r[C.ORDER] === '' || isNaN(ord) ? i + 2 : ord;
}

function toTask_(r, i) {
  const arch = arch_(r);
  return {
    id: str_(r[C.ID]),
    title: str_(r[C.TITLE]),
    desc: str_(r[C.DESC]),
    due: isoDate_(r[C.DUE]),
    time: hhmm_(r[C.TIME]),
    status: arch === 'Completed' ? 'Done' : (STATUSES.includes(r[C.STATUS]) && r[C.STATUS] !== 'Done' ? r[C.STATUS] : 'Not started'),
    priority: PRIORITIES.includes(r[C.PRIORITY]) ? r[C.PRIORITY] : 'Medium',
    list: listOf_(r),
    starred: truthy_(r[C.STAR]),
    parent: str_(r[C.PARENT]),
    order: orderOf_(r, i),
    repeat: REPEATS.includes(r[C.REPEAT]) ? r[C.REPEAT] : '',
    created: stamp_(r[C.CREATED]),
    completed: stamp_(r[C.DONE_AT]),
    archived: !!arch,
    archType: arch,
    synced: !!r[C.EVENT],
  };
}

function isTask_(r) {
  return r[C.ID] !== '' && r[C.TITLE] !== '';
}

function allTasks_() {
  const out = [];
  grid_().forEach((r, i) => { if (isTask_(r)) out.push(toTask_(r, i)); });
  return out;
}

function out_(idxs, extra) {
  const g = grid_();
  const tasks = [...new Set(idxs)].filter(i => g[i] && isTask_(g[i])).map(i => toTask_(g[i], i));
  return Object.assign({ tasks: tasks }, extra || {});
}

function blankRow_() {
  return HEADERS.map(() => '');
}

function newId_() {
  return 't' + Utilities.getUuid().replace(/-/g, '').slice(0, 9);
}

function childrenOf_(id) {
  const out = [];
  id = String(id);
  grid_().forEach((r, i) => { if (str_(r[C.PARENT]) === id && isTask_(r)) out.push(i); });
  return out;
}

/*** ===== UI ENTRY POINTS ===== ***/
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Task Manager')
    .addItem('Open side panel', 'showSidebar')
    .addItem('Open full screen', 'showDialog')
    .addSeparator()
    .addItem('Sync to Calendar', 'menuSync')
    .addItem('Email me today\'s digest', 'menuDigest')
    .addToUi();
}

function page_() {
  return HtmlService.createHtmlOutputFromFile('index')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function showSidebar() { SpreadsheetApp.getUi().showSidebar(page_().setTitle('Tasks')); }
function showDialog() { SpreadsheetApp.getUi().showModalDialog(page_().setWidth(1280).setHeight(800), 'Tasks'); }
function doGet() { return page_().setTitle('Tasks'); }

function menuSync() { ss_().toast(syncToCalendar().message, 'Task Manager'); }
function menuDigest() { ss_().toast(sendDigest(), 'Task Manager'); }

/*** ===== READ API ===== ***/
function getAll() {
  if (grid_().some(r => r[C.ID] === '' && r[C.TITLE] !== '')) {
    withLock_(() => {
      grid_().forEach((r, i) => {
        if (r[C.ID] === '' && r[C.TITLE] !== '') { r[C.ID] = newId_(); touch_(i); }
      });
      flush_();
    });
  }
  const tasks = allTasks_();
  return { tasks: tasks, lists: lists_(tasks), settings: settings_(), defaultList: CONFIG.DEFAULT_LIST };
}

/*** ===== LISTS ===== ***/
function parse_(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

function storedLists_() {
  if (_cache.lists) return _cache.lists;
  const p = props_();
  let arr = parse_(p.getProperty(LISTS_KEY));
  if (!Array.isArray(arr)) {
    const legacy = parse_(p.getProperty(LEGACY_LISTS_KEY));
    const names = Array.isArray(legacy) ? legacy : Object.keys(CONFIG.LIST_COLORS);
    arr = names.filter(Boolean).map(String).sort((a, b) => a.localeCompare(b))
      .map(n => ({ name: n, color: CONFIG.LIST_COLORS[n] || 'GRAY' }));
  }
  _cache.lists = arr.filter(l => l && l.name).map(l => ({
    name: String(l.name), color: COLORS.includes(l.color) ? l.color : 'GRAY',
  }));
  return _cache.lists;
}

function saveLists_(arr) {
  props_().setProperty(LISTS_KEY, JSON.stringify(arr));
  _cache.lists = arr;
}

// Stored lists first (user order), then any list a live task still points at.
function lists_(tasks) {
  const out = storedLists_().map(l => Object.assign({}, l));
  const seen = new Set(out.map(l => l.name));
  const add = n => {
    if (n && !seen.has(n)) { seen.add(n); out.push({ name: n, color: CONFIG.LIST_COLORS[n] || 'GRAY' }); }
  };
  add(CONFIG.DEFAULT_LIST);
  (tasks || allTasks_()).forEach(t => { if (!t.archived) add(t.list); });
  return out;
}

function cleanListName_(name) {
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) throw new Error('List name required.');
  return n;
}

function createList(name, color) {
  name = cleanListName_(name);
  return withLock_(() => {
    const all = lists_();
    if (all.some(l => l.name.toLowerCase() === name.toLowerCase())) throw new Error('That list already exists.');
    const stored = storedLists_().concat({ name: name, color: COLORS.includes(color) ? color : 'BLUE' });
    saveLists_(stored);
    return { lists: lists_() };
  });
}

function renameList(oldName, newName) {
  oldName = cleanListName_(oldName);
  newName = cleanListName_(newName);
  if (oldName === CONFIG.DEFAULT_LIST) throw new Error('The default list can\'t be renamed (change CONFIG.DEFAULT_LIST instead).');
  return withLock_(() => {
    if (oldName === newName) return { lists: lists_(), tasks: [] };
    if (lists_().some(l => l.name !== oldName && l.name.toLowerCase() === newName.toLowerCase())) {
      throw new Error('A list with that name already exists.');
    }
    const stored = storedLists_();
    const had = stored.find(l => l.name === oldName);
    saveLists_(had ? stored.map(l => (l.name === oldName ? { name: newName, color: l.color } : l))
      : stored.concat({ name: newName, color: CONFIG.LIST_COLORS[oldName] || 'GRAY' }));
    const changed = [];
    grid_().forEach((r, i) => {
      if (isTask_(r) && listOf_(r) === oldName) { r[C.LIST] = newName; touch_(i); changed.push(i); }
    });
    flush_();
    return out_(changed, { lists: lists_() });
  });
}

function setListColor(name, color) {
  name = cleanListName_(name);
  if (!COLORS.includes(color)) throw new Error('Unknown color.');
  return withLock_(() => {
    const stored = storedLists_();
    saveLists_(stored.some(l => l.name === name)
      ? stored.map(l => (l.name === name ? { name: name, color: color } : l))
      : stored.concat({ name: name, color: color }));
    return { lists: lists_() };
  });
}

function deleteList(name) {
  name = cleanListName_(name);
  if (name === CONFIG.DEFAULT_LIST) throw new Error('Cannot delete the default list.');
  return withLock_(() => {
    saveLists_(storedLists_().filter(l => l.name !== name));
    const changed = [];
    grid_().forEach((r, i) => {
      if (isTask_(r) && listOf_(r) === name && arch_(r) !== 'Deleted') {
        r[C.ARCH] = 'Deleted';
        touch_(i);
        changed.push(i);
      }
    });
    calendarAfter_(changed, true);
    flush_();
    return out_(changed, { lists: lists_() });
  });
}

/*** ===== TASK MUTATIONS ===== ***/
function cleanTitle_(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
}

function calKey_(r) {
  return [r[C.TITLE], r[C.DESC], isoDate_(r[C.DUE]), hhmm_(r[C.TIME]), r[C.STATUS], r[C.PRIORITY], r[C.LIST], arch_(r)].join('\u0001');
}

// Creates the task when the id is unknown, otherwise applies only the fields present.
function saveTask(input) {
  const p = input || {};
  const id = String(p.id || '').trim();
  if (id && !ID_RE.test(id)) throw new Error('Invalid task id.');
  return withLock_(() => {
    const g = grid_();
    let i = id ? find_(id) : -1;
    const isNew = i < 0;
    if (isNew) {
      if (!cleanTitle_(p.title)) throw new Error('Task name is required.');
      const r = blankRow_();
      r[C.ID] = id || newId_();
      r[C.STATUS] = 'Not started';
      r[C.PRIORITY] = 'Medium';
      r[C.LIST] = CONFIG.DEFAULT_LIST;
      r[C.CREATED] = new Date();
      i = appendRow_(r);
    }
    const r = g[i], before = isNew ? '' : calKey_(r), changed = [i];
    applyPatch_(r, i, p, changed);
    if (isNew && r[C.ORDER] === '') r[C.ORDER] = topOrder_(listOf_(r), str_(r[C.PARENT]), i);
    touch_(i);
    calendarAfter_(changed.filter(k => k !== i).concat(calKey_(r) !== before ? [i] : []), false);
    flush_();
    return out_(changed);
  });
}

function topOrder_(list, parent, skip) {
  let min = Infinity;
  grid_().forEach((r, i) => {
    if (i !== skip && isTask_(r) && !arch_(r) && listOf_(r) === list && str_(r[C.PARENT]) === parent) {
      min = Math.min(min, orderOf_(r, i));
    }
  });
  return min === Infinity ? 0 : min - 1;
}

function applyPatch_(r, i, p, changed) {
  const g = grid_(), id = str_(r[C.ID]);
  if ('title' in p) {
    const title = cleanTitle_(p.title);
    if (!title) throw new Error('Task name is required.');
    r[C.TITLE] = title;
  }
  if ('desc' in p) r[C.DESC] = String(p.desc == null ? '' : p.desc).trim().slice(0, 5000);
  if ('due' in p) {
    const due = String(p.due || '').trim();
    if (due && !ISO_RE.test(due)) throw new Error('Bad date.');
    r[C.DUE] = due ? new Date(due + 'T12:00:00') : '';
  }
  if ('time' in p) r[C.TIME] = hhmm_(p.time);
  if ('status' in p && STATUSES.includes(p.status) && p.status !== 'Done') r[C.STATUS] = p.status;
  if ('priority' in p && PRIORITIES.includes(p.priority)) r[C.PRIORITY] = p.priority;
  if ('starred' in p) r[C.STAR] = p.starred ? true : '';
  if ('repeat' in p) r[C.REPEAT] = REPEATS.includes(p.repeat) ? p.repeat : '';
  if ('order' in p && isFinite(Number(p.order)) && p.order !== '' && p.order !== null) r[C.ORDER] = Number(p.order);
  if ('list' in p) {
    const list = cleanListName_(p.list || CONFIG.DEFAULT_LIST);
    if (listOf_(r) !== list) {
      r[C.LIST] = list;
      if (!('parent' in p) && str_(r[C.PARENT])) r[C.PARENT] = '';
      childrenOf_(id).forEach(k => { g[k][C.LIST] = list; touch_(k); changed.push(k); });
    }
  }
  if ('parent' in p) {
    const parent = String(p.parent || '').trim();
    if (parent) {
      const pi = must_(parent), pr = g[pi];
      if (parent === id) throw new Error('A task can\'t be its own subtask.');
      if (str_(pr[C.PARENT])) throw new Error('Subtasks can only go one level deep.');
      if (arch_(pr)) throw new Error('That parent task is completed or deleted.');
      if (childrenOf_(id).some(k => arch_(g[k]) !== 'Deleted')) throw new Error('A task with subtasks can\'t become a subtask.');
      r[C.LIST] = listOf_(pr);
    }
    r[C.PARENT] = parent;
  }
}

function completeTask(id, nextId) {
  if (nextId && !ID_RE.test(String(nextId))) throw new Error('Invalid task id.');
  return withLock_(() => {
    const g = grid_(), i = must_(id), r = g[i];
    if (arch_(r)) return out_([i]);
    const now = new Date(), changed = [i];
    const mark = row => { row[C.STATUS] = 'Done'; row[C.ARCH] = 'Completed'; row[C.DONE_AT] = now; };
    mark(r);
    touch_(i);
    childrenOf_(id).forEach(k => {
      if (!arch_(g[k])) { mark(g[k]); touch_(k); changed.push(k); }
    });
    const rule = REPEATS.includes(r[C.REPEAT]) ? r[C.REPEAT] : '';
    if (rule && !(nextId && find_(nextId) >= 0)) {
      const n = blankRow_();
      n[C.ID] = nextId || newId_();
      [C.TITLE, C.DESC, C.PRIORITY, C.LIST, C.STAR, C.PARENT, C.ORDER, C.REPEAT, C.TIME].forEach(c => { n[c] = r[c]; });
      n[C.STATUS] = 'Not started';
      n[C.DUE] = new Date(nextDue_(isoDate_(r[C.DUE]), rule, isoDate_(now)) + 'T12:00:00');
      n[C.CREATED] = now;
      if (n[C.PARENT]) {
        const pi = find_(n[C.PARENT]);
        if (pi < 0 || arch_(g[pi])) n[C.PARENT] = '';
      }
      if (r[C.EVENT] || r[C.SYNCED]) n[C.SYNCED] = now;
      changed.push(appendRow_(n));
    }
    calendarAfter_(changed, false);
    flush_();
    return out_(changed);
  });
}

// Next occurrence after `iso` (or today), never earlier than today.
function nextDue_(iso, rule, today) {
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const base = parse(iso || today), floor = parse(today), anchor = base.getUTCDate();
  let d = new Date(base), months = 0;
  const step = () => {
    if (rule === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (rule === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (rule === 'weekdays') {
      do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    } else {
      months += rule === 'yearly' ? 12 : 1;
      const y = base.getUTCFullYear(), m = base.getUTCMonth() + months;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      d = new Date(Date.UTC(y, m, Math.min(anchor, last)));
    }
  };
  step();
  for (let guard = 0; d < floor && guard < 5000; guard++) step();
  return d.toISOString().slice(0, 10);
}

function unarchive_(row) {
  row[C.ARCH] = '';
  row[C.DONE_AT] = '';
  if (row[C.STATUS] === 'Done' || !STATUSES.includes(row[C.STATUS])) row[C.STATUS] = 'Not started';
}

function restoreTask(id) {
  return withLock_(() => {
    const g = grid_(), i = must_(id), r = g[i], was = arch_(r);
    if (!was) return out_([i]);
    const doneAt = r[C.DONE_AT] instanceof Date ? r[C.DONE_AT].getTime() : NaN;
    const changed = [i];
    unarchive_(r);
    touch_(i);
    const parent = str_(r[C.PARENT]);
    if (parent) {
      const pi = find_(parent), pa = pi < 0 ? 'missing' : arch_(g[pi]);
      if (pa === 'Completed') { unarchive_(g[pi]); touch_(pi); changed.push(pi); }
      else if (pa) r[C.PARENT] = '';
    }
    childrenOf_(id).forEach(k => {
      const c = g[k];
      if (arch_(c) !== was) return;
      // Only subtasks completed in the same action as the parent share its exact timestamp.
      if (was === 'Completed' && !(c[C.DONE_AT] instanceof Date && c[C.DONE_AT].getTime() === doneAt)) return;
      unarchive_(c);
      touch_(k);
      changed.push(k);
    });
    calendarAfter_(changed, false);
    flush_();
    return out_(changed);
  });
}

function deleteTask(id) {
  return withLock_(() => {
    const g = grid_(), i = must_(id), changed = [i];
    [i].concat(childrenOf_(id)).forEach(k => {
      if (arch_(g[k]) === 'Deleted') return;
      g[k][C.ARCH] = 'Deleted';
      touch_(k);
      if (k !== i) changed.push(k);
    });
    calendarAfter_(changed, true);
    flush_();
    return out_(changed);
  });
}

function purge_(idxs) {
  const g = grid_(), all = new Set(idxs), purgedIds = new Set(idxs.map(i => str_(g[i][C.ID])));
  g.forEach((r, k) => { if (isTask_(r) && purgedIds.has(str_(r[C.PARENT]))) all.add(k); });
  const removed = [...all].map(i => str_(g[i][C.ID]));
  const withEvents = [...all].filter(i => g[i][C.EVENT]);
  if (withEvents.length) {
    const cal = getCalendar_();
    withEvents.forEach(i => deleteEvent_(cal, g[i][C.EVENT]));
  }
  removeRows_([...all]);
  return { removed: removed };
}

function purgeTask(id) {
  return withLock_(() => purge_([must_(id)]));
}

function emptyTrash() {
  return withLock_(() => {
    const idxs = [];
    grid_().forEach((r, i) => { if (isTask_(r) && arch_(r) === 'Deleted') idxs.push(i); });
    return purge_(idxs);
  });
}

function clearCompleted(list) {
  list = cleanListName_(list);
  return withLock_(() => {
    const changed = [];
    grid_().forEach((r, i) => {
      if (isTask_(r) && listOf_(r) === list && arch_(r) === 'Completed') {
        r[C.ARCH] = 'Deleted';
        touch_(i);
        changed.push(i);
      }
    });
    flush_();
    return out_(changed);
  });
}

// Sets the full sibling order for one list (or one parent's subtasks).
function reorderTasks(list, parent, ids) {
  list = cleanListName_(list || CONFIG.DEFAULT_LIST);
  parent = String(parent || '').trim();
  if (!Array.isArray(ids)) throw new Error('ids must be an array.');
  return withLock_(() => {
    const g = grid_(), changed = [], listMoved = [];
    if (parent) {
      const pr = g[must_(parent)];
      if (str_(pr[C.PARENT])) throw new Error('Subtasks can only go one level deep.');
      list = listOf_(pr);
    }
    ids.forEach((id, n) => {
      const i = find_(id);
      if (i < 0) return;
      const r = g[i];
      if (parent) {
        if (String(id) === parent) throw new Error('A task can\'t be its own subtask.');
        if (childrenOf_(id).some(k => arch_(g[k]) !== 'Deleted')) throw new Error('A task with subtasks can\'t become a subtask.');
      }
      r[C.ORDER] = n;
      r[C.PARENT] = parent;
      if (listOf_(r) !== list) {
        r[C.LIST] = list;
        listMoved.push(i);
        childrenOf_(id).forEach(k => { g[k][C.LIST] = list; touch_(k); changed.push(k); listMoved.push(k); });
      }
      touch_(i);
      changed.push(i);
    });
    calendarAfter_(listMoved, false);
    flush_();
    return out_(changed);
  });
}

/*** ===== CALENDAR ===== ***/
function getCalendar_() {
  if (_cache.cal) return _cache.cal;
  const found = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  if (found.length) return (_cache.cal = found[0]);
  const cal = CalendarApp.createCalendar(CONFIG.CALENDAR_NAME);
  cal.setColor(CalendarApp.Color.BLUE);
  return (_cache.cal = cal);
}

function deleteEvent_(cal, eventId) {
  try { const ev = cal.getEventById(eventId); if (ev) ev.deleteEvent(); } catch (e) {}
}

function dueDate_(r) {
  const v = r[C.DUE];
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = isoDate_(v);
  return s ? new Date(s + 'T12:00:00') : null;
}

function wantsEvent_(r) {
  return isTask_(r) && !arch_(r) && !!dueDate_(r);
}

// Brings the calendar in line with a row. Keeps "Last Synced" as a marker so a
// restored or re-dated task gets its event back.
function syncRow_(r, stamp) {
  const eventId = str_(r[C.EVENT]);
  if (!wantsEvent_(r)) {
    if (!eventId) return '';
    deleteEvent_(getCalendar_(), eventId);
    r[C.EVENT] = '';
    return 'removed';
  }
  const cal = getCalendar_(), t = toTask_(r, 0);
  const day = shiftToWorkingDay_(dueDate_(r));
  const label = buildTitle_(t), body = buildDescription_(t, isoDate_(day));
  let start = null, end = null;
  if (t.time) {
    const [h, m] = t.time.split(':').map(Number);
    start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    end = new Date(start.getTime() + CONFIG.EVENT_MINUTES * 60000);
  }
  let ev = null, kind = 'updated';
  if (eventId) { try { ev = cal.getEventById(eventId); } catch (e) { ev = null; } }
  if (ev) {
    if (ev.getTitle() !== label) ev.setTitle(label);
    if (ev.getDescription() !== body) ev.setDescription(body);
    if (start) ev.setTime(start, end); else ev.setAllDayDate(day);
  } else {
    ev = start ? cal.createEvent(label, start, end, { description: body }) : cal.createAllDayEvent(label, day, { description: body });
    ev.setTag(CONFIG.TAG_KEY, t.id);
    ev.addPopupReminder(start ? CONFIG.TIMED_REMINDER_MINUTES : CONFIG.ALLDAY_REMINDER_MINUTES);
    kind = 'created';
  }
  try { ev.setColor(colorFor_(t.list)); } catch (e) {}
  r[C.EVENT] = ev.getId();
  r[C.SYNCED] = stamp || new Date();
  return kind;
}

// Keeps existing events in step with edits; creates new ones only when auto-sync is on.
function calendarAfter_(idxs, forceRemove) {
  if (!idxs.length) return;
  const g = grid_(), auto = userSettings_().autoSync;
  [...new Set(idxs)].forEach(i => {
    const r = g[i];
    const known = r[C.EVENT] || r[C.SYNCED];
    if (forceRemove ? !r[C.EVENT] : !(known || auto)) return;
    if (!wantsEvent_(r) && !r[C.EVENT]) return;
    try { syncRow_(r); touch_(i); } catch (e) { console.warn('Calendar sync failed for ' + r[C.ID] + ': ' + e); }
  });
}

function syncToCalendar() {
  return withLock_(() => {
    const g = grid_(), stamp = new Date();
    let created = 0, updated = 0, removed = 0, failed = 0;
    const changed = [];
    g.forEach((r, i) => {
      if (r[C.TITLE] === '') return;
      if (r[C.ID] === '') { r[C.ID] = newId_(); touch_(i); }
      if (!wantsEvent_(r) && !r[C.EVENT]) return;
      try {
        const kind = syncRow_(r, stamp);
        if (kind === 'created') created++;
        else if (kind === 'updated') updated++;
        else if (kind === 'removed') removed++;
        touch_(i);
        changed.push(i);
      } catch (e) {
        failed++;
        console.warn('Sync failed for ' + r[C.ID] + ': ' + e);
      }
    });
    flush_();
    const parts = [`Created ${created}`, `Updated ${updated}`];
    if (removed) parts.push(`Removed ${removed}`);
    if (failed) parts.push(`${failed} failed`);
    return out_(changed, { message: parts.join(' · ') });
  });
}

/*** ===== SETTINGS & DIGEST ===== ***/
function userProps_() {
  return PropertiesService.getUserProperties();
}

function userSettings_() {
  if (_cache.settings) return _cache.settings;
  const s = parse_(userProps_().getProperty(SETTINGS_KEY)) || {};
  return (_cache.settings = {
    autoSync: !!s.autoSync,
    digest: !!s.digest,
    digestHour: Number.isInteger(s.digestHour) ? s.digestHour : CONFIG.DIGEST_HOUR,
  });
}

function settings_() {
  let url = '';
  try { url = ss_().getUrl(); } catch (e) {}
  return Object.assign({ sheetUrl: url }, userSettings_());
}

function saveSettings(patch) {
  patch = patch || {};
  const cur = parse_(userProps_().getProperty(SETTINGS_KEY)) || {};
  if ('autoSync' in patch) cur.autoSync = !!patch.autoSync;
  if ('digest' in patch) cur.digest = !!patch.digest;
  if ('digestHour' in patch) {
    const h = Number(patch.digestHour);
    if (Number.isInteger(h) && h >= 0 && h <= 23) cur.digestHour = h;
  }
  if ('digest' in patch || 'digestHour' in patch) {
    ScriptApp.getProjectTriggers()
      .filter(t => t.getHandlerFunction() === 'sendDigest')
      .forEach(t => ScriptApp.deleteTrigger(t));
    if (cur.digest) {
      ScriptApp.newTrigger('sendDigest').timeBased().everyDays(1)
        .atHour(Number.isInteger(cur.digestHour) ? cur.digestHour : CONFIG.DIGEST_HOUR).create();
    }
  }
  userProps_().setProperty(SETTINGS_KEY, JSON.stringify(cur));
  delete _cache.settings;
  return { settings: settings_() };
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendDigest() {
  const email = Session.getEffectiveUser().getEmail();
  if (!email) return 'No email address available for this account.';
  const today = isoDate_(new Date());
  const active = allTasks_().filter(t => !t.archived);
  const byDue = (a, b) => (a.due + a.time).localeCompare(b.due + b.time) || a.order - b.order;
  const overdue = active.filter(t => t.due && t.due < today).sort(byDue);
  const dueToday = active.filter(t => t.due === today).sort(byDue);
  const starred = active.filter(t => t.starred && !(t.due && t.due <= today)).sort(byDue);
  if (!overdue.length && !dueToday.length && !starred.length) return 'Nothing due — no email sent.';

  const row = t => `<tr><td style="padding:6px 0;border-bottom:1px solid #30363d">
      <div style="color:#e6edf3;font-size:14px">${t.starred ? '★ ' : ''}${esc_(t.title)}</div>
      <div style="color:#8b949e;font-size:12px">${esc_(t.list)}${t.due ? ' · ' + esc_(t.due) : ''}${t.time ? ' ' + esc_(t.time) : ''}${t.priority === 'High' ? ' · High priority' : ''}</div>
    </td></tr>`;
  const section = (title, color, list) => !list.length ? '' :
    `<h3 style="margin:20px 0 4px;font-size:13px;letter-spacing:.5px;text-transform:uppercase;color:${color}">${title} (${list.length})</h3>
     <table style="width:100%;border-collapse:collapse">${list.map(row).join('')}</table>`;

  let link = '';
  try { link = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  if (!link) link = settings_().sheetUrl;

  const html = `<div style="background:#0d1117;padding:24px;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px 24px">
      <h2 style="margin:0;color:#e6edf3;font-size:18px">Your tasks for ${esc_(Utilities.formatDate(new Date(), tz_(), 'EEEE, MMM d'))}</h2>
      ${section('Overdue', '#ff7b72', overdue)}
      ${section('Due today', '#6ea8fe', dueToday)}
      ${section('Starred', '#e3b341', starred)}
      ${link ? `<p style="margin:20px 0 0"><a href="${esc_(link)}" style="color:#6ea8fe">Open Task Manager</a></p>` : ''}
    </div></div>`;
  const subject = `Tasks: ${dueToday.length} due today` + (overdue.length ? `, ${overdue.length} overdue` : '');
  MailApp.sendEmail({ to: email, subject: subject, htmlBody: html, name: 'Task Manager' });
  return 'Digest sent to ' + email;
}

/*** ===== HELPERS ===== ***/
function buildTitle_(t) {
  const tag = CONFIG.SHOW_LIST_IN_TITLE && t.list ? `[${t.list}] ` : '';
  if (t.status === 'Blocked') return `⛔ ${tag}${t.title}`;
  if (t.priority === 'High') return `🔥 ${tag}${t.title}`;
  if (t.starred) return `⭐ ${tag}${t.title}`;
  return `📅 ${tag}${t.title}`;
}

function buildDescription_(t, shiftedIso) {
  const lines = [t.desc || '(no description)', '', '─────────────',
    `List: ${t.list}`, `Priority: ${t.priority}`, `Status: ${t.status}`];
  if (t.repeat) lines.push(`Repeats: ${t.repeat}`);
  if (shiftedIso !== t.due) lines.push(`Due ${t.due} — moved to the next working day.`);
  lines.push('Managed by Task Manager — edit in the app, not here.');
  return lines.join('\n');
}

function colorFor_(list) {
  const stored = storedLists_().find(l => l.name === list);
  const name = (stored && stored.color) || CONFIG.LIST_COLORS[list] || 'GRAY';
  return CalendarApp.EventColor[name] || CalendarApp.EventColor.GRAY;
}

function shiftToWorkingDay_(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  const blackout = new Set(CONFIG.BLACKOUT_DATES);
  for (let guard = 0; guard < 60; guard++) {
    const day = date.getDay();
    const bad = (CONFIG.SKIP_WEEKENDS && (day === 0 || day === 6)) || blackout.has(isoDate_(date));
    if (!bad) return date;
    date.setDate(date.getDate() + 1);
  }
  return date;
}
