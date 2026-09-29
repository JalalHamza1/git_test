/**
 * Db.gs – the Google Sheet used as a database.
 *
 * Rules:
 *  - Every tab is read once per server call with getDataRange().getValues() and memoised.
 *  - Columns are always found by header name (never by a fixed index).
 *  - Changes are buffered and written at the end with one setValues per block of rows.
 *  - Row objects keep timestamps as ISO strings and days as 'yyyy-MM-dd' in memory; they are
 *    converted to real Sheet dates only when written.
 *  - Nothing is ever deleted.
 */

let DB_SS_ = null;     // the spreadsheet (memo)
let DB_MEMO_ = {};     // table name → table object (memo for this server call)
let DB_GROUPS_ = {};   // 'TABLE|column' → {value: rows[]} (memo)

/** The database spreadsheet (script property DB_ID, set by setup(), or the bound Sheet). */
function db_() {
  if (DB_SS_) return DB_SS_;
  const id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  DB_SS_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!DB_SS_) throw new Error('Database spreadsheet not found. Run setup() from the Sheet\'s script.');
  return DB_SS_;
}

/**
 * Reads a whole tab into row objects (memoised for this call).
 * @param {string} name tab name
 * @return {{name, sheet, headers:string[], types:Object, rows:Object[], appends:Object[], dirty:Object, lastRow:number}}
 */
function dbTable_(name) {
  if (DB_MEMO_[name]) return DB_MEMO_[name];
  const sheet = db_().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup() first.');
  const values = sheet.getDataRange().getValues();
  const headers = (values[0] || []).map(h => String(h).trim());
  const types = {};
  schemaCols_(name).forEach(c => { types[c[0]] = c[1]; });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(v => v === '' || v === null)) continue;
    const obj = { _row: i + 1 };
    headers.forEach((h, c) => { if (h) obj[h] = dbFromCell_(r[c], types[h]); });
    rows.push(obj);
  }
  const table = { name, sheet, headers, types, rows, appends: [], dirty: {}, lastRow: Math.max(values.length, 1) };
  DB_MEMO_[name] = table;
  return table;
}

/** Converts a cell value to its in-memory form. */
function dbFromCell_(v, type) {
  if (type === 'ts') return v instanceof Date ? v.toISOString() : (v === null ? '' : v);
  if (type === 'date') return v instanceof Date ? fmt_(v, 'yyyy-MM-dd') : String(v || '');
  if (type === 'num') return v === '' || v === null ? '' : Number(v);
  if (type === 'bool') {
    if (v === '' || v === null) return '';
    return v === true || /^(true|ano|yes|1|x)$/i.test(String(v).trim());
  }
  if (type === 'text') {
    if (v instanceof Date) { // Sheets converted a typed text into a date/time
      return v.getFullYear() < 1901 ? fmt_(v, 'HH:mm') : fmt_(v, 'yyyy-MM-dd');
    }
    let s = v === null || v === undefined ? '' : String(v).trim();
    if (/^'[=+\-@]/.test(s)) s = s.slice(1); // see dbToCell_
    return s;
  }
  return v; // column not in the schema: keep the raw value
}

/** Converts an in-memory value to what we write into the cell. */
function dbToCell_(v, type) {
  if (v === undefined || v === null) return '';
  if (type === 'ts') {
    if (v === '') return '';
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : d;
  }
  if (type === 'date') {
    if (v === '') return '';
    const d = v instanceof Date ? v : parseDateTime_(String(v));
    return d || '';
  }
  if (type === 'num') return v === '' ? '' : Number(v);
  if (type === 'bool') return v === '' ? '' : v === true;
  if (type === 'text') {
    const s = String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s; // never let user text become a formula
  }
  return v;
}

/** All rows of a table that match a predicate. */
function dbWhere_(name, pred) {
  return dbTable_(name).rows.filter(pred);
}

/** First row that matches a predicate, or null. */
function dbFirst_(name, pred) {
  return dbTable_(name).rows.find(pred) || null;
}

/** Rows grouped by a column value: {value: rows[]} (memoised, reset on insert). */
function dbGroup_(name, column) {
  const key = name + '|' + column;
  if (DB_GROUPS_[key]) return DB_GROUPS_[key];
  const map = {};
  dbTable_(name).rows.forEach(r => { (map[r[column]] = map[r[column]] || []).push(r); });
  DB_GROUPS_[key] = map;
  return map;
}

/**
 * Adds a row (buffered). Missing columns are filled with ''. Audited as CREATE.
 * @return {Object} the new row object (already visible to later reads in this call)
 */
function dbInsert_(name, data) {
  const t = dbTable_(name);
  const obj = {};
  schemaCols_(name).forEach(c => { obj[c[0]] = ''; });
  Object.assign(obj, data);
  if (SCHEMA[name].audit) {
    const now = nowIso_();
    obj.created_at = now; obj.updated_at = now;
    obj.created_by = auditUser_(); obj.updated_by = obj.created_by;
  }
  obj._row = t.lastRow + t.appends.length + 1;
  obj._new = true;
  t.rows.push(obj);
  t.appends.push(obj);
  Object.keys(DB_GROUPS_).forEach(k => { if (k.indexOf(name + '|') === 0) delete DB_GROUPS_[k]; });
  if (!SCHEMA[name].log) audit_(obj.qrap_id || '', name, entityId_(name, obj), 'CREATE', '', '', auditJson_(obj));
  return obj;
}

/**
 * Changes fields of a row (buffered). Only real changes are written and audited field by field.
 * @return {boolean} true if something changed
 */
function dbUpdate_(name, obj, changes) {
  const t = dbTable_(name);
  let changed = false;
  Object.keys(changes).forEach(k => {
    const nv = changes[k] === undefined || changes[k] === null ? '' : changes[k];
    if (sameValue_(obj[k], nv)) return;
    if (!SCHEMA[name].log) audit_(obj.qrap_id || '', name, entityId_(name, obj), 'UPDATE', k, obj[k], nv);
    obj[k] = nv;
    changed = true;
  });
  if (!changed) return false;
  if (SCHEMA[name].audit) { obj.updated_at = nowIso_(); obj.updated_by = auditUser_(); }
  if (!obj._new) t.dirty[obj._row] = obj;
  return true;
}

function sameValue_(a, b) {
  if (a === b) return true;
  if ((a === '' || a === null || a === undefined) && (b === '' || b === null || b === undefined)) return true;
  return String(a) === String(b);
}

/** A readable id for the audit log. */
function entityId_(name, obj) {
  if (obj.id) return obj.id;
  if (name === 'QRAP') return obj.qrap_id;
  if (name === 'ATTACHMENT') return obj.file_id;
  if (name === 'WHY_STEP') return obj.chain + ':' + obj.step;
  if (name === 'EFFECTIVENESS') return 'R' + obj.round + 'S' + obj.slot;
  if (name === 'ALERT') return obj.role_code;
  if (name === 'SHIFT_INFO') return obj.shift_code;
  if (name === 'PILOT') return obj.email;
  return '';
}

/** Writes every buffered change: one setValues per block of consecutive rows. */
function dbFlush_() {
  Object.keys(DB_MEMO_).forEach(name => {
    const t = DB_MEMO_[name];
    const toRow = o => t.headers.map(h => dbToCell_(o[h], t.types[h]));
    const dirtyRows = Object.keys(t.dirty).map(Number).sort((a, b) => a - b);
    let i = 0;
    while (i < dirtyRows.length) {
      let j = i;
      while (j + 1 < dirtyRows.length && dirtyRows[j + 1] === dirtyRows[j] + 1) j++;
      const block = dirtyRows.slice(i, j + 1).map(r => toRow(t.dirty[r]));
      t.sheet.getRange(dirtyRows[i], 1, block.length, t.headers.length).setValues(block);
      i = j + 1;
    }
    if (t.appends.length) {
      const start = t.lastRow + 1;
      ensureRows_(t.sheet, start + t.appends.length - 1);
      t.sheet.getRange(start, 1, t.appends.length, t.headers.length).setValues(t.appends.map(toRow));
      t.appends.forEach(o => { delete o._new; });
      t.lastRow += t.appends.length;
    }
    t.dirty = {};
    t.appends = [];
  });
  auditFlush_();
}

/**
 * getRange() fails outside the sheet grid, so we add rows before writing past the end.
 * New rows copy the formatting of the last row (plain-text columns stay plain text).
 */
function ensureRows_(sheet, lastNeeded) {
  const max = sheet.getMaxRows();
  if (lastNeeded > max) sheet.insertRowsAfter(max, lastNeeded - max + 200);
}

/** Forgets all buffered changes and memoised reads (used when a write call returns ok:false). */
function dbDiscard_() {
  DB_MEMO_ = {};
  DB_GROUPS_ = {};
  AUDIT_BUF_ = [];
  MAIL_QUEUE_ = [];
}

/**
 * Runs a write operation safely:
 * script lock → fresh reads → fn() → write sheet changes → audit → e-mails → clear board cache.
 * The lock also protects QRAP number generation (see nextQrapId_).
 * @param {Function} fn body; may return {ok:false,…} to cancel all buffered writes
 */
function withWrite_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('E_BUSY');
  try {
    dbDiscard_(); // always read the newest data inside the lock
    const result = fn();
    if (result && result.ok === false) {
      dbDiscard_();
      return result;
    }
    dbFlush_();
    mailFlush_();
    invalidateBoardCache_();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Next QRAP number for an area in the current month, e.g. WH1-2026-9-14.
 * Must be called inside withWrite_ (the script lock is held there).
 * @return {{id:string, seq:number}}
 */
function nextQrapId_(area) {
  const now = new Date();
  const key = [area, fmt_(now, 'yyyy'), fmt_(now, 'M')].join('-');
  const row = dbFirst_('COUNTER', r => r.key === key);
  let seq = 1;
  if (row) {
    seq = Number(row.last_seq || 0) + 1;
    dbUpdate_('COUNTER', row, { last_seq: seq });
  } else {
    dbInsert_('COUNTER', { key: key, last_seq: seq });
  }
  return { id: key + '-' + seq, seq: seq };
}

// ---------------------------------------------------------------- big cache values

/**
 * Stores a JSON value in CacheService, split into chunks (a single value may be at most 100 KB).
 * 45 000 characters per chunk leaves room for 2-byte Czech letters.
 */
function cachePutBig_(key, obj, ttlSeconds) {
  try {
    const json = JSON.stringify(obj);
    const size = 45000;
    const n = Math.max(1, Math.ceil(json.length / size));
    const parts = {};
    for (let i = 0; i < n; i++) parts[key + '_' + i] = json.substr(i * size, size);
    parts[key] = String(n);
    CacheService.getScriptCache().putAll(parts, ttlSeconds);
  } catch (e) {
    console.warn('cachePutBig_ failed for ' + key + ': ' + e);
  }
}

/** Reads a value stored by cachePutBig_, or null. */
function cacheGetBig_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(key));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + '_' + i);
    const parts = cache.getAll(keys);
    let json = '';
    for (let i = 0; i < n; i++) {
      if (parts[keys[i]] === undefined || parts[keys[i]] === null) return null;
      json += parts[keys[i]];
    }
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}
