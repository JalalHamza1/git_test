/**
 * eQRAP Logistika – all server code in one file (Code.gs).
 * Same code as the apps-script/ folder, joined in this order: Config, Util, Db, Audit, Auth, Main, Qrap, Wizard, Board, Decision, Escalation, Analysis, Actions, Effectiveness, Assessment, Photos, Mail, Triggers, Manager, Admin, Setup, SeedDemo.
 */

// ======================================================================
// Config.gs
// ======================================================================
/**
 * Config.gs – constants, table definitions (schema), settings loader and shift maths.
 *
 * Settings live in the SET_* tabs of the Google Sheet. They are read once per server call,
 * kept in CacheService for 10 minutes and cleared by onEdit() when an admin edits a SET_* tab.
 * Top level = constants only (no calls to Google services here).
 */

const APP_NAME = 'eQRAP Logistika';
const TZ = 'Europe/Prague';
const TEMPLATE_VERSION = 'QRAP V3.0 ed.2021';

/** QRAP states (spec section 7). */
const ST = {
  DRAFT: 'DRAFT',
  QR_OPEN: 'QR_OPEN',
  WAIT_DECISION: 'WAIT_DECISION',
  CLOSED_SOLVED: 'CLOSED_SOLVED',
  ESCALATED: 'ESCALATED',
  ANALYSIS: 'ANALYSIS',
  ACTIONS_OPEN: 'ACTIONS_OPEN',
  VERIFY: 'VERIFY',
  CLOSED: 'CLOSED'
};
const FINAL_STATES = [ST.CLOSED_SOLVED, ST.ESCALATED, ST.CLOSED];
const QR_STATES = [ST.DRAFT, ST.QR_OPEN, ST.WAIT_DECISION];
const ANALYSIS_STATES = [ST.ANALYSIS, ST.ACTIONS_OPEN, ST.VERIFY];

const DECISIONS = ['CONTINUE', 'SOLVED', 'ESCALATE'];
const ALL_ROLES = ['KIOSK', 'OPERATOR', 'TL', 'SUPERVISOR', 'PILOT', 'QUALITY', 'EHS',
  'MANAGER', 'APU_MANAGER', 'ADMIN'];
const ROUTING_KEYS = ['SUPERVISOR', 'MANAGER', 'QUALITY', 'EHS', 'TL', 'APU_MANAGER'];
const EFF_RESULTS = ['EFFECTIVE', 'NOT_VERIFIED', 'NOT_EFFECTIVE'];
const ASSESS_VALUES = ['OK', 'NOK', 'NA'];
const FEEDBACK_TYPES = ['PRAISE', 'STRENGTH', 'IMPROVE'];

/** Default values for SET_CONFIG (setup() writes missing keys). */
const CONFIG_DEFAULTS = {
  APP_URL: '',
  PHOTO_FOLDER_ID: '',
  DIGEST_TIME: '06:30',
  IDLE_MINUTES: '3',
  OVERDUE_N1_DAYS: '3',
  ARCHIVE_AFTER_DAYS: '90',
  BOARD_CLOSED_DAYS: '7',
  ASSESSMENT_OPEN_TO_ALL: 'TRUE',
  SENDER_NAME: 'eQRAP Logistika'
};

/**
 * Table definitions. Each column is [header, type].
 * Types: text | num | bool | ts (full timestamp) | date (day only).
 * settings: true  → a SET_* tab edited by the admin
 * audit: true     → created_at, created_by, updated_at, updated_by are added automatically
 * log: true       → append-only, never read as a whole, not audited itself
 */
const SCHEMA = {
  SET_CONFIG: { settings: true, cols: [['key', 'text'], ['value', 'text']] },
  SET_AREAS: { settings: true, cols: [['area_code', 'text'], ['name', 'text'], ['level', 'text'],
    ['parent_code', 'text'], ['active', 'bool']] },
  SET_LOCATIONS: { settings: true, cols: [['area_code', 'text'], ['zone', 'text'],
    ['location_code', 'text'], ['active', 'bool']] },
  SET_SHIFTS: { settings: true, cols: [['shift_code', 'text'], ['name', 'text'], ['start', 'text'],
    ['end', 'text'], ['days', 'text'], ['active', 'bool']] },
  SET_PEOPLE: { settings: true, cols: [['name', 'text'], ['email', 'text'], ['badge_id', 'text'],
    ['roles', 'text'], ['areas', 'text'], ['n1_email', 'text'], ['active', 'bool']] },
  SET_ROUTING: { settings: true, cols: [['area_code', 'text'], ['shift_code', 'text'],
    ['role_key', 'text'], ['email', 'text']] },
  SET_LISTS: { settings: true, cols: [['list', 'text'], ['code', 'text'], ['value_cz', 'text'],
    ['value_en', 'text'], ['order', 'num'], ['active', 'bool']] },

  QRAP: { audit: true, cols: [
    ['qrap_id', 'text'], ['area_code', 'text'], ['level', 'text'], ['seq', 'num'], ['suffix', 'text'],
    ['parent_id', 'text'], ['status', 'text'], ['template_version', 'text'],
    ['safety', 'text'], ['what', 'text'], ['how_found', 'text'], ['detected_at', 'ts'],
    ['zone', 'text'], ['location_code', 'text'], ['origin_zone', 'text'], ['qty', 'num'],
    ['unit', 'text'], ['nok_situation', 'bool'], ['repeat_7d', 'text'], ['repeat_ref', 'text'],
    ['finder_name', 'text'], ['finder_badge', 'text'], ['material_no', 'text'],
    ['hu_or_delivery_no', 'text'], ['supplier', 'text'], ['photo_exception', 'text'],
    ['risk_stock_shipped', 'text'], ['checked_qty', 'num'], ['wrong_found_qty', 'num'],
    ['check_in_progress', 'bool'], ['process_stopped', 'text'], ['restored_at', 'ts'],
    ['s1_done_at', 'ts'], ['s2_done_at', 'ts'], ['s3_done_at', 'ts'], ['sent_at', 'ts'],
    ['containment_done_at', 'ts'], ['decision', 'text'], ['decision_comment', 'text'],
    ['decided_by', 'text'], ['decided_at', 'ts'], ['assign_ref', 'text'], ['learned', 'text'],
    ['std_update', 'text'], ['std_update_ref', 'text'], ['closed_by', 'text'], ['closed_at', 'ts'],
    ['locked_parts', 'text'], ['archived', 'bool']] },
  ALERT: { audit: true, cols: [['qrap_id', 'text'], ['role_code', 'text'], ['other_text', 'text'],
    ['notified_to', 'text'], ['notified_at', 'ts'], ['removed', 'bool']] },
  ATTACHMENT: { audit: true, cols: [['file_id', 'text'], ['thumb_file_id', 'text'], ['qrap_id', 'text'],
    ['kind', 'text'], ['uploaded_by', 'text'], ['uploaded_at', 'ts'], ['removed', 'bool']] },
  IMMEDIATE_ACTION: { audit: true, cols: [['id', 'text'], ['qrap_id', 'text'], ['type', 'text'],
    ['text', 'text'], ['owner_name', 'text'], ['owner_email', 'text'], ['done_at', 'ts'],
    ['status', 'text']] },
  SHIFT_INFO: { audit: true, cols: [['qrap_id', 'text'], ['shift_code', 'text'],
    ['informed_by', 'text'], ['informed_at', 'ts']] },
  PILOT: { audit: true, cols: [['qrap_id', 'text'], ['email', 'text'], ['assigned_by', 'text'],
    ['assigned_at', 'ts']] },
  WHY_STEP: { audit: true, cols: [['qrap_id', 'text'], ['chain', 'text'], ['step', 'num'],
    ['text', 'text'], ['is_root', 'bool']] },
  DEF_ACTION: { audit: true, cols: [['id', 'text'], ['qrap_id', 'text'], ['root_step', 'text'],
    ['text', 'text'], ['pilot_email', 'text'], ['planned', 'date'], ['planned_first', 'date'],
    ['done', 'date'], ['status', 'text'], ['evidence_url', 'text']] },
  ACTION_NOTE: { audit: true, cols: [['id', 'text'], ['action_id', 'text'], ['note', 'text'],
    ['review_date', 'date'], ['review_done', 'bool'], ['author', 'text'], ['at', 'ts']] },
  EFFECTIVENESS: { audit: true, cols: [['qrap_id', 'text'], ['round', 'num'], ['slot', 'num'],
    ['shift_date', 'date'], ['shift_code', 'text'], ['result', 'text'], ['checked_by', 'text'],
    ['checked_at', 'ts']] },
  ASSESSMENT: { audit: true, cols: [['id', 'text'], ['qrap_id', 'text'], ['assessor', 'text'],
    ['at', 'ts'], ['c1', 'text'], ['c2', 'text'], ['c3', 'text'], ['c4', 'text'], ['c5', 'text'],
    ['ojt_with', 'text'], ['feedback', 'text'], ['feedback_type', 'text']] },
  AUDIT_LOG: { log: true, cols: [['ts', 'ts'], ['user', 'text'], ['qrap_id', 'text'],
    ['entity', 'text'], ['entity_id', 'text'], ['action', 'text'], ['field', 'text'],
    ['old', 'text'], ['new', 'text']] },
  MAIL_LOG: { log: true, cols: [['ts', 'ts'], ['rule', 'text'], ['qrap_id', 'text'], ['to', 'text'],
    ['cc', 'text'], ['subject', 'text'], ['key', 'text']] },
  COUNTER: { log: true, cols: [['key', 'text'], ['last_seq', 'num']] }
};

const AUDIT_COLS = [['created_at', 'ts'], ['created_by', 'text'], ['updated_at', 'ts'],
  ['updated_by', 'text']];
const SETTINGS_CACHE_KEY = 'settings_v1';

/** All columns of a table, including the automatic audit columns. */
function schemaCols_(name) {
  const s = SCHEMA[name];
  if (!s) throw new Error('Unknown table ' + name);
  return s.audit ? s.cols.concat(AUDIT_COLS) : s.cols;
}

// ---------------------------------------------------------------- settings

let SETTINGS_ = null; // per-execution memo (globals are reset for every server call)

/**
 * Returns all settings as plain objects: {config, areas, locations, shifts, people, routing, lists}.
 * Order: memo → CacheService → read the SET_* tabs.
 */
function getSettings_() {
  if (SETTINGS_) return SETTINGS_;
  const cached = cacheGetBig_(SETTINGS_CACHE_KEY);
  if (cached) {
    SETTINGS_ = cached;
    return SETTINGS_;
  }
  SETTINGS_ = loadSettings_();
  cachePutBig_(SETTINGS_CACHE_KEY, SETTINGS_, 600);
  return SETTINGS_;
}

/** Reads the SET_* tabs (one bulk read per tab) and normalises the values. */
function loadSettings_() {
  const isOn = r => r.active !== false; // an empty "active" cell counts as active
  const config = Object.assign({}, CONFIG_DEFAULTS);
  dbTable_('SET_CONFIG').rows.forEach(r => {
    if (r.key) config[String(r.key).trim()] = String(r.value).trim();
  });
  const areas = dbTable_('SET_AREAS').rows.filter(r => r.area_code && isOn(r)).map(r => ({
    code: up_(r.area_code), name: r.name, level: up_(r.level) || 'AREA', parent: up_(r.parent_code)
  }));
  const locations = dbTable_('SET_LOCATIONS').rows.filter(r => r.area_code && isOn(r)).map(r => ({
    area: up_(r.area_code), zone: r.zone, code: r.location_code
  }));
  const shifts = dbTable_('SET_SHIFTS').rows.filter(r => r.shift_code && isOn(r)).map(r => ({
    code: up_(r.shift_code), name: r.name, start: hhmm_(r.start), end: hhmm_(r.end),
    days: parseDays_(r.days)
  }));
  const people = dbTable_('SET_PEOPLE').rows.filter(r => r.name && isOn(r)).map(r => ({
    name: r.name, email: normEmail_(r.email), badge: String(r.badge_id || '').trim(),
    roles: splitList_(r.roles).map(up_), areas: splitList_(r.areas).map(up_), n1: normEmail_(r.n1_email)
  }));
  const routing = dbTable_('SET_ROUTING').rows.filter(r => r.area_code && r.email).map(r => ({
    area: up_(r.area_code), shift: up_(r.shift_code) || '*', role: up_(r.role_key),
    email: normEmail_(r.email)
  }));
  const lists = {};
  dbTable_('SET_LISTS').rows.filter(r => r.list && r.code && isOn(r)).forEach(r => {
    const key = up_(r.list);
    (lists[key] = lists[key] || []).push({ code: up_(r.code), cz: r.value_cz, en: r.value_en || r.value_cz,
      order: Number(r.order) || 0 });
  });
  Object.keys(lists).forEach(k => lists[k].sort((a, b) => a.order - b.order));
  return { config, areas, locations, shifts, people, routing, lists };
}

/** One SET_CONFIG value as a string. */
function cfg_(key) {
  const v = getSettings_().config[key];
  return v === undefined || v === null ? '' : String(v);
}
function cfgNum_(key) {
  const n = Number(cfg_(key));
  return isNaN(n) ? Number(CONFIG_DEFAULTS[key]) || 0 : n;
}
function cfgBool_(key) { return /^(true|ano|yes|1)$/i.test(cfg_(key)); }

/** The /exec URL used in e-mails and QR codes. */
function appUrl_() {
  const fromConfig = cfg_('APP_URL');
  if (fromConfig) return fromConfig;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function areaByCode_(code) {
  return getSettings_().areas.find(a => a.code === up_(code)) || null;
}
function parentAreaOf_(code) {
  const a = areaByCode_(code);
  return a && a.parent ? areaByCode_(a.parent) : null;
}
function listCodes_(list) { return (getSettings_().lists[list] || []).map(x => x.code); }
function listLabelCz_(list, code) {
  const s = String(code || '');
  if (s.indexOf('OTHER:') === 0) return 'jiné: ' + s.slice(6);
  const item = (getSettings_().lists[list] || []).find(x => x.code === s);
  return item ? item.cz : s;
}
function personByEmail_(email) {
  const e = normEmail_(email);
  return e ? getSettings_().people.find(p => p.email === e) || null : null;
}
function personByName_(name) {
  const n = String(name || '').trim().toLowerCase();
  return n ? getSettings_().people.find(p => p.name.toLowerCase() === n) || null : null;
}
function personByBadge_(badge) {
  const b = String(badge || '').trim();
  return b ? getSettings_().people.find(p => p.badge && p.badge === b) || null : null;
}
function personName_(email) {
  const p = personByEmail_(email);
  return p ? p.name : String(email || '');
}

/**
 * Routing: e-mails for an area + role at a given moment. Rows for the current shift win;
 * rows with shift "*" are the fallback.
 * @param {string} area  area code
 * @param {string} role  routing key (SUPERVISOR, MANAGER, …)
 * @param {Date=} when   defaults to now
 * @return {string[]}
 */
function route_(area, role, when) {
  const rows = getSettings_().routing.filter(r => r.area === up_(area) && r.role === up_(role));
  const shift = shiftAt_(when || new Date());
  const exact = shift ? rows.filter(r => r.shift === shift.code) : [];
  const use = exact.length ? exact : rows.filter(r => r.shift === '*');
  return uniq_(use.map(r => r.email));
}

// ---------------------------------------------------------------- shifts

/** "1-5", "12345", "1,2,3" → [1,2,3,4,5]. Empty → all days. Monday = 1 … Sunday = 7. */
function parseDays_(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return [1, 2, 3, 4, 5, 6, 7];
  const out = [];
  const range = s.match(/^([1-7])\s*-\s*([1-7])$/);
  if (range) {
    for (let d = Number(range[1]); d <= Number(range[2]); d++) out.push(d);
    return out;
  }
  s.replace(/[^1-7]/g, '').split('').forEach(c => { if (out.indexOf(Number(c)) < 0) out.push(Number(c)); });
  return out;
}

/** "6:00" / "06:00" / Date(1899…) → {h, m}. */
function hhmm_(v) {
  if (v instanceof Date) v = fmt_(v, 'HH:mm');
  const m = String(v || '').match(/(\d{1,2}):(\d{2})/);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : { h: 0, m: 0 };
}

/** Start and end Date of a shift that starts on the local day (y, mo, d). */
function shiftWindow_(shift, y, mo, d) {
  const start = tzDate_(y, mo, d, shift.start.h, shift.start.m);
  let end = tzDate_(y, mo, d, shift.end.h, shift.end.m);
  if (end <= start) end = tzDate_(y, mo, d + 1, shift.end.h, shift.end.m); // night shift
  return { start, end };
}

/**
 * The shift running at a moment, or null. A night shift belongs to the day it starts.
 * @return {{code:string, name:string, shiftDate:string}|null}
 */
function shiftAt_(when) {
  const p = localParts_(when);
  const shifts = getSettings_().shifts;
  for (let offset = 0; offset >= -1; offset--) {
    const day = localParts_(tzDate_(p.y, p.m, p.d + offset, 12, 0));
    for (const s of shifts) {
      if (s.days.indexOf(day.dow) < 0) continue;
      const w = shiftWindow_(s, day.y, day.m, day.d);
      if (when >= w.start && when < w.end) {
        return { code: s.code, name: s.name, shiftDate: fmt_(w.start, 'yyyy-MM-dd') };
      }
    }
  }
  return null;
}

/** Start of the first shift that begins after `when` (null if no shift is configured). */
function nextShiftStart_(when) {
  const p = localParts_(when);
  let best = null;
  for (let offset = 0; offset <= 8; offset++) {
    const day = localParts_(tzDate_(p.y, p.m, p.d + offset, 12, 0));
    getSettings_().shifts.forEach(s => {
      if (s.days.indexOf(day.dow) < 0) return;
      const start = tzDate_(day.y, day.m, day.d, s.start.h, s.start.m);
      if (start > when && (!best || start < best)) best = start;
    });
    if (best) return best;
  }
  return best;
}

// ---------------------------------------------------------------- caches

/**
 * Simple trigger: runs when someone edits the Sheet by hand. Editing a SET_* tab clears
 * the settings cache so the change is visible at once.
 */
function onEdit(e) {
  try {
    const name = e && e.range ? e.range.getSheet().getName() : '';
    if (name.indexOf('SET_') === 0) CacheService.getScriptCache().remove(SETTINGS_CACHE_KEY);
  } catch (err) {
    console.warn('onEdit cache clear failed: ' + err);
  }
}

/** Run from the editor to clear the settings and board caches. */
function clearCaches() {
  const cache = CacheService.getScriptCache();
  cache.remove(SETTINGS_CACHE_KEY);
  cache.put('board_ver', String(Date.now()), 21600);
  SETTINGS_ = null;
  Logger.log('Caches cleared.');
}


// ======================================================================
// Util.gs
// ======================================================================
/**
 * Util.gs – small helpers: dates in Europe/Prague, text cleaning, ids and HTML escaping.
 *
 * Dates: the server always works with real Date objects (instants). Local Prague values
 * are read with Utilities.formatDate and built with tzDate_(), so the code gives the same
 * result whatever time zone the runtime uses.
 */

/** Formats a Date in Europe/Prague with a Java pattern (e.g. 'yyyy-MM-dd HH:mm'). */
function fmt_(d, pattern) {
  return Utilities.formatDate(d, TZ, pattern);
}

/** Current time as an ISO string (the form we keep timestamps in, in memory). */
function nowIso_() {
  return new Date().toISOString();
}

/** Today (or the day of d) in Prague as 'yyyy-MM-dd'. */
function todayStr_(d) {
  return fmt_(d || new Date(), 'yyyy-MM-dd');
}

/** Minutes east of UTC for Prague at the instant d (+60 in winter, +120 in summer). */
function tzOffsetMin_(d) {
  const s = fmt_(d, 'Z'); // e.g. +0200
  const sign = s.charAt(0) === '-' ? -1 : 1;
  return sign * (Number(s.substr(1, 2)) * 60 + Number(s.substr(3, 2)));
}

/**
 * Builds the Date for a local Prague wall-clock time. Day overflow is allowed
 * (d = 32 → next month), which makes "add N days" easy.
 */
function tzDate_(y, mo, d, h, mi) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0));
  const off1 = tzOffsetMin_(guess);
  let res = new Date(guess.getTime() - off1 * 60000);
  const off2 = tzOffsetMin_(res);
  if (off2 !== off1) res = new Date(guess.getTime() - off2 * 60000); // DST edge
  return res;
}

/** Local parts of an instant: {y, m, d, H, M, dow} (dow: Monday = 1 … Sunday = 7). */
function localParts_(d) {
  const s = fmt_(d, 'yyyy-MM-dd-HH-mm-u').split('-');
  return { y: +s[0], m: +s[1], d: +s[2], H: +s[3], M: +s[4], dow: +s[5] };
}

/**
 * Parses a value from the browser into a Date.
 * 'YYYY-MM-DDTHH:mm' and 'YYYY-MM-DD' are Prague local times; full ISO strings keep their zone.
 * @return {Date|null}
 */
function parseDateTime_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (m) return tzDate_(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** A timestamp from the browser as an ISO string, or '' when empty / invalid. */
function isoOrBlank_(v) {
  const d = parseDateTime_(v);
  return d ? d.toISOString() : '';
}

/** A day from the browser as 'yyyy-MM-dd', or '' when empty / invalid. */
function dateStr_(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const d = parseDateTime_(s.length > 10 ? s : s + 'T12:00');
  return d ? todayStr_(d) : '';
}

/** 'yyyy-MM-dd' + n days → 'yyyy-MM-dd'. */
function addDaysStr_(dayStr, n) {
  const p = dayStr.split('-').map(Number);
  return todayStr_(tzDate_(p[0], p[1], p[2] + n, 12, 0));
}

/** Monday 00:00 (Prague) of the week that contains d. */
function weekStart_(d) {
  const p = localParts_(d);
  return tzDate_(p.y, p.m, p.d - (p.dow - 1), 0, 0);
}

/** Hours between two instants (ISO strings or Dates). */
function hoursBetween_(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
}

// ---------------------------------------------------------------- text

/** Trims, removes control characters and cuts to max length. */
function str_(v, max) {
  if (v === undefined || v === null) return '';
  let s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

/** Upper-case trimmed text. */
function up_(v) {
  return String(v === undefined || v === null ? '' : v).trim().toUpperCase();
}

/** Normalised e-mail (lower case, trimmed). */
function normEmail_(v) {
  return String(v || '').trim().toLowerCase();
}

/** 'a, b;c' → ['a', 'b', 'c']. */
function splitList_(v) {
  return String(v || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
}

/** 'ano' / 'ANO' / true → 'ANO', 'ne' / false → 'NE', anything else → ''. */
function yesNo_(v) {
  if (v === true) return 'ANO';
  if (v === false) return 'NE';
  const s = up_(v);
  if (s === 'ANO' || s === 'YES') return 'ANO';
  if (s === 'NE' || s === 'NO') return 'NE';
  return '';
}

/** Whole number ≥ 0, or '' when empty / invalid. */
function intOrBlank_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : '';
}

function uniq_(arr) {
  return arr.filter((x, i) => x && arr.indexOf(x) === i);
}

function truncate_(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Short unique id with a prefix, e.g. IA-3F9A1C2B7D. */
function newId_(prefix) {
  return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
}

/** Escapes text for HTML (used in e-mails; the browser uses textContent instead). */
function esc_(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON that is safe to put inside a <script> tag. */
function safeJson_(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Copy of a row for the browser: no internal keys (_row …), no Date objects. */
function clientRow_(row) {
  const out = {};
  Object.keys(row || {}).forEach(k => {
    if (k.charAt(0) === '_') return;
    const v = row[k];
    out[k] = v instanceof Date ? v.toISOString() : v;
  });
  return out;
}


// ======================================================================
// Db.gs
// ======================================================================
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


// ======================================================================
// Audit.gs
// ======================================================================
/**
 * Audit.gs – append-only AUDIT_LOG and a helper to append rows to log tabs by header name.
 *
 * dbInsert_ / dbUpdate_ call audit_() automatically, so every write is logged.
 * Admin actions add their own rows with the reason.
 */

let AUDIT_BUF_ = []; // buffered audit rows for this server call

/**
 * Adds one audit entry (written by auditFlush_ at the end of the call).
 * @param {string} qrapId
 * @param {string} entity   tab name, e.g. QRAP
 * @param {string} entityId row id
 * @param {string} action   CREATE, UPDATE, ADMIN_UNLOCK, …
 * @param {string=} field
 * @param {*=} oldValue
 * @param {*=} newValue
 */
function audit_(qrapId, entity, entityId, action, field, oldValue, newValue) {
  AUDIT_BUF_.push({
    ts: new Date(), user: auditUser_(), qrap_id: qrapId || '', entity: entity,
    entity_id: entityId || '', action: action, field: field || '',
    old: auditStr_(oldValue), new: auditStr_(newValue)
  });
}

/** Who is writing: the signed-in e-mail, or "system" for triggers. */
function auditUser_() {
  try {
    const email = Session.getActiveUser().getEmail();
    return email ? String(email).toLowerCase() : 'system';
  } catch (e) {
    return 'system';
  }
}

function auditStr_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString();
  return truncate_(typeof v === 'object' ? JSON.stringify(v) : String(v), 2000);
}

/** JSON of a new row without internal and audit keys. */
function auditJson_(obj) {
  const copy = {};
  Object.keys(obj).forEach(k => {
    if (k.charAt(0) === '_' || /^(created|updated)_/.test(k)) return;
    if (obj[k] !== '' && obj[k] !== false) copy[k] = obj[k];
  });
  return JSON.stringify(copy);
}

/** Writes the buffered audit rows (one setValues). Called by dbFlush_. */
function auditFlush_() {
  if (!AUDIT_BUF_.length) return;
  appendByHeader_('AUDIT_LOG', AUDIT_BUF_);
  AUDIT_BUF_ = [];
}

/**
 * Appends objects to a log tab, mapping keys to columns by header name.
 * Reads only the header row, so it stays fast when the log is long.
 * @param {string} name   tab name
 * @param {Object[]} objs rows to append
 */
function appendByHeader_(name, objs) {
  if (!objs.length) return;
  const sheet = db_().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup() first.');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const types = {};
  schemaCols_(name).forEach(c => { types[c[0]] = c[1]; });
  const rows = objs.map(o => headers.map(h => dbToCell_(o[h] === undefined ? '' : o[h], types[h])));
  const start = sheet.getLastRow() + 1;
  ensureRows_(sheet, start + rows.length - 1);
  sheet.getRange(start, 1, rows.length, headers.length).setValues(rows);
}

/** Reads one column of a log tab (e.g. MAIL_LOG.key) without reading the whole tab. */
function readLogColumn_(name, header) {
  const sheet = db_().getSheetByName(name);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const col = headers.indexOf(header) + 1;
  if (!col) return [];
  return sheet.getRange(2, col, last - 1, 1).getValues().map(r => String(r[0]));
}


// ======================================================================
// Auth.gs
// ======================================================================
/**
 * Auth.gs – who is the current user and what may they do.
 *
 * Roles and areas come from SET_PEOPLE. Every API function checks these rules on the server;
 * the client only uses the same flags (permissionsFor_) to show or hide buttons.
 */

let CURRENT_USER_ = null; // memo for this server call

/**
 * The signed-in user.
 * @return {{email:string, known:boolean, inPeople:boolean, name:string, roles:string[],
 *           areas:string[], isKiosk:boolean}}
 */
function currentUser_() {
  if (CURRENT_USER_) return CURRENT_USER_;
  let email = '';
  try { email = normEmail_(Session.getActiveUser().getEmail()); } catch (e) { email = ''; }
  const person = email ? personByEmail_(email) : null;
  const roles = person ? person.roles : [];
  CURRENT_USER_ = {
    email: email,
    known: !!email,
    inPeople: !!person,
    name: person ? person.name : email,
    roles: roles,
    areas: person ? person.areas : [],
    isKiosk: roles.indexOf('KIOSK') >= 0
  };
  return CURRENT_USER_;
}

/** Blocks anonymous callers (empty e-mail). */
function requireIdentity_() {
  const u = currentUser_();
  if (!u.known) fail_('E_NO_IDENTITY');
  return u;
}

/** Owner of the script (running from the editor or a trigger) or an ADMIN. */
function isOwnerOrAdmin_() {
  let active = '';
  let effective = '';
  try { active = normEmail_(Session.getActiveUser().getEmail()); } catch (e) { active = ''; }
  try { effective = normEmail_(Session.getEffectiveUser().getEmail()); } catch (e) { effective = ''; }
  if (active && active === effective) return true;
  try { return hasRole_(currentUser_(), 'ADMIN'); } catch (e) { return false; }
}

/** For setup/seed/trigger installation: throws unless owner or admin. */
function requireOwnerOrAdmin_() {
  if (!isOwnerOrAdmin_()) throw new Error('Only the script owner or an ADMIN may run this.');
}

/** Trigger jobs: allowed for time triggers (no active user), the owner or an admin. */
function triggerCallerOk_() {
  let active = '';
  try { active = Session.getActiveUser().getEmail(); } catch (e) { active = ''; }
  return !active || isOwnerOrAdmin_();
}

// ---------------------------------------------------------------- basic checks

function hasRole_(u, role) { return u.roles.indexOf(role) >= 0; }
function hasAnyRole_(u, roles) { return roles.some(r => hasRole_(u, r)); }
function inArea_(u, area) {
  return u.areas.indexOf('*') >= 0 || u.areas.indexOf(up_(area)) >= 0;
}
function isAdmin_(u) { return hasRole_(u, 'ADMIN'); }
function isLocked_(q, part) { return splitList_(q.locked_parts).indexOf(part) >= 0; }

/** Adds parts to a locked_parts list: addLock_('QR', 'DECISION') … */
function addLock_(current) {
  const parts = splitList_(current);
  for (let i = 1; i < arguments.length; i++) if (parts.indexOf(arguments[i]) < 0) parts.push(arguments[i]);
  return parts.join(',');
}
function removeLock_(current, part) {
  return splitList_(current).filter(p => p !== part).join(',');
}

/** Role that decides and signs: SUPERVISOR on line level, APU_MANAGER on APU / PLANT level. */
function deciderRole_(q) {
  return q.level && q.level !== 'AREA' ? 'APU_MANAGER' : 'SUPERVISOR';
}

/** May sign ④ and the closure of this QRAP (the kiosk account never can). */
function isDecider_(u, q) {
  return u.known && !u.isKiosk && hasRole_(u, deciderRole_(q)) && inArea_(u, q.area_code);
}

function isQrapPilot_(u, pilots) {
  return (pilots || []).some(p => normEmail_(p.email) === u.email);
}

// ---------------------------------------------------------------- rules per section

/** Create a new QRAP in an area (line-level areas only). */
function canCreate_(u, area) {
  const a = areaByCode_(area);
  return !!a && a.level === 'AREA' && inArea_(u, area) &&
    hasAnyRole_(u, ['KIOSK', 'OPERATOR', 'TL', 'SUPERVISOR', 'ADMIN']);
}

/** Edit ①②③ until ④ is signed. */
function canEditQr_(u, q) {
  if (q.archived === true || QR_STATES.indexOf(q.status) < 0 || isLocked_(q, 'QR')) return false;
  if (isDecider_(u, q)) return true;
  return inArea_(u, q.area_code) && hasAnyRole_(u, ['KIOSK', 'OPERATOR', 'TL', 'SUPERVISOR', 'ADMIN']);
}

/** Quality may edit the ③ check data (checked / wrong / in progress). */
function canEditCheck_(u, q) {
  if (canEditQr_(u, q)) return true;
  return hasRole_(u, 'QUALITY') && q.archived !== true && QR_STATES.indexOf(q.status) >= 0 &&
    !isLocked_(q, 'QR');
}

/** Tick "shift informed" in ④ (before ④ is signed). */
function canShiftInfo_(u, q) {
  if (q.archived === true || isLocked_(q, 'DECISION')) return false;
  if ([ST.QR_OPEN, ST.WAIT_DECISION].indexOf(q.status) < 0) return false;
  return isDecider_(u, q) || (hasRole_(u, 'TL') && inArea_(u, q.area_code) && !u.isKiosk);
}

/** Sign the ④ decision. */
function canDecide_(u, q) {
  return q.status === ST.WAIT_DECISION && q.archived !== true && !isLocked_(q, 'DECISION') && isDecider_(u, q);
}

/** Edit ⑤ and ⑥ (assigned pilots and the decider). */
function canAnalyze_(u, q, pilots) {
  if (ANALYSIS_STATES.indexOf(q.status) < 0 || q.archived === true || isLocked_(q, 'ANALYSIS')) return false;
  if (u.isKiosk) return false;
  return isQrapPilot_(u, pilots) || isDecider_(u, q) || isAdmin_(u);
}

/** Edit one definitive action: analysts, or the action's own pilot. */
function canEditAction_(u, q, action, pilots) {
  if (canAnalyze_(u, q, pilots)) return true;
  return ANALYSIS_STATES.indexOf(q.status) >= 0 && q.archived !== true && !isLocked_(q, 'ANALYSIS') &&
    normEmail_(action.pilot_email) === u.email;
}

/** Add a note / review to an action: editors of the action, or the N+1 of its pilot. */
function canNoteAction_(u, q, action, pilots) {
  if (canEditAction_(u, q, action, pilots)) return true;
  const p = personByEmail_(action.pilot_email);
  return !!p && p.n1 === u.email && q.archived !== true;
}

/** Record an effectiveness slot (TL on the kiosk, TL, supervisor). */
function canEffect_(u, q) {
  if (q.status !== ST.VERIFY || q.archived === true) return false;
  return isDecider_(u, q) ||
    (inArea_(u, q.area_code) && hasAnyRole_(u, ['KIOSK', 'TL', 'SUPERVISOR']));
}

/** Sign the closure. */
function canClose_(u, q) {
  return q.status === ST.VERIFY && q.archived !== true && isDecider_(u, q);
}

/** ⑦ assessment (any state except DRAFT, never the kiosk). */
function canAssess_(u, q) {
  if (q.status === ST.DRAFT || !u.known || u.isKiosk) return false;
  return hasAnyRole_(u, ['SUPERVISOR', 'MANAGER', 'APU_MANAGER', 'QUALITY', 'ADMIN']) ||
    cfgBool_('ASSESSMENT_OPEN_TO_ALL');
}

/** Manager page. */
function canManager_(u) {
  return hasAnyRole_(u, ['MANAGER', 'APU_MANAGER', 'ADMIN']);
}

/**
 * All flags for one QRAP, used by the server guards and by the client buttons.
 * @return {Object} {editQr, editCheck, submit, shiftInfo, decide, analyze, effect, close, assess, admin, isPilot, isDecider}
 */
function permissionsFor_(u, q, pilots) {
  const editQr = canEditQr_(u, q);
  return {
    editQr: editQr,
    editCheck: canEditCheck_(u, q),
    submit: editQr && q.status === ST.DRAFT,
    shiftInfo: canShiftInfo_(u, q),
    decide: canDecide_(u, q),
    analyze: canAnalyze_(u, q, pilots),
    effect: canEffect_(u, q),
    close: canClose_(u, q),
    assess: canAssess_(u, q),
    admin: isAdmin_(u),
    isPilot: isQrapPilot_(u, pilots),
    isDecider: isDecider_(u, q)
  };
}


// ======================================================================
// Main.gs
// ======================================================================
/**
 * Main.gs – web app entry point, HTML include helper, bootstrap data and the API wrapper.
 *
 * Flow: the browser opens the /exec URL → doGet() renders Index.html with a bootstrap JSON →
 * Index.html includes the CSS and JS partials → the client router shows ?page=… →
 * views call api*() functions through google.script.run.
 */

/**
 * Web app entry point. All pages are one single-page app; ?page=… only chooses the first view.
 * Examples: ?page=board&area=WH1 · ?page=qrap&id=WH1-2026-9-14 · ?page=decide&id=… · ?page=manager
 * @param {Object} e request event (e.parameter = URL parameters)
 * @return {HtmlService.HtmlOutput}
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const tpl = HtmlService.createTemplateFromFile('Index');
  tpl.bootJson = safeJson_(bootstrap_(params));
  return tpl.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Used in Index.html: <?!= include('Styles') ?> inserts another HTML file. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Data the page needs before the first server call: user, settings, URL parameters. */
function bootstrap_(params) {
  const clean = {};
  Object.keys(params).forEach(k => { clean[k] = str_(params[k], 100); });
  try {
    const u = currentUser_();
    if (!u.known) return { error: 'E_NO_IDENTITY', params: clean };
    return {
      params: clean,
      user: userDto_(u),
      settings: clientSettings_(),
      appUrl: appUrl_(),
      appName: APP_NAME,
      serverNow: nowIso_()
    };
  } catch (err) {
    console.error('bootstrap failed: ' + (err && err.stack || err));
    return { error: 'E_BOOT', detail: String(err && err.message || err), params: clean };
  }
}

/** What the browser may know about the current user. */
function userDto_(u) {
  return {
    email: u.email, name: u.name, roles: u.roles, areas: u.areas, isKiosk: u.isKiosk,
    inPeople: u.inPeople,
    label: u.isKiosk ? 'Kiosek ' + (u.areas.filter(a => a !== '*')[0] || '') : u.name
  };
}

/** Settings for the browser (no badge numbers, only the config keys the client needs). */
function clientSettings_() {
  const s = getSettings_();
  return {
    config: {
      IDLE_MINUTES: cfgNum_('IDLE_MINUTES'),
      BOARD_CLOSED_DAYS: cfgNum_('BOARD_CLOSED_DAYS'),
      ASSESSMENT_OPEN_TO_ALL: cfgBool_('ASSESSMENT_OPEN_TO_ALL')
    },
    areas: s.areas,
    locations: s.locations,
    shifts: s.shifts.map(x => ({ code: x.code, name: x.name, start: x.start, end: x.end, days: x.days })),
    people: s.people.map(p => ({ name: p.name, email: p.email, roles: p.roles, areas: p.areas })),
    lists: s.lists
  };
}

// ---------------------------------------------------------------- API wrapper

/**
 * Standard body of every client-callable api*() function.
 *  - checks that the caller is identified
 *  - write = true → runs fn inside withWrite_ (lock + flush + e-mails)
 *  - AppError (fail_ / failMany_) → {ok:false, errors:[{code,…}], warnings:[…]}
 *  - other errors → logged, {ok:false, errors:[{code:'E_INTERNAL', detail}]}
 * The browser therefore always gets a plain object with an `ok` flag.
 * @param {Function} fn   returns a plain object (never Date objects)
 * @param {boolean=} write
 * @return {Object}
 */
function apiRun_(fn, write) {
  try {
    requireIdentity_();
    const out = write ? withWrite_(fn) : fn();
    if (out && out.ok === false) return out;
    return Object.assign({ ok: true }, out || {});
  } catch (err) {
    return errorResult_(err);
  }
}

/** Converts an exception into the {ok:false} shape. */
function errorResult_(err) {
  if (err && err.appErrors) {
    return { ok: false, errors: err.appErrors, warnings: err.appWarnings || [] };
  }
  const msg = String(err && err.message || err);
  if (/lock|timed out|Zámek/i.test(msg)) return { ok: false, errors: [{ code: 'E_BUSY' }] };
  console.error('API error: ' + (err && err.stack || msg));
  return { ok: false, errors: [{ code: 'E_INTERNAL', detail: truncate_(msg, 300) }] };
}

/**
 * Stops the call with one user-facing error. The client translates the code (I18n.html).
 * @param {string} code e.g. 'E_FORBIDDEN'
 * @param {Object=} params extra values for the message, e.g. {field:'what'}
 */
function fail_(code, params) {
  const e = new Error(code);
  e.appErrors = [Object.assign({ code: code }, params || {})];
  throw e;
}

/** Stops the call with several validation errors (and optional warnings). */
function failMany_(errors, warnings) {
  const e = new Error('validation');
  e.appErrors = errors;
  e.appWarnings = warnings || [];
  throw e;
}


// ======================================================================
// Qrap.gs
// ======================================================================
/**
 * Qrap.gs – loading a QRAP, the section rules, board chips, "čeká na" and the detail page data.
 */

/** Loads a QRAP row or stops with E_NOT_FOUND. */
function getQrapRow_(id) {
  const key = str_(id, 60);
  const q = key ? dbFirst_('QRAP', r => r.qrap_id === key) : null;
  if (!q) fail_('E_NOT_FOUND', { id: key });
  return q;
}

/** Child rows of one QRAP from a tab (uses the grouped memo). */
function childrenOf_(tab, qrapId) {
  return dbGroup_(tab, 'qrap_id')[qrapId] || [];
}
function activeAlerts_(id) { return childrenOf_('ALERT', id).filter(a => a.removed !== true); }
function activeIA_(id) { return childrenOf_('IMMEDIATE_ACTION', id).filter(a => a.status !== 'REMOVED'); }
function activePhotos_(id) { return childrenOf_('ATTACHMENT', id).filter(a => a.removed !== true); }
function activeActions_(id) { return childrenOf_('DEF_ACTION', id).filter(a => a.status !== 'REMOVED'); }

/** True when both photos exist or a written photo exception is given. */
function photosOk_(q) {
  const kinds = activePhotos_(q.qrap_id).map(p => p.kind);
  return (kinds.indexOf('WRONG') >= 0 && kinds.indexOf('CORRECT') >= 0) || str_(q.photo_exception).length >= 3;
}

/**
 * ③ rule: risk answered; if ANO the check data is filled and not in progress; ≥ 1 action and all
 * actions done; the process restored or not stopped.
 * @return {{complete:boolean, missing:string[]}}
 */
function section3State_(q, ia) {
  const missing = [];
  if (!q.risk_stock_shipped) missing.push('RISK');
  if (q.risk_stock_shipped === 'ANO') {
    if (q.check_in_progress === true) missing.push('CHECK_IN_PROGRESS');
    else if (q.checked_qty === '' || q.wrong_found_qty === '') missing.push('CHECK_DATA');
  }
  if (!ia.length) missing.push('NO_ACTION');
  else if (ia.some(a => !a.done_at)) missing.push('ACTION_OPEN');
  if (!q.process_stopped) missing.push('PROCESS');
  else if (q.process_stopped === 'ANO' && !q.restored_at) missing.push('NOT_RESTORED');
  return { complete: missing.length === 0, missing: missing };
}

/**
 * QR_OPEN → WAIT_DECISION when ③ becomes complete (and back if it becomes incomplete).
 * DRAFT rows are left alone: submit decides for them.
 */
function refreshContainment_(q) {
  const s3 = section3State_(q, activeIA_(q.qrap_id));
  if (q.status === ST.QR_OPEN && s3.complete) {
    dbUpdate_('QRAP', q, { status: ST.WAIT_DECISION, containment_done_at: nowIso_() });
  } else if (q.status === ST.WAIT_DECISION && !s3.complete) {
    dbUpdate_('QRAP', q, { status: ST.QR_OPEN, containment_done_at: '' });
  }
  return s3;
}

/** Current effectiveness round and its 5 slots (derived from the rows, no extra column). */
function effState_(rows) {
  const fails = rows.filter(r => r.result === 'NOT_EFFECTIVE');
  const round = fails.reduce((m, r) => Math.max(m, Number(r.round) || 1), 0) + 1;
  const current = rows.filter(r => Number(r.round) === round);
  const slots = [1, 2, 3, 4, 5].map(n => {
    const s = current.filter(r => Number(r.slot) === n);
    return s.length ? clientRow_(s[s.length - 1]) : null;
  });
  const okKeys = {};
  slots.forEach(s => { if (s && s.result === 'EFFECTIVE') okKeys[s.shift_date + '|' + s.shift_code] = true; });
  const distinctOk = Object.keys(okKeys).length;
  const reopenAt = fails.reduce((m, r) => (r.checked_at > m ? r.checked_at : m), '');
  return { round: round, slots: slots, distinctOk: distinctOk, allOk: distinctOk === 5, reopenAt: reopenAt };
}

/** An open definitive action whose planned day has passed. */
function isActionLate_(a, today) {
  return a.status === 'OPENED' && !!a.planned && a.planned < (today || todayStr_());
}

/**
 * Board chips 1–7. States: done | wait | late | todo | na.
 * @param {Object} q QRAP row
 * @param {{alerts:Array, why:Array, actions:Array, assess:Array}} c child rows (active only)
 * @param {Date} now
 * @return {string[]}
 */
function computeChips_(q, c, now) {
  const st = q.status;
  const t = now.getTime();
  const noAnalysis = st === ST.CLOSED_SOLVED || st === ST.ESCALATED;
  const inAnalysis = ANALYSIS_STATES.indexOf(st) >= 0 || st === ST.CLOSED;
  const chips = [];
  chips.push(q.s1_done_at ? 'done' : 'wait');
  chips.push(c.alerts.length ? 'done' : (q.s1_done_at ? 'wait' : 'todo'));
  if (q.containment_done_at) chips.push('done');
  else if (q.s1_done_at || st !== ST.DRAFT) {
    const det = q.detected_at ? new Date(q.detected_at).getTime() : 0;
    chips.push(det && t > det + 24 * 3600000 ? 'late' : 'wait');
  } else chips.push('todo');
  if (q.decision) chips.push('done');
  else if (st === ST.WAIT_DECISION) {
    const due = q.containment_done_at ? nextShiftStart_(new Date(q.containment_done_at)) : null;
    chips.push(due && now > due ? 'late' : 'wait');
  } else chips.push('todo');
  if (noAnalysis) chips.push('na');
  else if (inAnalysis) chips.push(c.why.some(w => w.is_root === true && w.text) ? 'done' : 'wait');
  else chips.push('todo');
  if (noAnalysis) chips.push('na');
  else if (st === ST.CLOSED) chips.push('done');
  else if (ANALYSIS_STATES.indexOf(st) >= 0) {
    const today = todayStr_(now);
    if (c.actions.some(a => isActionLate_(a, today))) chips.push('late');
    else chips.push(c.actions.length || st === ST.VERIFY ? 'wait' : 'todo');
  } else chips.push('todo');
  chips.push(c.assess.length ? 'done' : 'todo');
  return chips;
}

/** "Čeká na" code for the board (translated in the client). */
function waitingFor_(q) {
  switch (q.status) {
    case ST.DRAFT: return 'OPERATOR';
    case ST.QR_OPEN: return 'TL';
    case ST.WAIT_DECISION: return q.level && q.level !== 'AREA' ? 'APU' : 'SUPERVISOR';
    case ST.ANALYSIS:
    case ST.ACTIONS_OPEN: return 'PILOT';
    case ST.VERIFY: return 'VERIFY';
    case ST.ESCALATED: return 'APU';
    default: return '';
  }
}

/**
 * Closure checklist (VERIFY → CLOSED guards).
 * @return {{ok:boolean, items:{code:string, ok:boolean}[]}}
 */
function closureChecklist_(q) {
  const id = q.qrap_id;
  const acts = activeActions_(id);
  const eff = effState_(childrenOf_('EFFECTIVENESS', id));
  const items = [
    { code: 'C_STATUS', ok: q.status === ST.VERIFY },
    { code: 'C_ROOT', ok: childrenOf_('WHY_STEP', id).some(w => w.is_root === true && w.text) },
    { code: 'C_ACTIONS', ok: acts.length > 0 && acts.every(a => a.status === 'CLOSED') },
    { code: 'C_STD', ok: q.std_update === 'NE' || (q.std_update === 'ANO' && !!q.std_update_ref) },
    { code: 'C_EFF', ok: eff.allOk },
    { code: 'C_LEARNED', ok: !!str_(q.learned) }
  ];
  return { ok: items.every(i => i.ok), items: items, eff: eff };
}

/** The e-mail link to a page of this QRAP. */
function qrapLink_(page, id) {
  return appUrl_() + '?page=' + page + '&id=' + encodeURIComponent(id);
}

// ---------------------------------------------------------------- detail API

/**
 * Everything the detail, decision, analysis, effectiveness and assessment pages need.
 * @param {string} id QRAP number
 */
function apiGetQrap(id) {
  return apiRun_(() => ({ detail: qrapDetail_(id) }));
}

/** Builds the detail object (plain values only). */
function qrapDetail_(id) {
  const u = currentUser_();
  const q = getQrapRow_(id);
  const qid = q.qrap_id;
  const alerts = activeAlerts_(qid);
  const ia = activeIA_(qid);
  const pilots = childrenOf_('PILOT', qid);
  const why = childrenOf_('WHY_STEP', qid);
  const actions = childrenOf_('DEF_ACTION', qid);
  const notes = dbGroup_('ACTION_NOTE', 'action_id');
  const effRows = childrenOf_('EFFECTIVENESS', qid);
  const assess = childrenOf_('ASSESSMENT', qid).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  const today = todayStr_();
  const active = actions.filter(a => a.status !== 'REMOVED');
  const closure = closureChecklist_(q);
  return {
    q: clientRow_(q),
    alerts: alerts.map(clientRow_),
    ia: ia.map(clientRow_),
    photos: activePhotos_(qid).map(p => ({ file_id: p.file_id, thumb_file_id: p.thumb_file_id, kind: p.kind,
      uploaded_by: p.uploaded_by, uploaded_at: p.uploaded_at })),
    shiftInfo: childrenOf_('SHIFT_INFO', qid).map(clientRow_),
    pilots: pilots.map(p => ({ email: p.email, name: personName_(p.email), assigned_at: p.assigned_at })),
    why: why.map(clientRow_),
    actions: actions.map(a => Object.assign(clientRow_(a), {
      pilot_name: personName_(a.pilot_email),
      late: isActionLate_(a, today),
      canEdit: canEditAction_(u, q, a, pilots),
      canNote: canNoteAction_(u, q, a, pilots),
      notes: (notes[a.id] || []).map(clientRow_)
    })),
    eff: { round: closure.eff.round, slots: closure.eff.slots, distinctOk: closure.eff.distinctOk,
      history: effRows.map(clientRow_) },
    assess: assess.map(clientRow_),
    chips: computeChips_(q, { alerts: alerts, why: why, actions: active, assess: assess }, new Date()),
    waiting: waitingFor_(q),
    s3: section3State_(q, ia),
    photosOk: photosOk_(q),
    closure: { ok: closure.ok, items: closure.items },
    can: permissionsFor_(u, q, pilots),
    parentArea: (parentAreaOf_(q.area_code) || {}).code || '',
    links: { decide: qrapLink_('decide', qid), detail: qrapLink_('qrap', qid) }
  };
}


// ======================================================================
// Wizard.gs
// ======================================================================
/**
 * Wizard.gs – the kiosk wizard: 1 Popis · 2 Fotky · 3 Upozornění · 4 Opatření · 5 Kontrola a odeslání.
 *
 * Every "Další" calls apiSaveStep (mode 'next'): the step is validated on the server and saved.
 * "Dokončí TL později" uses mode 'later'; the idle timeout uses mode 'draft' (no validation for
 * DRAFT rows, so nothing typed is lost). apiSubmitQrap is the "Odeslat" button.
 */

/**
 * Saves one wizard step.
 * @param {{id?:string, area:string, step:number, mode:string, data:Object}} p
 * @return {{ok:boolean, id?:string, state?:Object, warnings?:Array, errors?:Array}}
 */
function apiSaveStep(p) {
  return apiRun_(() => saveStep_(p || {}), true);
}

/** Loads the wizard state of an existing QRAP (for "Pokračovat" and edits). */
function apiGetWizard(id) {
  return apiRun_(() => {
    const q = getQrapRow_(id);
    const u = currentUser_();
    if (!canEditQr_(u, q) && !canEditCheck_(u, q)) fail_('E_FORBIDDEN');
    return { state: wizardState_(q) };
  });
}

/** "Odeslat": DRAFT → QR_OPEN (and at once WAIT_DECISION if ③ is complete). */
function apiSubmitQrap(id) {
  return apiRun_(() => submitQrap_(id), true);
}

function saveStep_(p) {
  const u = currentUser_();
  const step = Number(p.step);
  const mode = ['next', 'later', 'draft'].indexOf(p.mode) >= 0 ? p.mode : 'next';
  const data = p.data || {};
  let q = p.id ? getQrapRow_(p.id) : null;
  let checkOnly = false;
  if (!q) {
    if (step !== 1) fail_('E_NO_ID');
    if (!canCreate_(u, p.area)) fail_('E_FORBIDDEN');
  } else if (!canEditQr_(u, q)) {
    if (step === 4 && canEditCheck_(u, q)) checkOnly = true;
    else fail_(isLocked_(q, 'QR') ? 'E_LOCKED' : 'E_FORBIDDEN');
  }
  // A sent QRAP must always stay valid: the lenient draft mode is only for DRAFT rows.
  const strict = mode !== 'draft' || (q && q.status !== ST.DRAFT);
  let res;
  if (step === 1) res = saveStep1_(q, up_(p.area), data, strict);
  else if (step === 2) res = saveStep2_(q, data, strict);
  else if (step === 3) res = saveStep3_(q, data, strict);
  else if (step === 4) res = saveStep4_(q, data, mode, strict, checkOnly);
  else fail_('E_STEP');
  return { id: res.q.qrap_id, warnings: res.warnings || [], state: wizardState_(res.q) };
}

/** The data the wizard needs to show a QRAP again. */
function wizardState_(q) {
  const u = currentUser_();
  return {
    q: clientRow_(q),
    alerts: activeAlerts_(q.qrap_id).map(clientRow_),
    ia: activeIA_(q.qrap_id).map(clientRow_),
    photos: activePhotos_(q.qrap_id).map(p => ({ file_id: p.file_id, thumb_file_id: p.thumb_file_id, kind: p.kind })),
    s3: section3State_(q, activeIA_(q.qrap_id)),
    can: { editQr: canEditQr_(u, q), editCheck: canEditCheck_(u, q) }
  };
}

// ---------------------------------------------------------------- step 1: ① popis

/** Cleans the step 1 values coming from the browser (types and lengths only). */
function cleanStep1_(d) {
  const how = up_(d.how_found);
  return {
    safety: yesNo_(d.safety),
    what: str_(d.what, 2000),
    how_found: how === 'OTHER' ? 'OTHER:' + str_(d.how_found_other, 200) : how,
    detected_at: isoOrBlank_(d.detected_at),
    zone: str_(d.zone, 100),
    location_code: str_(d.location_code, 100),
    origin_zone: str_(d.origin_zone, 100),
    qty: intOrBlank_(d.qty),
    unit: up_(d.unit),
    nok_situation: d.nok_situation === true,
    repeat_7d: yesNo_(d.repeat_7d),
    repeat_ref: yesNo_(d.repeat_7d) === 'ANO' ? str_(d.repeat_ref, 60) : '',
    finder_name: str_(d.finder_name, 100),
    finder_badge: str_(d.finder_badge, 40),
    material_no: str_(d.material_no, 60),
    hu_or_delivery_no: str_(d.hu_or_delivery_no, 60),
    supplier: str_(d.supplier, 100)
  };
}

/**
 * Server rules of ① (also used again at submit).
 * @param {Object} q merged row values
 * @return {{errors:Array, warnings:Array}}
 */
function validateStep1_(q) {
  const errors = [];
  const warnings = [];
  const req = field => errors.push({ code: 'E_REQUIRED', field: field });
  const now = Date.now();
  if (!q.safety) req('safety');
  if (!q.what) req('what');
  else if (q.what.length < 10) warnings.push({ code: 'W_WHAT_SHORT' });
  const how = String(q.how_found || '');
  if (!how) req('how_found');
  else if (how.indexOf('OTHER:') === 0) { if (how.length < 7) req('how_found_other'); }
  else if (listCodes_('HOW_FOUND').indexOf(how) < 0) errors.push({ code: 'E_INVALID', field: 'how_found' });
  if (!q.detected_at) req('detected_at');
  else {
    const det = new Date(q.detected_at).getTime();
    if (det > now + 5 * 60000) errors.push({ code: 'E_FUTURE', field: 'detected_at' });
    else if (det < now - 24 * 3600000) warnings.push({ code: 'W_OLD_DETECTION' });
  }
  if (!q.zone) req('zone');
  if (!q.location_code) req('location_code');
  if (q.qty === '' || q.qty === undefined) req('qty');
  else if (Number(q.qty) === 0 && q.nok_situation !== true) errors.push({ code: 'E_QTY_ZERO', field: 'qty' });
  if (Number(q.qty) > 0 && listCodes_('UNIT').indexOf(q.unit) < 0) req('unit');
  if (!q.repeat_7d) req('repeat_7d');
  else if (q.repeat_7d === 'ANO' && !repeatRefValid_(q)) errors.push({ code: 'E_REPEAT_REF', field: 'repeat_ref' });
  if (!q.finder_name && !q.finder_badge) req('finder_name');
  return { errors: errors, warnings: warnings };
}

/** The referenced QRAP must exist in the same area, within the 7 days before KDY. */
function repeatRefValid_(q) {
  const ref = str_(q.repeat_ref);
  if (!ref || ref === q.qrap_id) return false;
  const r = dbFirst_('QRAP', x => x.qrap_id === ref);
  if (!r || r.area_code !== q.area_code || !r.detected_at) return false;
  const det = q.detected_at ? new Date(q.detected_at).getTime() : Date.now();
  const refDet = new Date(r.detected_at).getTime();
  return refDet <= det + 60000 && refDet >= det - 7 * 24 * 3600000;
}

function saveStep1_(q, area, d, strict) {
  const v = cleanStep1_(d);
  if (!v.finder_name && v.finder_badge) {
    const p = personByBadge_(v.finder_badge);
    if (p) v.finder_name = p.name;
  }
  const merged = Object.assign({}, q || {}, v, { area_code: q ? q.area_code : area, qrap_id: q ? q.qrap_id : '' });
  const check = validateStep1_(merged);
  if (strict && check.errors.length) failMany_(check.errors, check.warnings);
  const valid = check.errors.length === 0;
  if (!q) {
    const idInfo = nextQrapId_(area);
    q = dbInsert_('QRAP', Object.assign({
      qrap_id: idInfo.id, area_code: area, level: 'AREA', seq: idInfo.seq, suffix: '', parent_id: '',
      status: ST.DRAFT, template_version: TEMPLATE_VERSION, locked_parts: '', archived: false
    }, v));
  } else {
    dbUpdate_('QRAP', q, v);
  }
  dbUpdate_('QRAP', q, { s1_done_at: valid ? (q.s1_done_at || nowIso_()) : '' });
  if (q.safety === 'ANO') mailE2_(q); // does not wait for "Odeslat"
  return { q: q, warnings: check.warnings };
}

// ---------------------------------------------------------------- step 2: fotky

function saveStep2_(q, d, strict) {
  const exception = str_(d.photo_exception, 500);
  dbUpdate_('QRAP', q, { photo_exception: exception });
  if (strict && !photosOk_(q)) failMany_([{ code: 'E_PHOTOS' }]);
  return { q: q };
}

// ---------------------------------------------------------------- step 3: ② kdo byl upozorněn

function saveStep3_(q, d, strict) {
  const valid = listCodes_('ALERT_ROLE');
  let roles = uniq_((d.roles || []).map(up_)).filter(r => valid.indexOf(r) >= 0);
  if (q.risk_stock_shipped === 'ANO' && roles.indexOf('QUALITY') < 0) roles.push('QUALITY');
  const otherText = str_(d.other_text, 200);
  if (strict) {
    const errors = [];
    if (!roles.length) errors.push({ code: 'E_ALERT_NONE' });
    if (roles.indexOf('OTHER') >= 0 && !otherText) errors.push({ code: 'E_REQUIRED', field: 'alert_other' });
    if (errors.length) failMany_(errors);
  }
  setAlerts_(q, roles, otherText);
  dbUpdate_('QRAP', q, { s2_done_at: roles.length ? (q.s2_done_at || nowIso_()) : '' });
  return { q: q };
}

/** Makes the active ALERT rows equal to `roles` (un-ticked rows get removed = TRUE). */
function setAlerts_(q, roles, otherText) {
  const current = activeAlerts_(q.qrap_id);
  current.forEach(a => {
    if (roles.indexOf(a.role_code) < 0) dbUpdate_('ALERT', a, { removed: true });
    else if (a.role_code === 'OTHER') dbUpdate_('ALERT', a, { other_text: otherText });
  });
  roles.forEach(code => {
    if (current.some(a => a.role_code === code)) return;
    dbInsert_('ALERT', {
      qrap_id: q.qrap_id, role_code: code, other_text: code === 'OTHER' ? otherText : '',
      notified_to: ROUTING_KEYS.indexOf(code) >= 0 ? route_(q.area_code, code).join(', ') : '',
      notified_at: nowIso_(), removed: false
    });
  });
}

// ---------------------------------------------------------------- step 4: ③ okamžitá opatření

function cleanStep4_(d) {
  return {
    risk_stock_shipped: yesNo_(d.risk_stock_shipped),
    checked_qty: intOrBlank_(d.checked_qty),
    wrong_found_qty: intOrBlank_(d.wrong_found_qty),
    check_in_progress: d.check_in_progress === true,
    process_stopped: yesNo_(d.process_stopped),
    restored_at: yesNo_(d.process_stopped) === 'ANO' ? isoOrBlank_(d.restored_at) : ''
  };
}

function cleanIaRows_(rows) {
  return (rows || []).slice(0, 30).map(r => ({
    id: str_(r.id, 40), type: up_(r.type), text: str_(r.text, 500), owner_name: str_(r.owner_name, 100),
    done_at: isoOrBlank_(r.done_at), remove: r.remove === true
  }));
}

/** Consistency rules of ③ (always checked unless the idle draft mode is used). */
function validateStep4_(q, v, rows) {
  const errors = [];
  if (!v.risk_stock_shipped) errors.push({ code: 'E_REQUIRED', field: 'risk_stock_shipped' });
  if (v.checked_qty !== '' && v.wrong_found_qty !== '' && v.wrong_found_qty > v.checked_qty) {
    errors.push({ code: 'E_WRONG_GT_CHECKED', field: 'wrong_found_qty' });
  }
  const det = q.detected_at ? new Date(q.detected_at).getTime() : 0;
  if (v.restored_at && det && new Date(v.restored_at).getTime() < det) {
    errors.push({ code: 'E_RESTORED_BEFORE', field: 'restored_at' });
  }
  const types = listCodes_('ACTION_TYPE');
  rows.filter(r => !r.remove).forEach((r, i) => {
    if (types.indexOf(r.type) < 0) errors.push({ code: 'E_IA_ROW', row: i + 1, field: 'type' });
    if (!r.text) errors.push({ code: 'E_IA_ROW', row: i + 1, field: 'text' });
    if (!r.owner_name) errors.push({ code: 'E_IA_ROW', row: i + 1, field: 'owner_name' });
    if (r.done_at) {
      const t = new Date(r.done_at).getTime();
      if (t > Date.now() + 5 * 60000) errors.push({ code: 'E_IA_DONE_FUTURE', row: i + 1 });
      else if (det && t < det) errors.push({ code: 'E_IA_DONE_BEFORE', row: i + 1 });
    }
  });
  return errors;
}

function saveStep4_(q, d, mode, strict, checkOnly) {
  let v = cleanStep4_(d);
  let rows = cleanIaRows_(d.actions);
  if (checkOnly) { // Quality: only the check data
    v = { checked_qty: v.checked_qty, wrong_found_qty: v.wrong_found_qty, check_in_progress: v.check_in_progress };
    rows = null;
  }
  if (strict) {
    const full = Object.assign({ risk_stock_shipped: q.risk_stock_shipped }, v);
    const errors = validateStep4_(q, full, rows || []);
    if (mode === 'next' && !errors.length && !checkOnly) {
      const preview = Object.assign({}, q, v);
      const iaPreview = rows.filter(r => !r.remove);
      const s3 = section3State_(preview, iaPreview);
      if (!s3.complete) errors.push({ code: 'E_S3_INCOMPLETE', missing: s3.missing });
    }
    if (errors.length) failMany_(errors);
  }
  dbUpdate_('QRAP', q, v);
  if (rows) saveIaRows_(q, rows);
  if (q.risk_stock_shipped && !q.s3_done_at) dbUpdate_('QRAP', q, { s3_done_at: nowIso_() });
  if (q.risk_stock_shipped === 'ANO') {
    const roles = activeAlerts_(q.qrap_id).map(a => a.role_code);
    if (roles.indexOf('QUALITY') < 0) {
      const other = (activeAlerts_(q.qrap_id).find(a => a.role_code === 'OTHER') || {}).other_text || '';
      setAlerts_(q, roles.concat(['QUALITY']), other);
    }
    mailE3_(q);
  }
  refreshContainment_(q);
  return { q: q };
}

/** Inserts / updates the immediate action rows ("removing" = status REMOVED). */
function saveIaRows_(q, rows) {
  const existing = childrenOf_('IMMEDIATE_ACTION', q.qrap_id);
  rows.forEach(r => {
    const owner = personByName_(r.owner_name);
    const values = {
      type: r.type, text: r.text, owner_name: r.owner_name, owner_email: owner ? owner.email : '',
      done_at: r.done_at, status: r.remove ? 'REMOVED' : (r.done_at ? 'DONE' : 'OPEN')
    };
    const row = r.id ? existing.find(x => x.id === r.id) : null;
    if (row) dbUpdate_('IMMEDIATE_ACTION', row, values);
    else if (!r.remove && (r.text || r.type)) {
      dbInsert_('IMMEDIATE_ACTION', Object.assign({ id: newId_('IA'), qrap_id: q.qrap_id }, values));
    }
  });
}

// ---------------------------------------------------------------- step 5: odeslat

function submitQrap_(id) {
  const u = currentUser_();
  const q = getQrapRow_(id);
  if (q.status !== ST.DRAFT) fail_('E_ALREADY_SENT');
  if (!canEditQr_(u, q)) fail_('E_FORBIDDEN');
  const errors = validateStep1_(q).errors.slice();
  if (!photosOk_(q)) errors.push({ code: 'E_PHOTOS' });
  if (!activeAlerts_(q.qrap_id).length) errors.push({ code: 'E_ALERT_NONE' });
  // ③ values saved by the idle draft mode were not validated yet: check them now.
  validateStep4_(q, q, activeIA_(q.qrap_id)).forEach(e => errors.push(e));
  if (errors.length) failMany_(errors);
  const now = nowIso_();
  dbUpdate_('QRAP', q, { status: ST.QR_OPEN, sent_at: now, s1_done_at: q.s1_done_at || now,
    s2_done_at: q.s2_done_at || now });
  refreshContainment_(q);
  mailE1_(q);
  if (q.safety === 'ANO') mailE2_(q);            // only if not sent yet (dedupe key)
  if (q.risk_stock_shipped === 'ANO') mailE3_(q); // only if not sent yet (dedupe key)
  return { id: q.qrap_id, status: q.status };
}

// ---------------------------------------------------------------- drafts and repeats

/** DRAFTs and QR_OPEN QRAPs of an area ("Pokračovat v rozpracovaném"). */
function apiGetDrafts(area) {
  return apiRun_(() => {
    const code = up_(area);
    const rows = dbWhere_('QRAP', q => q.area_code === code && q.archived !== true &&
      (q.status === ST.DRAFT || q.status === ST.QR_OPEN));
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { drafts: rows.map(q => ({ id: q.qrap_id, what: truncate_(q.what, 90), status: q.status,
      detected_at: q.detected_at, created_at: q.created_at, s1: !!q.s1_done_at, s2: !!q.s2_done_at,
      photos: photosOk_(q), risk: q.risk_stock_shipped })) };
  });
}

/**
 * Suggests QRAPs of the last 7 days in the same area that may be the same problem.
 * @param {{area:string, id?:string, material_no?:string, zone?:string, what?:string, detected_at?:string}} p
 */
function apiSuggestRepeats(p) {
  return apiRun_(() => {
    p = p || {};
    const area = up_(p.area);
    const det = parseDateTime_(p.detected_at) || new Date();
    const from = det.getTime() - 7 * 24 * 3600000;
    const words = str_(p.what, 500).toLowerCase().split(/[^a-zá-ž0-9]+/i).filter(w => w.length >= 4);
    const mat = str_(p.material_no).toLowerCase();
    const list = dbWhere_('QRAP', q => q.area_code === area && q.qrap_id !== p.id && q.detected_at &&
      new Date(q.detected_at).getTime() >= from && new Date(q.detected_at).getTime() <= det.getTime() + 60000)
      .map(q => {
        let score = 0;
        if (mat && String(q.material_no).toLowerCase() === mat) score += 3;
        if (p.zone && q.zone === p.zone) score += 1;
        const text = String(q.what).toLowerCase();
        words.forEach(w => { if (text.indexOf(w) >= 0) score += 1; });
        return { id: q.qrap_id, what: truncate_(q.what, 90), zone: q.zone, material_no: q.material_no,
          detected_at: q.detected_at, score: score };
      });
    list.sort((a, b) => b.score - a.score || (a.detected_at < b.detected_at ? 1 : -1));
    return { items: list.slice(0, 10) };
  });
}


// ======================================================================
// Board.gs
// ======================================================================
/**
 * Board.gs – the kiosk board: one row per QRAP, sorted by KDY ascending (newest at the bottom).
 *
 * All rows of an area are computed once and kept in CacheService for 60 seconds. Every write
 * (withWrite_) changes the global board version, which makes the cached rows invisible.
 */

const BOARD_TTL_SECONDS = 60;
const BOARD_FILTERS = ['open', 'today', 'safety', 'all'];

/**
 * Board rows for an area.
 * @param {{area:string, filter?:string, before?:string, limit?:number}} p
 *   before = key of the oldest row already shown (to load older rows when scrolling up)
 * @return {{ok, rows:Object[], hasMore:boolean, total:number, pending:number, area:string, at:string}}
 */
function apiGetBoard(p) {
  return apiRun_(() => {
    p = p || {};
    const area = up_(p.area);
    if (!areaByCode_(area)) fail_('E_AREA', { area: area });
    const filter = BOARD_FILTERS.indexOf(p.filter) >= 0 ? p.filter : 'open';
    const all = boardRowsCached_(area);
    let rows = all.filter(r => boardFilterMatch_(r, filter));
    const total = rows.length;
    if (p.before) rows = rows.filter(r => r.key < String(p.before));
    const limit = Math.min(Math.max(Number(p.limit) || 40, 5), 200);
    const hasMore = rows.length > limit;
    rows = rows.slice(-limit);
    const pending = all.filter(r => r.st === ST.DRAFT || r.st === ST.QR_OPEN).length;
    return { rows: rows, hasMore: hasMore, total: total, pending: pending, area: area, at: nowIso_() };
  });
}

function boardFilterMatch_(r, filter) {
  if (filter === 'today') return r.today;
  if (filter === 'safety') return r.safety;
  if (filter === 'all') return true;
  return r.open || r.recent; // 'open' = open + closed in the last BOARD_CLOSED_DAYS
}

/** Cached list of all non-archived board rows of an area. */
function boardRowsCached_(area) {
  const cache = CacheService.getScriptCache();
  const ver = cache.get('board_ver') || '0';
  const key = 'board_' + ver + '_' + area;
  const cached = cacheGetBig_(key);
  if (cached) return cached;
  const rows = buildBoardRows_(dbWhere_('QRAP', q => q.area_code === area && q.archived !== true));
  cachePutBig_(key, rows, BOARD_TTL_SECONDS);
  return rows;
}

/** Called after every write: old cached boards are no longer used. */
function invalidateBoardCache_() {
  try {
    CacheService.getScriptCache().put('board_ver', String(Date.now()), 21600);
  } catch (e) {
    console.warn('board cache invalidation failed: ' + e);
  }
}

/**
 * Builds board rows for a list of QRAP rows (bulk: every child tab is read once).
 * @param {Object[]} qraps
 * @return {Object[]} sorted by key (KDY, then number)
 */
function buildBoardRows_(qraps) {
  const g = {
    alerts: dbGroup_('ALERT', 'qrap_id'),
    why: dbGroup_('WHY_STEP', 'qrap_id'),
    actions: dbGroup_('DEF_ACTION', 'qrap_id'),
    assess: dbGroup_('ASSESSMENT', 'qrap_id')
  };
  const now = new Date();
  const ctx = {
    now: now,
    today: todayStr_(now),
    closedSince: now.getTime() - cfgNum_('BOARD_CLOSED_DAYS') * 24 * 3600000
  };
  return qraps.map(q => boardRow_(q, g, ctx)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One board row (short, plain values only). */
function boardRow_(q, g, ctx) {
  const id = q.qrap_id;
  const c = {
    alerts: (g.alerts[id] || []).filter(a => a.removed !== true),
    why: g.why[id] || [],
    actions: (g.actions[id] || []).filter(a => a.status !== 'REMOVED'),
    assess: g.assess[id] || []
  };
  const chips = computeChips_(q, c, ctx.now);
  const when = q.detected_at || q.created_at || '';
  const final = FINAL_STATES.indexOf(q.status) >= 0;
  return {
    id: id,
    key: when + '|' + id,
    area: q.area_code,
    level: q.level,
    what: truncate_(q.what, 110),
    zone: q.zone,
    loc: q.location_code,
    det: q.detected_at,
    st: q.status,
    safety: q.safety === 'ANO',
    rep: q.repeat_7d === 'ANO',
    chips: chips,
    wait: waitingFor_(q),
    late: chips.indexOf('late') >= 0,
    open: !final,
    recent: final && !!q.closed_at && new Date(q.closed_at).getTime() >= ctx.closedSince,
    today: !!when && todayStr_(new Date(when)) === ctx.today,
    parent: q.parent_id,
    copy: q.assign_ref
  };
}


// ======================================================================
// Decision.gs
// ======================================================================
/**
 * Decision.gs – ④ Rozhodnutí OJT on the supervisor's phone.
 *
 *  - "Informace všem směnám během 5' meetingu": one tick per active shift (who + when).
 *  - One decision: CONTINUE (Pokračovat s analýzou a 5 Proč), SOLVED (Problém vyřešen:
 *    ŽÁDNÉ 5 Proč) or ESCALATE (Eskalace na APU QRQC), then the signature.
 *  - The signature stores e-mail + time and locks ①–④.
 */

/**
 * Ticks "shift informed" for one shift.
 * @param {{id:string, shift_code:string}} p
 */
function apiSaveShiftInfo(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (!canShiftInfo_(u, q)) fail_(isLocked_(q, 'DECISION') ? 'E_LOCKED' : 'E_FORBIDDEN');
    const code = up_(p.shift_code);
    if (!getSettings_().shifts.some(s => s.code === code)) fail_('E_SHIFT');
    const exists = childrenOf_('SHIFT_INFO', q.qrap_id).some(r => r.shift_code === code);
    if (!exists) {
      dbInsert_('SHIFT_INFO', { qrap_id: q.qrap_id, shift_code: code, informed_by: u.email, informed_at: nowIso_() });
    }
    return { shiftInfo: childrenOf_('SHIFT_INFO', q.qrap_id).map(clientRow_) };
  }, true);
}

/**
 * Signs the decision.
 * @param {{id:string, decision:string, comment:string, pilots:string[], confirmWarnings:boolean}} p
 * @return {{ok:boolean, status?:string, copyId?:string, needConfirm?:boolean, warnings?:Array}}
 */
function apiSignDecision(p) {
  return apiRun_(() => signDecision_(p || {}), true);
}

function signDecision_(p) {
  const u = currentUser_();
  const q = getQrapRow_(p.id);
  if (u.isKiosk) fail_('E_KIOSK_SIGN');
  if (q.status !== ST.WAIT_DECISION) fail_('E_STATE', { status: q.status });
  if (!canDecide_(u, q)) fail_('E_FORBIDDEN');
  const decision = up_(p.decision);
  const comment = str_(p.comment, 2000);
  const check = decisionGuards_(q, decision, comment, p.pilots || []);
  if (check.errors.length) failMany_(check.errors, check.warnings);
  if (check.warnings.length && p.confirmWarnings !== true) {
    return { ok: false, needConfirm: true, warnings: check.warnings };
  }
  const now = nowIso_();
  const base = {
    decision: decision, decision_comment: comment, decided_by: u.email, decided_at: now,
    locked_parts: addLock_(q.locked_parts, 'QR', 'DECISION')
  };
  let copyId = '';
  if (decision === 'SOLVED') {
    dbUpdate_('QRAP', q, Object.assign(base, { status: ST.CLOSED_SOLVED, closed_by: u.email, closed_at: now }));
    mailE9_(q);
  } else if (decision === 'ESCALATE') {
    const copy = escalateQrap_(q);
    copyId = copy.qrap_id;
    dbUpdate_('QRAP', q, Object.assign(base, { status: ST.ESCALATED, assign_ref: copyId, closed_by: u.email,
      closed_at: now }));
    mailE6_(q, copy);
  } else {
    check.newPilots.forEach(email => {
      dbInsert_('PILOT', { qrap_id: q.qrap_id, email: email, assigned_by: u.email, assigned_at: now });
    });
    dbUpdate_('QRAP', q, Object.assign(base, { status: ST.ANALYSIS }));
    mailE5_(q, childrenOf_('PILOT', q.qrap_id).map(r => r.email), 'E5|' + q.qrap_id + '|' + now);
  }
  return { status: q.status, copyId: copyId };
}

/**
 * Guard rules of ④ (spec section 7).
 * @return {{errors:Array, warnings:Array, newPilots:string[]}}
 */
function decisionGuards_(q, decision, comment, pilots) {
  const errors = [];
  const warnings = [];
  let newPilots = [];
  if (DECISIONS.indexOf(decision) < 0) errors.push({ code: 'E_REQUIRED', field: 'decision' });
  if (!section3State_(q, activeIA_(q.qrap_id)).complete) errors.push({ code: 'E_S3_INCOMPLETE' });
  if (decision === 'SOLVED') {
    if (q.safety === 'ANO') errors.push({ code: 'E_SOLVED_SAFETY' });
    if (!comment) errors.push({ code: 'E_REQUIRED', field: 'decision_comment' });
    if (q.repeat_7d === 'ANO') warnings.push({ code: 'W_SOLVED_REPEAT' });
    if (Number(q.wrong_found_qty) > 0) warnings.push({ code: 'W_SOLVED_WRONG', n: q.wrong_found_qty });
  } else if (decision === 'ESCALATE') {
    if (!comment) errors.push({ code: 'E_REQUIRED', field: 'decision_comment' });
    if (!parentAreaOf_(q.area_code)) errors.push({ code: 'E_NO_PARENT' });
  } else if (decision === 'CONTINUE') {
    const existing = childrenOf_('PILOT', q.qrap_id).map(r => normEmail_(r.email));
    newPilots = uniq_(pilots.map(normEmail_)).filter(e => existing.indexOf(e) < 0);
    newPilots.forEach(e => {
      if (!personByEmail_(e)) errors.push({ code: 'E_PILOT_UNKNOWN', email: e });
    });
    if (existing.length + newPilots.length === 0) errors.push({ code: 'E_PILOT_REQUIRED', field: 'pilots' });
  }
  const informed = childrenOf_('SHIFT_INFO', q.qrap_id).map(r => r.shift_code);
  const missing = getSettings_().shifts.filter(s => informed.indexOf(s.code) < 0).map(s => s.code);
  if (missing.length) warnings.push({ code: 'W_SHIFTS', shifts: missing.join(', ') });
  return { errors: errors, warnings: warnings, newPilots: newPilots };
}


// ======================================================================
// Escalation.gs
// ======================================================================
/**
 * Escalation.gs – "Eskalace na APU QRQC".
 *
 * The line QRAP is closed (status ESCALATED) and a copy is created at the parent level
 * (SET_AREAS.parent_code). The copy gets the same number plus a suffix letter
 * (WH1-2026-9-14 → WH1-2026-9-14-A), parent_id = original, and the original gets
 * assign_ref = copy ("Assign Sheet #"). ①–③ and the photo links are copied.
 */

/** Fields of ①–③ copied to the escalated QRAP. */
const ESCALATION_COPY_FIELDS = ['safety', 'what', 'how_found', 'detected_at', 'zone', 'location_code',
  'origin_zone', 'qty', 'unit', 'nok_situation', 'repeat_7d', 'repeat_ref', 'finder_name', 'finder_badge',
  'material_no', 'hu_or_delivery_no', 'supplier', 'photo_exception', 'risk_stock_shipped', 'checked_qty',
  'wrong_found_qty', 'check_in_progress', 'process_stopped', 'restored_at', 's1_done_at', 's2_done_at',
  's3_done_at', 'sent_at', 'containment_done_at'];

/**
 * Creates the APU (or PLANT) copy of a QRAP. Runs inside withWrite_.
 * @param {Object} q the line-level QRAP row
 * @return {Object} the new QRAP row (status WAIT_DECISION)
 */
function escalateQrap_(q) {
  const parent = parentAreaOf_(q.area_code);
  if (!parent) fail_('E_NO_PARENT');
  const base = baseId_(q);
  const suffix = nextSuffix_(base);
  const data = {};
  ESCALATION_COPY_FIELDS.forEach(f => { data[f] = q[f]; });
  const copy = dbInsert_('QRAP', Object.assign(data, {
    qrap_id: base + '-' + suffix, area_code: parent.code, level: parent.level, seq: q.seq, suffix: suffix,
    parent_id: q.qrap_id, status: ST.WAIT_DECISION, template_version: q.template_version || TEMPLATE_VERSION,
    locked_parts: 'QR', archived: false
  }));
  activeAlerts_(q.qrap_id).forEach(a => dbInsert_('ALERT', {
    qrap_id: copy.qrap_id, role_code: a.role_code, other_text: a.other_text, notified_to: a.notified_to,
    notified_at: a.notified_at, removed: false
  }));
  activeIA_(q.qrap_id).forEach(a => dbInsert_('IMMEDIATE_ACTION', {
    id: newId_('IA'), qrap_id: copy.qrap_id, type: a.type, text: a.text, owner_name: a.owner_name,
    owner_email: a.owner_email, done_at: a.done_at, status: a.status
  }));
  activePhotos_(q.qrap_id).forEach(ph => dbInsert_('ATTACHMENT', {
    file_id: ph.file_id, thumb_file_id: ph.thumb_file_id, qrap_id: copy.qrap_id, kind: ph.kind,
    uploaded_by: ph.uploaded_by, uploaded_at: ph.uploaded_at, removed: false
  }));
  return copy;
}

/** Number without the suffix letter: WH1-2026-9-14-A → WH1-2026-9-14. */
function baseId_(q) {
  return q.suffix ? q.qrap_id.slice(0, q.qrap_id.length - String(q.suffix).length - 1) : q.qrap_id;
}

/** Next free suffix letter for a base number (A, B, C …). */
function nextSuffix_(base) {
  let max = 64; // char code before 'A'
  dbWhere_('QRAP', r => r.suffix && r.qrap_id.indexOf(base + '-') === 0).forEach(r => {
    const c = String(r.suffix).toUpperCase().charCodeAt(0);
    if (c > max) max = c;
  });
  if (max >= 90) fail_('E_SUFFIX');
  return String.fromCharCode(max + 1);
}

/**
 * Lists for the "Eskalace" page: APU-level and PLANT-level QRAPs and the escalated line QRAPs.
 * @return {{apu:Object[], plant:Object[], escalated:Object[]}}
 */
function apiGetEscalations() {
  return apiRun_(() => {
    const qs = dbWhere_('QRAP', q => q.archived !== true && (q.level !== 'AREA' || q.status === ST.ESCALATED));
    const rows = buildBoardRows_(qs);
    return {
      apu: rows.filter(r => r.level === 'APU'),
      plant: rows.filter(r => r.level === 'PLANT'),
      escalated: rows.filter(r => r.level === 'AREA' || !r.level)
    };
  });
}


// ======================================================================
// Analysis.gs
// ======================================================================
/**
 * Analysis.gs – ⑤ PŘÍČINA 5 Proč? and the single fields of ⑥ (lesson, standard question).
 *
 * WHY_STEP rows: chain OCCURRENCE ("Proč to vzniklo?") and optional NON_DETECTION
 * ("Proč to nebylo zachyceno?"), steps 1–5, one step per chain may be the root cause.
 * The status moves automatically (recomputeAnalysisStatus_):
 *   ANALYSIS → ACTIONS_OPEN (root cause + ≥ 1 action) → VERIFY (all actions CLOSED).
 */

const WHY_CHAINS = ['OCCURRENCE', 'NON_DETECTION'];

/**
 * Saves ⑤ and the lesson / standard fields of ⑥.
 * @param {{id:string, why:{OCCURRENCE:string[], NON_DETECTION:string[]},
 *          root:{OCCURRENCE:number, NON_DETECTION:number}, learned:string,
 *          std_update:string, std_update_ref:string}} p
 * @return {{ok, warnings:Array, status:string}}
 */
function apiSaveAnalysis(p) {
  return apiRun_(() => saveAnalysis_(p || {}), true);
}

function saveAnalysis_(p) {
  const u = currentUser_();
  const q = getQrapRow_(p.id);
  if (!canAnalyze_(u, q, childrenOf_('PILOT', q.qrap_id))) fail_(isLocked_(q, 'ANALYSIS') ? 'E_LOCKED' : 'E_FORBIDDEN');
  const errors = [];
  const warnings = [];
  const chains = {};
  const roots = {};
  WHY_CHAINS.forEach(chain => {
    const texts = ((p.why || {})[chain] || []).slice(0, 5).map(t => str_(t, 1000));
    while (texts.length < 5) texts.push('');
    const lastFilled = texts.reduce((m, t, i) => (t ? i + 1 : m), 0);
    for (let i = 0; i < lastFilled; i++) {
      if (!texts[i]) errors.push({ code: 'E_WHY_GAP', chain: chain, step: i + 1 });
    }
    const root = Number((p.root || {})[chain]) || 0;
    if (root && (root < 1 || root > 5 || !texts[root - 1])) errors.push({ code: 'E_ROOT_INVALID', chain: chain });
    chains[chain] = texts;
    roots[chain] = root;
  });
  const std = yesNo_(p.std_update);
  const stdRef = std === 'ANO' ? str_(p.std_update_ref, 300) : '';
  if (std === 'ANO' && !stdRef) errors.push({ code: 'E_REQUIRED', field: 'std_update_ref' });
  if (errors.length) failMany_(errors);

  saveWhySteps_(q, chains, roots);
  dbUpdate_('QRAP', q, { learned: str_(p.learned, 2000), std_update: std, std_update_ref: stdRef });
  syncStdAction_(q, u);
  recomputeAnalysisStatus_(q);

  const filled = chains.OCCURRENCE.filter(Boolean).length;
  if (filled < 3) warnings.push({ code: 'W_FEW_WHYS', n: filled });
  if (!roots.OCCURRENCE && !roots.NON_DETECTION) warnings.push({ code: 'W_NO_ROOT' });
  if (!q.learned) warnings.push({ code: 'W_LEARNED_EMPTY' });
  return { warnings: warnings, status: q.status };
}

/** Upserts the WHY_STEP rows (rows are never deleted; an empty text clears a step). */
function saveWhySteps_(q, chains, roots) {
  const existing = childrenOf_('WHY_STEP', q.qrap_id);
  WHY_CHAINS.forEach(chain => {
    for (let step = 1; step <= 5; step++) {
      const text = chains[chain][step - 1];
      const isRoot = roots[chain] === step;
      const row = existing.find(r => r.chain === chain && Number(r.step) === step);
      if (row) dbUpdate_('WHY_STEP', row, { text: text, is_root: isRoot });
      else if (text) dbInsert_('WHY_STEP', { qrap_id: q.qrap_id, chain: chain, step: step, text: text, is_root: isRoot });
    }
  });
}

/**
 * "Příležitost k aktualizaci STANDARDU?" = ANO creates the action "Aktualizovat standard"
 * (root_step STD). Changing the answer to NE removes it while it is still open.
 */
function syncStdAction_(q, u) {
  const std = activeActions_(q.qrap_id).find(a => a.root_step === 'STD');
  if (q.std_update === 'ANO') {
    const text = 'Aktualizovat standard: ' + q.std_update_ref;
    if (!std) {
      const pilot = (childrenOf_('PILOT', q.qrap_id)[0] || {}).email || u.email;
      const planned = addDaysStr_(todayStr_(), 7);
      const a = dbInsert_('DEF_ACTION', {
        id: newId_('DA'), qrap_id: q.qrap_id, root_step: 'STD', text: text, pilot_email: pilot,
        planned: planned, planned_first: planned, done: '', status: 'OPENED', evidence_url: ''
      });
      mailE5b_(q, a);
    } else if (std.status === 'OPENED') {
      dbUpdate_('DEF_ACTION', std, { text: text });
    }
  } else if (std && std.status === 'OPENED') {
    dbUpdate_('DEF_ACTION', std, { status: 'REMOVED' });
  }
}

/**
 * Moves the status between ANALYSIS, ACTIONS_OPEN and VERIFY from the data.
 * After a NOT_EFFECTIVE round, only actions created after that moment count for leaving ANALYSIS.
 */
function recomputeAnalysisStatus_(q) {
  if (ANALYSIS_STATES.indexOf(q.status) < 0) return;
  const id = q.qrap_id;
  const hasRoot = childrenOf_('WHY_STEP', id).some(w => w.is_root === true && w.text);
  const acts = activeActions_(id);
  const eff = effState_(childrenOf_('EFFECTIVENESS', id));
  const roundActs = eff.reopenAt ? acts.filter(a => a.created_at > eff.reopenAt) : acts;
  let next = ST.ANALYSIS;
  if (hasRoot && (q.status !== ST.ANALYSIS || roundActs.length) && acts.length) {
    next = acts.every(a => a.status === 'CLOSED') ? ST.VERIFY : ST.ACTIONS_OPEN;
  }
  if (!hasRoot || !acts.length) next = ST.ANALYSIS;
  if (next !== q.status) dbUpdate_('QRAP', q, { status: next });
}

/**
 * A decider adds a pilot during the analysis (a saved pilot can't be removed).
 * @param {{id:string, email:string}} p
 */
function apiAddPilot(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (ANALYSIS_STATES.indexOf(q.status) < 0 || !(isDecider_(u, q) || isAdmin_(u))) fail_('E_FORBIDDEN');
    const email = normEmail_(p.email);
    if (!personByEmail_(email)) fail_('E_PILOT_UNKNOWN', { email: email });
    const exists = childrenOf_('PILOT', q.qrap_id).some(r => normEmail_(r.email) === email);
    if (!exists) {
      dbInsert_('PILOT', { qrap_id: q.qrap_id, email: email, assigned_by: u.email, assigned_at: nowIso_() });
      mailE5_(q, [email], 'E5|' + q.qrap_id + '|' + email);
    }
    return { pilots: childrenOf_('PILOT', q.qrap_id).map(r => ({ email: r.email, name: personName_(r.email) })) };
  }, true);
}


// ======================================================================
// Actions.gs
// ======================================================================
/**
 * Actions.gs – ⑥ Konečné akce (definitive actions), notes / review dates and "Moje akce".
 *
 * Status: OPENED → CLOSED (a done date closes the action) · REMOVED (never deleted).
 * planned_first keeps the first planned date; every later change is in AUDIT_LOG.
 */

/**
 * Creates or updates a definitive action.
 * @param {{id?:string, qrap_id?:string, text:string, root_step:string, pilot_email:string,
 *          planned:string, done:string, evidence_url:string}} p
 * @return {{ok, action:Object, status:string}}
 */
function apiSaveDefAction(p) {
  return apiRun_(() => saveDefAction_(p || {}), true);
}

function saveDefAction_(p) {
  const u = currentUser_();
  const a = p.id ? dbFirst_('DEF_ACTION', r => r.id === p.id) : null;
  if (p.id && !a) fail_('E_NOT_FOUND', { id: p.id });
  const q = getQrapRow_(a ? a.qrap_id : p.qrap_id);
  const pilots = childrenOf_('PILOT', q.qrap_id);
  const full = canAnalyze_(u, q, pilots); // may change every field
  if (a ? !canEditAction_(u, q, a, pilots) : !full) fail_(isLocked_(q, 'ANALYSIS') ? 'E_LOCKED' : 'E_FORBIDDEN');
  if (a && a.status === 'REMOVED') fail_('E_ACTION_REMOVED');

  // A field that is not sent keeps its current value (e.g. "Hotovo" in Moje akce sends only the done date).
  const pick = (k, clean) => (p[k] === undefined && a ? a[k] : clean(p[k]));
  const v = {
    text: pick('text', x => str_(x, 1000)),
    root_step: pick('root_step', up_),
    pilot_email: pick('pilot_email', normEmail_),
    planned: pick('planned', dateStr_),
    done: pick('done', dateStr_),
    evidence_url: pick('evidence_url', x => str_(x, 500))
  };
  if (a && a.root_step === 'STD') v.root_step = 'STD';
  if (!full) { // the action owner only closes the action and adds evidence
    ['text', 'root_step', 'pilot_email', 'planned'].forEach(k => { v[k] = a[k]; });
  }
  const errors = validateDefAction_(q, a, v);
  if (errors.length) failMany_(errors);

  v.status = v.done ? 'CLOSED' : 'OPENED';
  let action = a;
  if (!a) {
    action = dbInsert_('DEF_ACTION', Object.assign({ id: newId_('DA'), qrap_id: q.qrap_id, planned_first: v.planned }, v));
    mailE5b_(q, action);
  } else {
    const pilotChanged = normEmail_(a.pilot_email) !== v.pilot_email;
    dbUpdate_('DEF_ACTION', a, v);
    if (pilotChanged) mailE5b_(q, a);
  }
  recomputeAnalysisStatus_(q);
  return { action: clientRow_(action), status: q.status };
}

/** Rules of one action row. */
function validateDefAction_(q, a, v) {
  const errors = [];
  const today = todayStr_();
  if (!v.text) errors.push({ code: 'E_REQUIRED', field: 'action_text' });
  if (v.root_step !== 'STD') {
    const m = v.root_step.match(/^([ON])([1-5])$/);
    const chain = m && m[1] === 'O' ? 'OCCURRENCE' : 'NON_DETECTION';
    const ok = m && childrenOf_('WHY_STEP', q.qrap_id).some(w => w.chain === chain && Number(w.step) === Number(m[2]) && w.text);
    if (!ok) errors.push({ code: 'E_ROOT_STEP', field: 'root_step' });
  }
  const person = personByEmail_(v.pilot_email);
  if (!person) errors.push({ code: 'E_PILOT_UNKNOWN', field: 'pilot_email', email: v.pilot_email });
  if (!v.planned) errors.push({ code: 'E_REQUIRED', field: 'planned' });
  else if (!a && v.planned < today) errors.push({ code: 'E_PLANNED_PAST', field: 'planned' });
  if (v.done && v.done > today) errors.push({ code: 'E_DONE_FUTURE', field: 'done' });
  if (v.evidence_url && !/^https:\/\//i.test(v.evidence_url)) errors.push({ code: 'E_URL', field: 'evidence_url' });
  return errors;
}

/** "Odebrat": status REMOVED (the row stays). */
function apiRemoveDefAction(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const a = dbFirst_('DEF_ACTION', r => r.id === p.id);
    if (!a) fail_('E_NOT_FOUND', { id: p.id });
    const q = getQrapRow_(a.qrap_id);
    if (!canAnalyze_(u, q, childrenOf_('PILOT', q.qrap_id))) fail_('E_FORBIDDEN');
    dbUpdate_('DEF_ACTION', a, { status: 'REMOVED' });
    if (a.root_step === 'STD' && q.std_update === 'ANO') {
      dbUpdate_('QRAP', q, { std_update: '', std_update_ref: '' }); // the question must be answered again
    }
    recomputeAnalysisStatus_(q);
    return { status: q.status };
  }, true);
}

/**
 * Adds a note to an action, optionally with a review date.
 * @param {{action_id:string, note:string, review_date?:string}} p
 */
function apiAddActionNote(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const a = dbFirst_('DEF_ACTION', r => r.id === p.action_id);
    if (!a) fail_('E_NOT_FOUND', { id: p.action_id });
    const q = getQrapRow_(a.qrap_id);
    if (!canNoteAction_(u, q, a, childrenOf_('PILOT', q.qrap_id))) fail_('E_FORBIDDEN');
    const note = str_(p.note, 1000);
    if (!note) failMany_([{ code: 'E_REQUIRED', field: 'note' }]);
    // qrap_id is not a column of ACTION_NOTE; it is only used to label the audit log entry.
    const row = dbInsert_('ACTION_NOTE', { id: newId_('AN'), action_id: a.id, note: note,
      review_date: dateStr_(p.review_date), review_done: false, author: u.email, at: nowIso_(), qrap_id: a.qrap_id });
    return { note: clientRow_(row) };
  }, true);
}

/** Marks a review as done (or not done). */
function apiSetReviewDone(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const n = dbFirst_('ACTION_NOTE', r => r.id === p.note_id);
    if (!n) fail_('E_NOT_FOUND', { id: p.note_id });
    const a = dbFirst_('DEF_ACTION', r => r.id === n.action_id);
    const q = getQrapRow_(a.qrap_id);
    if (!canNoteAction_(u, q, a, childrenOf_('PILOT', q.qrap_id))) fail_('E_FORBIDDEN');
    dbUpdate_('ACTION_NOTE', n, { review_done: p.done === true });
    return { note: clientRow_(n) };
  }, true);
}

/**
 * "Moje akce": the user's actions (scope mine) or the actions of the people whose N+1 the user is
 * (scope team).
 * @param {{scope:string, status:string, due:string}} f  status: OPENED|CLOSED|REMOVED|ALL; due: all|late|week
 */
function apiGetMyActions(f) {
  return apiRun_(() => {
    f = f || {};
    const u = currentUser_();
    const team = getSettings_().people.filter(p => p.n1 === u.email).map(p => p.email).filter(Boolean);
    const scope = f.scope === 'team' ? 'team' : 'mine';
    const owners = scope === 'team' ? team : [u.email];
    const today = todayStr_();
    const weekEnd = addDaysStr_(today, 7);
    const status = ['OPENED', 'CLOSED', 'REMOVED', 'ALL'].indexOf(f.status) >= 0 ? f.status : 'OPENED';
    const notes = dbGroup_('ACTION_NOTE', 'action_id');
    const qraps = dbGroup_('QRAP', 'qrap_id');
    const list = dbWhere_('DEF_ACTION', a => owners.indexOf(normEmail_(a.pilot_email)) >= 0)
      .filter(a => status === 'ALL' || a.status === status)
      .filter(a => f.due === 'late' ? isActionLate_(a, today) : f.due === 'week' ? (a.status === 'OPENED' && a.planned <= weekEnd) : true)
      .map(a => {
        const q = (qraps[a.qrap_id] || [])[0] || {};
        const pilots = q.qrap_id ? childrenOf_('PILOT', q.qrap_id) : [];
        return Object.assign(clientRow_(a), {
          pilot_name: personName_(a.pilot_email),
          late: isActionLate_(a, today),
          qrap: { id: q.qrap_id, what: truncate_(q.what, 90), status: q.status, area: q.area_code },
          canEdit: q.qrap_id ? canEditAction_(u, q, a, pilots) : false,
          canNote: q.qrap_id ? canNoteAction_(u, q, a, pilots) : false,
          notes: (notes[a.id] || []).map(clientRow_)
        });
      });
    list.sort((x, y) => (x.planned < y.planned ? -1 : 1));
    return { actions: list, hasTeam: team.length > 0, scope: scope };
  });
}


// ======================================================================
// Effectiveness.gs
// ======================================================================
/**
 * Effectiveness.gs – "Efektivita zkontrolována na 5 směnách bez chyb" and the closure signature.
 *
 *  - 5 slots per round. EFFECTIVE slots must be on 5 different shifts (date + shift unique).
 *  - NOT_VERIFIED can be overwritten later. EFFECTIVE is final.
 *  - NOT_EFFECTIVE ends the round: round + 1, back to ANALYSIS, pilots + decider notified (E11).
 *  - Closure (VERIFY → CLOSED) only when closureChecklist_ passes; it locks ⑤⑥ and sends E9.
 */

/**
 * Records one slot.
 * @param {{id:string, slot:number, shift_date:string, shift_code:string, result:string, checked_by?:string}} p
 * @return {{ok, status:string, round:number}}
 */
function apiSaveEffect(p) {
  return apiRun_(() => saveEffect_(p || {}), true);
}

function saveEffect_(p) {
  const u = currentUser_();
  const q = getQrapRow_(p.id);
  if (!canEffect_(u, q)) fail_(q.status !== ST.VERIFY ? 'E_STATE' : 'E_FORBIDDEN', { status: q.status });
  const rows = childrenOf_('EFFECTIVENESS', q.qrap_id);
  const eff = effState_(rows);
  const slot = Number(p.slot);
  const date = dateStr_(p.shift_date);
  const shift = up_(p.shift_code);
  const result = up_(p.result);
  const checkedBy = u.isKiosk ? str_(p.checked_by, 100) : u.name;
  const errors = [];
  if (!(slot >= 1 && slot <= 5)) errors.push({ code: 'E_SLOT' });
  if (!date) errors.push({ code: 'E_REQUIRED', field: 'shift_date' });
  else if (date > todayStr_()) errors.push({ code: 'E_SHIFT_FUTURE', field: 'shift_date' });
  if (!getSettings_().shifts.some(s => s.code === shift)) errors.push({ code: 'E_SHIFT', field: 'shift_code' });
  if (EFF_RESULTS.indexOf(result) < 0) errors.push({ code: 'E_REQUIRED', field: 'result' });
  if (!checkedBy) errors.push({ code: 'E_REQUIRED', field: 'checked_by' });
  const current = eff.slots[slot - 1];
  if (current && current.result === 'EFFECTIVE') errors.push({ code: 'E_SLOT_FINAL' });
  if (result === 'EFFECTIVE' && eff.slots.some((s, i) => s && i !== slot - 1 && s.result === 'EFFECTIVE' &&
      s.shift_date === date && s.shift_code === shift)) {
    errors.push({ code: 'E_SHIFT_DUP' });
  }
  if (errors.length) failMany_(errors);

  const values = { shift_date: date, shift_code: shift, result: result, checked_by: checkedBy, checked_at: nowIso_() };
  const existing = rows.find(r => Number(r.round) === eff.round && Number(r.slot) === slot);
  if (existing) dbUpdate_('EFFECTIVENESS', existing, values); // only NOT_VERIFIED rows reach this point
  else dbInsert_('EFFECTIVENESS', Object.assign({ qrap_id: q.qrap_id, round: eff.round, slot: slot }, values));

  if (result === 'NOT_EFFECTIVE') {
    dbUpdate_('QRAP', q, { status: ST.ANALYSIS });
    mailE11_(q, eff.round);
  }
  return { status: q.status, round: effState_(childrenOf_('EFFECTIVENESS', q.qrap_id)).round };
}

/**
 * Closure signature ("Uzavření QRAP schváleno Supervizorem").
 * @param {{id:string}} p
 */
function apiSignClosure(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (u.isKiosk) fail_('E_KIOSK_SIGN');
    if (!canClose_(u, q)) fail_(q.status !== ST.VERIFY ? 'E_STATE' : 'E_FORBIDDEN', { status: q.status });
    const check = closureChecklist_(q);
    if (!check.ok) {
      failMany_([{ code: 'E_CLOSURE', items: check.items.filter(i => !i.ok).map(i => i.code) }]);
    }
    const now = nowIso_();
    dbUpdate_('QRAP', q, { status: ST.CLOSED, closed_by: u.email, closed_at: now,
      locked_parts: addLock_(q.locked_parts, 'ANALYSIS') });
    mailE9_(q);
    return { status: q.status };
  }, true);
}


// ======================================================================
// Assessment.gs
// ======================================================================
/**
 * Assessment.gs – ⑦ Hodnocení QRQC.
 *
 * Five criteria, each OK / NOK / NA:
 *  1 RED BOX · 2 ROZDĚLENÍ · 3 POROVNÁNÍ · 4 POUČENÍ A SDÍLENÍ · 5 ON JOB TRAINING
 * plus "OJT s kým", feedback text and type. The assessor and time are automatic.
 * Every assessment is kept (the detail page shows the latest first).
 */

/**
 * Saves a new assessment.
 * @param {{id:string, c1:string, c2:string, c3:string, c4:string, c5:string,
 *          ojt_with:string, feedback:string, feedback_type:string}} p
 */
function apiSaveAssessment(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (!canAssess_(u, q)) fail_(q.status === ST.DRAFT ? 'E_STATE' : 'E_FORBIDDEN', { status: q.status });
    const errors = [];
    const values = {};
    ['c1', 'c2', 'c3', 'c4', 'c5'].forEach(c => {
      values[c] = up_(p[c]);
      if (ASSESS_VALUES.indexOf(values[c]) < 0) errors.push({ code: 'E_CRITERIA', field: c });
    });
    const type = up_(p.feedback_type);
    if (type && FEEDBACK_TYPES.indexOf(type) < 0) errors.push({ code: 'E_INVALID', field: 'feedback_type' });
    const feedback = str_(p.feedback, 2000);
    if (!feedback) errors.push({ code: 'E_REQUIRED', field: 'feedback' });
    if (errors.length) failMany_(errors);
    const row = dbInsert_('ASSESSMENT', Object.assign(values, {
      id: newId_('AS'), qrap_id: q.qrap_id, assessor: u.email, at: nowIso_(),
      ojt_with: str_(p.ojt_with, 100), feedback: feedback, feedback_type: type
    }));
    return { assessment: clientRow_(row) };
  }, true);
}


// ======================================================================
// Photos.gs
// ======================================================================
/**
 * Photos.gs – Foto ŠPATNĚ / Foto SPRÁVNĚ (and documents) in Google Drive.
 *
 * The browser resizes the picture first (full ≤ 1600 px, thumbnail ≤ 400 px, JPEG) and sends
 * base64 text. Files go to PHOTO_FOLDER_ID / {qrap_id} /. Users never open Drive directly:
 * apiGetPhoto returns base64, and only for files listed in the ATTACHMENT tab.
 */

const PHOTO_KINDS = ['WRONG', 'CORRECT', 'DOC'];
const PHOTO_MAX_B64 = 8 * 1024 * 1024; // about 6 MB of image data

/**
 * Uploads one photo (full + thumbnail).
 * @param {{qrapId:string, kind:string, full:string, thumb:string}} p base64 without the data: prefix
 * @return {{ok, photo:{file_id, thumb_file_id, kind}}}
 */
function apiUploadPhoto(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.qrapId);
    const kind = up_(p.kind);
    if (PHOTO_KINDS.indexOf(kind) < 0) fail_('E_PHOTO_KIND');
    const pilots = childrenOf_('PILOT', q.qrap_id);
    const allowed = kind === 'DOC' ? (canEditQr_(u, q) || canAnalyze_(u, q, pilots)) : canEditQr_(u, q);
    if (!allowed) fail_('E_FORBIDDEN');
    const full = String(p.full || '');
    const thumb = String(p.thumb || '');
    if (!full || !thumb || full.length > PHOTO_MAX_B64 || thumb.length > PHOTO_MAX_B64) fail_('E_PHOTO_SIZE');

    const folder = qrapFolder_(q.qrap_id);
    const stamp = fmt_(new Date(), 'yyyyMMdd-HHmmss');
    const base = q.qrap_id + '_' + kind + '_' + stamp;
    const fullFile = folder.createFile(Utilities.newBlob(Utilities.base64Decode(full), 'image/jpeg', base + '.jpg'));
    const thumbFile = folder.createFile(Utilities.newBlob(Utilities.base64Decode(thumb), 'image/jpeg', base + '_thumb.jpg'));

    if (kind !== 'DOC') { // one active photo per kind: the older one is marked removed
      activePhotos_(q.qrap_id).filter(a => a.kind === kind).forEach(a => dbUpdate_('ATTACHMENT', a, { removed: true }));
    }
    const row = dbInsert_('ATTACHMENT', {
      file_id: fullFile.getId(), thumb_file_id: thumbFile.getId(), qrap_id: q.qrap_id, kind: kind,
      uploaded_by: u.email, uploaded_at: nowIso_(), removed: false
    });
    return { photo: { file_id: row.file_id, thumb_file_id: row.thumb_file_id, kind: kind } };
  }, true);
}

/** Drive folder PHOTO_FOLDER_ID / {qrap_id} (created when missing). */
function qrapFolder_(qrapId) {
  const rootId = cfg_('PHOTO_FOLDER_ID');
  if (!rootId) fail_('E_NO_PHOTO_FOLDER');
  let root;
  try { root = DriveApp.getFolderById(rootId); } catch (e) { fail_('E_NO_PHOTO_FOLDER'); }
  const it = root.getFoldersByName(qrapId);
  return it.hasNext() ? it.next() : root.createFolder(qrapId);
}

/**
 * Returns a photo as base64 so users need no Drive access.
 * @param {{fileId:string, size:string}} p size: 'thumb' | 'full'
 * @return {{ok, mime:string, data:string}}
 */
function apiGetPhoto(p) {
  return apiRun_(() => {
    p = p || {};
    const fileId = str_(p.fileId, 200);
    // Security: only files that belong to a QRAP (the web app runs as the owner!).
    const att = dbFirst_('ATTACHMENT', a => a.file_id === fileId || a.thumb_file_id === fileId);
    if (!att || !fileId) fail_('E_NOT_FOUND', { id: fileId });
    const small = fileId === att.thumb_file_id;
    const cache = CacheService.getScriptCache();
    const cacheKey = 'ph_' + fileId;
    if (small) {
      const hit = cache.get(cacheKey);
      if (hit) return { mime: 'image/jpeg', data: hit };
    }
    const blob = DriveApp.getFileById(fileId).getBlob();
    const data = Utilities.base64Encode(blob.getBytes());
    if (small && data.length < 95000) cache.put(cacheKey, data, 21600);
    return { mime: blob.getContentType() || 'image/jpeg', data: data };
  });
}

/** Marks a photo as removed (the Drive file stays). */
function apiRemovePhoto(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const att = dbFirst_('ATTACHMENT', a => a.file_id === p.fileId && a.removed !== true);
    if (!att) fail_('E_NOT_FOUND', { id: p.fileId });
    const q = getQrapRow_(att.qrap_id);
    if (!canEditQr_(u, q)) fail_('E_FORBIDDEN');
    dbUpdate_('ATTACHMENT', att, { removed: true });
    return {};
  }, true);
}

/** Thumbnail blobs {wrong, correct} for e-mails (missing ones are skipped). */
function photoBlobsForMail_(qrapId) {
  const out = {};
  activePhotos_(qrapId).forEach(a => {
    if (a.kind !== 'WRONG' && a.kind !== 'CORRECT') return;
    try {
      out[a.kind === 'WRONG' ? 'wrong' : 'correct'] = DriveApp.getFileById(a.thumb_file_id || a.file_id).getBlob();
    } catch (e) {
      console.warn('photo for mail not found: ' + a.file_id);
    }
  });
  return out;
}


// ======================================================================
// Mail.gs
// ======================================================================
/**
 * Mail.gs – e-mail rules E1–E11, the HTML template, routing and de-duplication.
 *
 * Mails are queued during a write call (queueMail_) and sent by mailFlush_ after the sheet
 * changes are saved (see withWrite_). Every mail has a key; a key already in MAIL_LOG is never
 * sent again, so "send once" rules are safe to call many times.
 * Recipients always come from SET_ROUTING (or the pilots / finder chosen from SET_PEOPLE).
 */

let MAIL_QUEUE_ = [];
let MAIL_ENABLED_ = true; // seedDemoData() switches e-mails off

const STATUS_CZ = {
  DRAFT: 'Rozpracováno', QR_OPEN: 'Odesláno – opatření probíhají', WAIT_DECISION: 'Čeká na rozhodnutí',
  CLOSED_SOLVED: 'Uzavřeno – vyřešeno bez 5 Proč', ESCALATED: 'Eskalováno na APU', ANALYSIS: 'Analýza 5 Proč',
  ACTIONS_OPEN: 'Konečné akce probíhají', VERIFY: 'Ověření na 5 směnách', CLOSED: 'Uzavřeno'
};
const WAIT_CZ = { OPERATOR: 'operátor (rozpracováno)', TL: 'TL (opatření)', SUPERVISOR: 'supervizor',
  PILOT: 'pilot', VERIFY: 'kontrola 5 směn', APU: 'APU' };

/** Adds a mail to the queue. m = {rule, key, to[], cc[], subject, html, qrapId?, photosOf?} */
function queueMail_(m) {
  if (!MAIL_ENABLED_) return;
  MAIL_QUEUE_.push(m);
}

/**
 * Queues a mail about one QRAP with the standard layout.
 * @param {Object} q QRAP row
 * @param {{rule, key, to:string[], cc:string[], need:string, page:string, button:string,
 *          reason:string, extraHtml?:string, linkId?:string}} o
 */
function queueQrapMail_(q, o) {
  const subject = '[QRAP ' + q.qrap_id + '] ' + o.need + ' · SAFETY: ' + (q.safety === 'ANO' ? 'ano' : 'ne') +
    ' · Opakování: ' + (q.repeat_7d === 'ANO' ? 'ANO' : 'NE');
  queueMail_({
    rule: o.rule, key: o.key, to: o.to || [], cc: o.cc || [], subject: subject, qrapId: q.qrap_id,
    photosOf: q.qrap_id, html: qrapMailHtml_(q, o)
  });
}

/** The HTML body: key facts, photos placeholder, big button, footer. */
function qrapMailHtml_(q, o) {
  const area = areaByCode_(q.area_code);
  const qty = q.nok_situation === true && !Number(q.qty) ? 'NOK situace bez kusů' :
    (q.qty === '' ? '' : q.qty + ' ' + listLabelCz_('UNIT', q.unit));
  const facts = [
    ['Číslo QRAP', q.qrap_id],
    ['Oblast', q.area_code + (area ? ' – ' + area.name : '')],
    ['Stav', STATUS_CZ[q.status] || q.status],
    ['Čeká na', WAIT_CZ[waitingFor_(q)] || '–'],
    ['CO je za problém?', q.what],
    ['JAK byl objeven?', listLabelCz_('HOW_FOUND', q.how_found)],
    ['KDY?', q.detected_at ? fmt_(new Date(q.detected_at), 'd.M.yyyy HH:mm') : ''],
    ['KDE?', [q.zone, q.location_code].filter(Boolean).join(' / ')],
    ['KOLIK?', qty],
    ['SAFETY', q.safety === 'ANO' ? 'ANO' : 'ne'],
    ['Opakování (7 dní)', q.repeat_7d === 'ANO' ? 'ANO → ' + q.repeat_ref : 'NE'],
    ['Riziko na skladě / expedováno', q.risk_stock_shipped || '–'],
    ['Zkontrolováno / špatně', q.checked_qty === '' ? '' : q.checked_qty + ' / ' + q.wrong_found_qty + ' ks'],
    ['Číslo materiálu', q.material_no],
    ['HU / dodací list', q.hu_or_delivery_no],
    ['Dodavatel', q.supplier],
    ['Nalezl(a)', q.finder_name]
  ].filter(f => f[1] !== '' && f[1] !== undefined && f[1] !== null);
  const rows = facts.map(f => '<tr><td style="padding:6px 10px;border-bottom:1px solid #e3e6ea;color:#57606a;' +
    'white-space:nowrap;vertical-align:top">' + esc_(f[0]) + '</td><td style="padding:6px 10px;' +
    'border-bottom:1px solid #e3e6ea;font-weight:bold">' + esc_(f[1]) + '</td></tr>').join('');
  const link = appUrl_() + '?page=' + o.page + '&id=' + encodeURIComponent(o.linkId || q.qrap_id);
  const safety = q.safety === 'ANO' ? '<p style="background:#C62828;color:#fff;padding:8px 12px;font-weight:bold;' +
    'margin:0 0 12px">SAFETY – bezpečnostní problém</p>' : '';
  return mailFrame_('QRAP ' + q.qrap_id,
    '<p style="font-size:19px;margin:0 0 12px"><b>' + esc_(o.need) + '</b></p>' + safety +
    '<table style="border-collapse:collapse;width:100%;font-size:15px">' + rows + '</table>' +
    (o.extraHtml || '') + '{{PHOTOS}}' + mailButton_(link, o.button), o.reason);
}

/** Common frame for all e-mails. */
function mailFrame_(title, inner, reason) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:660px">' +
    '<div style="background:#1f2d3d;color:#fff;padding:14px 18px;font-size:18px;font-weight:bold">' +
    esc_(title) + '</div><div style="padding:16px 18px;border:1px solid #d0d7de;border-top:0">' + inner +
    '<p style="font-size:12px;color:#57606a;margin-top:22px">Tento e-mail dostáváte, protože jste ' +
    esc_(reason) + '. Odesláno aplikací ' + esc_(cfg_('SENDER_NAME') || APP_NAME) + '.</p></div></div>';
}

function mailButton_(link, text) {
  return '<p style="margin:22px 0"><a href="' + esc_(link) + '" style="display:inline-block;background:#2F6DB5;' +
    'color:#ffffff;padding:16px 28px;border-radius:6px;text-decoration:none;font-size:18px;font-weight:bold">' +
    esc_(text) + '</a></p>';
}

/** Routing e-mails of the person who decides this QRAP (supervisor or APU manager). */
function deciderEmails_(q) { return route_(q.area_code, deciderRole_(q)); }

// ---------------------------------------------------------------- rules

/** E1 – QRAP sent (Odeslat): supervisor of area + shift, cc manager. Once. */
function mailE1_(q) {
  const ready = q.status === ST.WAIT_DECISION;
  queueQrapMail_(q, { rule: 'E1', key: 'E1|' + q.qrap_id, to: deciderEmails_(q), cc: route_(q.area_code, 'MANAGER'),
    need: ready ? 'Nový QRAP – nutné rozhodnutí' : 'Nový QRAP – opatření probíhají', page: 'decide',
    button: 'Otevřít rozhodnutí', reason: 'supervizor oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E2 – SAFETY = ano: EHS + supervisor, cc manager. Immediately at step 1. */
function mailE2_(q) {
  queueQrapMail_(q, { rule: 'E2', key: 'E2|' + q.qrap_id,
    to: route_(q.area_code, 'EHS').concat(deciderEmails_(q)), cc: route_(q.area_code, 'MANAGER'),
    need: 'SAFETY – bezpečnostní problém', page: 'qrap', button: 'Otevřít QRAP',
    reason: 'EHS nebo supervizor oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E3 – risk on stock / shipped = ANO: Quality, cc supervisor. */
function mailE3_(q) {
  queueQrapMail_(q, { rule: 'E3', key: 'E3|' + q.qrap_id, to: route_(q.area_code, 'QUALITY'), cc: deciderEmails_(q),
    need: 'Riziko u zboží na skladě / expedovaného – Kvalita', page: 'qrap', button: 'Otevřít QRAP',
    reason: 'Kvalita pro oblast ' + q.area_code + ' (kopie: supervizor)' });
}

/** E4 – no decision by the next shift start: supervisor, cc manager. Once. */
function mailE4_(q) {
  queueQrapMail_(q, { rule: 'E4', key: 'E4|' + q.qrap_id, to: deciderEmails_(q), cc: route_(q.area_code, 'MANAGER'),
    need: 'Chybí rozhodnutí – začala další směna', page: 'decide', button: 'Rozhodnout',
    reason: 'rozhodujete QRAPy oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E5 – decision "Pokračovat": pilots, cc supervisor. */
function mailE5_(q, pilots, key) {
  queueQrapMail_(q, { rule: 'E5', key: key, to: pilots, cc: deciderEmails_(q),
    need: 'Jste pilot – analýza 5 Proč a konečné akce', page: 'analysis', button: 'Otevřít analýzu',
    reason: 'byl(a) jste určen(a) jako pilot tohoto QRAP',
    extraHtml: q.decision_comment ? '<p><b>Komentář supervizora:</b> ' + esc_(q.decision_comment) + '</p>' : '' });
}

/** E5b – new definitive action assigned: the action pilot (with due date). */
function mailE5b_(q, a) {
  const planned = a.planned ? fmt_(parseDateTime_(a.planned + 'T12:00'), 'd.M.yyyy') : '';
  queueQrapMail_(q, { rule: 'E5b', key: 'E5b|' + a.id + '|' + normEmail_(a.pilot_email), to: [a.pilot_email], cc: [],
    need: 'Nová konečná akce – termín ' + planned, page: 'actions', button: 'Moje akce',
    reason: 'jste pilot této konečné akce',
    extraHtml: '<p style="background:#f3eefb;padding:10px 12px;border-left:4px solid #7B4FB8"><b>Akce:</b> ' +
      esc_(a.text) + '<br><b>Plán:</b> ' + esc_(planned) + '</p>' });
}

/** E6 – decision "Eskalace": APU manager of the parent area, cc supervisor. */
function mailE6_(q, copy) {
  queueQrapMail_(copy, { rule: 'E6', key: 'E6|' + q.qrap_id, to: route_(copy.area_code, 'APU_MANAGER'),
    cc: deciderEmails_(q), need: 'Eskalace na APU QRQC – nutné rozhodnutí', page: 'decide',
    button: 'Otevřít rozhodnutí APU', reason: 'APU manažer pro oblast ' + copy.area_code + ' (kopie: supervizor)',
    extraHtml: '<p><b>Eskalováno z:</b> ' + esc_(q.qrap_id) + '<br><b>Komentář:</b> ' + esc_(q.decision_comment) + '</p>' });
}

/** E9 – QRAP closed: finder (if e-mail) + supervisor. */
function mailE9_(q) {
  const finder = personByName_(q.finder_name);
  queueQrapMail_(q, { rule: 'E9', key: 'E9|' + q.qrap_id + '|' + q.closed_at,
    to: (finder && finder.email ? [finder.email] : []).concat(deciderEmails_(q)), cc: [],
    need: 'QRAP uzavřen', page: 'qrap', button: 'Zobrazit QRAP',
    reason: 'jste nálezce problému nebo supervizor oblasti ' + q.area_code });
}

/** E10 – ③ not complete 24 h after KDY: TL + supervisor, cc manager. Once. */
function mailE10_(q) {
  queueQrapMail_(q, { rule: 'E10', key: 'E10|' + q.qrap_id,
    to: route_(q.area_code, 'TL').concat(deciderEmails_(q)), cc: route_(q.area_code, 'MANAGER'),
    need: 'Okamžitá opatření nejsou hotová do 24 h', page: 'qrap', button: 'Doplnit opatření',
    reason: 'TL nebo supervizor oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E11 – an effectiveness slot is NOT_EFFECTIVE: pilots, cc supervisor. */
function mailE11_(q, round) {
  queueQrapMail_(q, { rule: 'E11', key: 'E11|' + q.qrap_id + '|' + round,
    to: childrenOf_('PILOT', q.qrap_id).map(p => p.email), cc: deciderEmails_(q),
    need: 'Efektivita nepotvrzena – analýza znovu otevřena', page: 'analysis', button: 'Otevřít analýzu',
    reason: 'jste pilot nebo supervizor tohoto QRAP' });
}

// ---------------------------------------------------------------- sending

/**
 * Sends the queued mails (called by withWrite_ after the sheet is saved).
 * Skips keys already in MAIL_LOG, respects the daily quota and logs every mail.
 */
function mailFlush_() {
  if (!MAIL_QUEUE_.length) return;
  const queue = MAIL_QUEUE_;
  MAIL_QUEUE_ = [];
  const sent = {};
  readLogColumn_('MAIL_LOG', 'key').forEach(k => { if (k) sent[k] = true; });
  const sender = cfg_('SENDER_NAME') || APP_NAME;
  const log = [];
  queue.forEach(m => {
    if (m.key && sent[m.key]) return;
    const to = uniq_(m.to.map(normEmail_));
    const cc = uniq_((m.cc || []).map(normEmail_)).filter(e => to.indexOf(e) < 0);
    const base = { ts: new Date(), rule: m.rule, qrap_id: m.qrapId || '', to: to.join(', '), cc: cc.join(', ') };
    if (!to.length) {
      console.warn('Mail ' + m.rule + ' for ' + (m.qrapId || '-') + ' has no recipient (check SET_ROUTING).');
      return;
    }
    if (MailApp.getRemainingDailyQuota() < to.length + cc.length) {
      log.push(Object.assign(base, { rule: m.rule + '_QUOTA', subject: m.subject, key: '' }));
      return;
    }
    try {
      const opts = { to: to.join(','), subject: m.subject, name: sender };
      if (cc.length) opts.cc = cc.join(',');
      const photos = m.photosOf ? photoBlobsForMail_(m.photosOf) : {};
      opts.inlineImages = photos;
      opts.htmlBody = m.html.replace('{{PHOTOS}}', photosHtml_(photos));
      MailApp.sendEmail(opts);
      if (m.key) sent[m.key] = true;
      log.push(Object.assign(base, { subject: m.subject, key: m.key || '' }));
    } catch (e) {
      console.error('Mail ' + m.rule + ' failed: ' + e);
      log.push(Object.assign(base, { rule: m.rule + '_ERROR', subject: truncate_(String(e.message || e), 200), key: '' }));
    }
  });
  appendByHeader_('MAIL_LOG', log);
}

/** <img> tags for the inline photo blobs. */
function photosHtml_(photos) {
  const cell = (cid, label, color) => '<td style="padding:4px 8px 4px 0;vertical-align:top">' +
    '<div style="font-weight:bold;color:' + color + '">' + label + '</div>' +
    '<img src="cid:' + cid + '" width="220" style="border:3px solid ' + color + ';max-width:220px"></td>';
  let html = '';
  if (photos.wrong) html += cell('wrong', 'ŠPATNĚ', '#C62828');
  if (photos.correct) html += cell('correct', 'SPRÁVNĚ', '#3B8A1E');
  return html ? '<table style="margin-top:14px"><tr>' + html + '</tr></table>' : '';
}


// ======================================================================
// Triggers.gs
// ======================================================================
/**
 * Triggers.gs – time-driven jobs.
 *
 *  checkReminders  hourly            → E4 (no decision by next shift), E10 (③ open 24 h after KDY)
 *  dailyDigest     daily DIGEST_TIME → E7 (overdue actions per pilot), E8 (manager summary, Mon–Fri)
 *  archiveOld      Sunday 23:00      → archived = TRUE for QRAPs closed > ARCHIVE_AFTER_DAYS ago
 *
 * Run installTriggers() once from the editor (and again after changing DIGEST_TIME).
 */

const TRIGGER_HANDLERS = ['checkReminders', 'dailyDigest', 'archiveOld'];

/** Creates the three triggers (old ones of this app are removed first). */
function installTriggers() {
  requireOwnerOrAdmin_();
  removeTriggers();
  const t = hhmm_(cfg_('DIGEST_TIME') || '06:30');
  ScriptApp.newTrigger('checkReminders').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(t.h).nearMinute(t.m).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('archiveOld').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(23).inTimezone(TZ).create();
  Logger.log('Triggers installed: checkReminders (hourly), dailyDigest (%s:%s), archiveOld (Sunday 23:00).',
    t.h, ('0' + t.m).slice(-2));
}

/** Deletes the triggers of this app. */
function removeTriggers() {
  requireOwnerOrAdmin_();
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (TRIGGER_HANDLERS.indexOf(tr.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(tr); n++; }
  });
  Logger.log('Removed %s trigger(s).', n);
}

/** Hourly: E4 and E10 (each is sent only once per QRAP thanks to the MAIL_LOG key). */
function checkReminders() {
  if (!triggerCallerOk_()) throw new Error('Not allowed.');
  withWrite_(() => {
    const now = new Date();
    dbTable_('QRAP').rows.forEach(q => {
      if (q.archived === true) return;
      if (q.status === ST.WAIT_DECISION && !q.decision && q.containment_done_at) {
        const due = nextShiftStart_(new Date(q.containment_done_at));
        if (due && now > due) mailE4_(q);
      }
      if ((q.status === ST.DRAFT || q.status === ST.QR_OPEN) && q.detected_at &&
          now.getTime() - new Date(q.detected_at).getTime() > 24 * 3600000) {
        mailE10_(q);
      }
    });
  });
}

/** Daily: E7 every day, E8 on working days. The date in the key prevents a second run. */
function dailyDigest() {
  if (!triggerCallerOk_()) throw new Error('Not allowed.');
  withWrite_(() => {
    queueDigestE7_();
    if (localParts_(new Date()).dow <= 5) queueDigestE8_();
  });
}

/** Weekly: archive QRAPs closed more than ARCHIVE_AFTER_DAYS ago. */
function archiveOld() {
  if (!triggerCallerOk_()) throw new Error('Not allowed.');
  withWrite_(() => {
    const limit = Date.now() - cfgNum_('ARCHIVE_AFTER_DAYS') * 24 * 3600000;
    let n = 0;
    dbTable_('QRAP').rows.forEach(q => {
      const closed = q.closed_at || q.decided_at;
      if (q.archived !== true && FINAL_STATES.indexOf(q.status) >= 0 && closed && new Date(closed).getTime() < limit) {
        dbUpdate_('QRAP', q, { archived: true });
        n++;
      }
    });
    console.log('archiveOld: ' + n + ' QRAP(s) archived.');
  });
}

// ---------------------------------------------------------------- digests

/** E7 – one e-mail per pilot with overdue actions and due reviews; cc N+1 after OVERDUE_N1_DAYS. */
function queueDigestE7_() {
  const today = todayStr_();
  const n1Limit = addDaysStr_(today, -cfgNum_('OVERDUE_N1_DAYS'));
  const qraps = dbGroup_('QRAP', 'qrap_id');
  const actions = {};
  const byPilot = {};
  const bucket = email => (byPilot[email] = byPilot[email] || { late: [], reviews: [] });
  dbTable_('DEF_ACTION').rows.forEach(a => {
    const q = (qraps[a.qrap_id] || [])[0];
    if (!q || q.archived === true) return;
    actions[a.id] = { a: a, q: q };
    if (isActionLate_(a, today)) bucket(normEmail_(a.pilot_email)).late.push({ a: a, q: q });
  });
  dbTable_('ACTION_NOTE').rows.forEach(n => {
    const x = actions[n.action_id];
    if (x && x.a.status === 'OPENED' && n.review_date && n.review_date <= today && n.review_done !== true) {
      bucket(normEmail_(x.a.pilot_email)).reviews.push({ n: n, a: x.a, q: x.q });
    }
  });
  Object.keys(byPilot).forEach(email => {
    if (!email) return;
    const d = byPilot[email];
    const person = personByEmail_(email);
    const cc = d.late.some(x => x.a.planned <= n1Limit) && person && person.n1 ? [person.n1] : [];
    const lateRows = d.late.map(x => [x.q.qrap_id, x.a.text, fmtDay_(x.a.planned),
      '+' + daysBetween_(x.a.planned, today) + ' d']);
    const reviewRows = d.reviews.map(x => [x.q.qrap_id, x.a.text, x.n.note, fmtDay_(x.n.review_date)]);
    const html = mailFrame_('Moje akce – ' + fmtDay_(today),
      (lateRows.length ? '<h3 style="color:#C62828">Akce po termínu</h3>' +
        mailTable_(['QRAP', 'Akce', 'Plán', 'Zpoždění'], lateRows) : '') +
      (reviewRows.length ? '<h3>Revize k provedení</h3>' + mailTable_(['QRAP', 'Akce', 'Poznámka', 'Revize'], reviewRows) : '') +
      mailButton_(appUrl_() + '?page=actions', 'Otevřít Moje akce'),
      'pilot těchto konečných akcí' + (cc.length ? ' (kopie: vedoucí N+1 – akce je po termínu déle než ' +
        cfgNum_('OVERDUE_N1_DAYS') + ' dny)' : ''));
    queueMail_({ rule: 'E7', key: 'E7|' + email + '|' + today, to: [email], cc: cc, qrapId: '',
      subject: '[eQRAP] Akce po termínu – ' + fmtDay_(today), html: html });
  });
}

/** E8 – daily summary for every manager in SET_ROUTING (their areas together). */
function queueDigestE8_() {
  const now = new Date();
  const today = todayStr_(now);
  const yesterday = addDaysStr_(today, -1);
  const managers = {};
  getSettings_().routing.filter(r => r.role === 'MANAGER').forEach(r => {
    managers[r.email] = managers[r.email] || [];
    if (managers[r.email].indexOf(r.area) < 0) managers[r.email].push(r.area);
  });
  const all = dbTable_('QRAP').rows.filter(q => q.archived !== true);
  const assessments = dbTable_('ASSESSMENT').rows.filter(a => a.at && todayStr_(new Date(a.at)) === yesterday);
  Object.keys(managers).forEach(email => {
    const areas = managers[email];
    const qs = all.filter(q => areas.indexOf(q.area_code) >= 0);
    const s = managerSets_(qs, now);
    const qRow = q => [q.qrap_id, truncate_(q.what, 70), q.safety === 'ANO' ? 'ANO' : '', STATUS_CZ[q.status] || q.status];
    const section = (title, list) => '<h3>' + esc_(title) + ' (' + list.length + ')</h3>' +
      (list.length ? mailTable_(['QRAP', 'Co', 'Safety', 'Stav'], list.map(qRow)) : '<p style="color:#57606a">–</p>');
    const newYesterday = qs.filter(q => q.sent_at && todayStr_(new Date(q.sent_at)) === yesterday);
    const perAssessor = {};
    assessments.filter(a => qs.some(q => q.qrap_id === a.qrap_id))
      .forEach(a => { perAssessor[a.assessor] = (perAssessor[a.assessor] || 0) + 1; });
    const html = mailFrame_('Denní souhrn – ' + areas.join(', ') + ' – ' + fmtDay_(today),
      section('Nové včera', newYesterday) +
      section('Čeká na rozhodnutí', s.waitDecision) +
      section('Opatření ③ déle než 24 h', s.s3Late) +
      '<h3>Akce po termínu (' + s.lateActions.length + ')</h3>' +
      (s.lateActions.length ? mailTable_(['QRAP', 'Akce', 'Pilot', 'Plán'], s.lateActions.map(a =>
        [a.qrap_id, truncate_(a.text, 70), personName_(a.pilot_email), fmtDay_(a.planned)])) : '<p>–</p>') +
      section('Bezpečnost tento týden', s.safetyWeek) +
      section('Opakování (7 dní)', s.repeat7) +
      '<h3>Hodnocení QRQC včera</h3>' + (Object.keys(perAssessor).length ? mailTable_(['Hodnotitel', 'Počet'],
        Object.keys(perAssessor).map(k => [personName_(k), perAssessor[k]])) : '<p style="color:#C62828">Žádné hodnocení.</p>') +
      mailButton_(appUrl_() + '?page=manager', 'Otevřít stránku manažera'),
      'vedoucí logistiky pro oblasti ' + areas.join(', ') + ' (SET_ROUTING)');
    queueMail_({ rule: 'E8', key: 'E8|' + email + '|' + today, to: [email], cc: [], qrapId: '',
      subject: '[eQRAP] Denní souhrn ' + fmtDay_(today) + ' – ' + areas.join(', '), html: html });
  });
}

/** Simple HTML table for digests (all cells escaped). */
function mailTable_(headers, rows) {
  const th = headers.map(h => '<th style="text-align:left;padding:6px 8px;background:#eef1f4">' + esc_(h) + '</th>').join('');
  const tr = rows.map(r => '<tr>' + r.map(c => '<td style="padding:6px 8px;border-bottom:1px solid #e3e6ea">' +
    esc_(c) + '</td>').join('') + '</tr>').join('');
  return '<table style="border-collapse:collapse;width:100%;font-size:14px"><tr>' + th + '</tr>' + tr + '</table>';
}

/** 'yyyy-MM-dd' → 'd.M.yyyy'. */
function fmtDay_(day) {
  const d = parseDateTime_(String(day || '') + 'T12:00');
  return d ? fmt_(d, 'd.M.yyyy') : '';
}

/** Whole days from day a to day b ('yyyy-MM-dd'). */
function daysBetween_(a, b) {
  return Math.round((parseDateTime_(b + 'T12:00').getTime() - parseDateTime_(a + 'T12:00').getTime()) / 86400000);
}


// ======================================================================
// Manager.gs
// ======================================================================
/**
 * Manager.gs – manager page (tiles, "Potřebuje vás", filtered list) and search.
 * managerSets_ is shared with the daily summary e-mail (E8).
 */

/**
 * Manager page data.
 * @param {{area?:string, from?:string, to?:string, status?:string}} f
 */
function apiGetManager(f) {
  return apiRun_(() => {
    f = f || {};
    const u = currentUser_();
    if (!canManager_(u)) fail_('E_FORBIDDEN');
    const area = up_(f.area);
    const now = new Date();
    const qs = dbWhere_('QRAP', q => q.archived !== true && (!area || q.area_code === area));
    const sets = managerSets_(qs, now);
    const tiles = {
      newToday: sets.newToday.length,
      waitDecision: sets.waitDecision.length,
      s3Late: sets.s3Late.length,
      actionsLate: sets.lateActions.length,
      safetyWeek: sets.safetyWeek.length,
      repeat7: sets.repeat7.length
    };
    let list = qs;
    if (f.from) list = list.filter(q => q.detected_at && todayStr_(new Date(q.detected_at)) >= f.from);
    if (f.to) list = list.filter(q => q.detected_at && todayStr_(new Date(q.detected_at)) <= f.to);
    if (f.status === 'open') list = list.filter(q => FINAL_STATES.indexOf(q.status) < 0);
    else if (f.status === 'closed') list = list.filter(q => FINAL_STATES.indexOf(q.status) >= 0);
    else if (ST[f.status]) list = list.filter(q => q.status === f.status);
    const rows = buildBoardRows_(list).reverse();
    return {
      tiles: tiles,
      assessToday: assessPerSupervisor_(area, todayStr_(now)),
      needs: needsYou_(sets, now).slice(0, 60),
      rows: rows.slice(0, 300),
      total: rows.length
    };
  });
}

/**
 * Groups of QRAPs / actions used by the tiles, "Potřebuje vás" and the daily summary.
 * @param {Object[]} qs QRAP rows (already filtered by area, not archived)
 * @param {Date} now
 */
function managerSets_(qs, now) {
  const today = todayStr_(now);
  const t = now.getTime();
  const weekStart = weekStart_(now).getTime();
  const det = q => (q.detected_at ? new Date(q.detected_at).getTime() : 0);
  const qById = {};
  qs.forEach(q => { qById[q.qrap_id] = q; });
  const waitDecision = qs.filter(q => q.status === ST.WAIT_DECISION);
  return {
    qById: qById,
    newToday: qs.filter(q => q.status !== ST.DRAFT && det(q) && todayStr_(new Date(det(q))) === today),
    waitDecision: waitDecision,
    decisionLate: waitDecision.filter(q => {
      const due = q.containment_done_at ? nextShiftStart_(new Date(q.containment_done_at)) : null;
      return due && now > due;
    }),
    s3Late: qs.filter(q => (q.status === ST.DRAFT || q.status === ST.QR_OPEN) && det(q) && t - det(q) > 24 * 3600000),
    lateActions: dbWhere_('DEF_ACTION', a => !!qById[a.qrap_id] && isActionLate_(a, today)),
    safetyWeek: qs.filter(q => q.safety === 'ANO' && det(q) >= weekStart),
    repeat7: qs.filter(q => q.repeat_7d === 'ANO' && det(q) && t - det(q) <= 7 * 24 * 3600000)
  };
}

/** "Potřebuje vás": everything that is late or waiting, most urgent first. */
function needsYou_(sets, now) {
  const items = [];
  const seen = {};
  const add = (q, reason, urgency, extra) => {
    items.push({ id: q.qrap_id, what: truncate_(q.what, 90), area: q.area_code, reason: reason,
      urgency: urgency + (q.safety === 'ANO' ? 20 : 0), since: q.detected_at || q.created_at,
      safety: q.safety === 'ANO', extra: extra || '' });
    seen[q.qrap_id] = true;
  };
  sets.decisionLate.forEach(q => add(q, 'DECISION_LATE', 90));
  sets.s3Late.forEach(q => add(q, 'S3_LATE', 80));
  const today = todayStr_(now);
  sets.lateActions.forEach(a => {
    const q = sets.qById[a.qrap_id];
    const days = daysBetween_(a.planned, today);
    add(q, 'ACTION_LATE', 60 + Math.min(days, 30), truncate_(a.text, 80) + ' · ' + personName_(a.pilot_email) +
      ' · +' + days + ' d');
  });
  sets.waitDecision.forEach(q => { if (sets.decisionLate.indexOf(q) < 0) add(q, 'WAIT_DECISION', 50); });
  Object.keys(sets.qById).forEach(id => {
    const q = sets.qById[id];
    if (q.safety === 'ANO' && FINAL_STATES.indexOf(q.status) < 0 && !seen[id]) add(q, 'SAFETY_OPEN', 30);
  });
  items.sort((a, b) => b.urgency - a.urgency || (a.since < b.since ? -1 : 1));
  return items;
}

/**
 * "Hodnocení dnes per supervisor": every supervisor of the area (0 included) plus other assessors.
 * @return {{name:string, email:string, count:number, supervisor:boolean}[]}
 */
function assessPerSupervisor_(area, day) {
  const counts = {};
  dbTable_('ASSESSMENT').rows.forEach(a => {
    if (a.at && todayStr_(new Date(a.at)) === day) counts[a.assessor] = (counts[a.assessor] || 0) + 1;
  });
  const out = [];
  getSettings_().people.forEach(p => {
    if (!p.email || p.roles.indexOf('SUPERVISOR') < 0) return;
    if (area && p.areas.indexOf('*') < 0 && p.areas.indexOf(area) < 0) return;
    out.push({ name: p.name, email: p.email, count: counts[p.email] || 0, supervisor: true });
  });
  Object.keys(counts).forEach(email => {
    if (!out.some(o => o.email === email)) out.push({ name: personName_(email), email: email, count: counts[email], supervisor: false });
  });
  out.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
  return out;
}

/**
 * Search by number, text, material number, HU / delivery note or supplier (archived included).
 * @param {string} text at least 2 characters
 */
function apiSearch(text) {
  return apiRun_(() => {
    const s = str_(text, 100).toLowerCase();
    if (s.length < 2) fail_('E_SEARCH_SHORT');
    const fields = ['qrap_id', 'what', 'material_no', 'hu_or_delivery_no', 'supplier'];
    const hits = dbWhere_('QRAP', q => fields.some(f => String(q[f] || '').toLowerCase().indexOf(s) >= 0));
    const rows = buildBoardRows_(hits).reverse().slice(0, 50);
    rows.forEach(r => { r.archived = (hits.find(q => q.qrap_id === r.id) || {}).archived === true; });
    return { rows: rows, total: hits.length };
  });
}


// ======================================================================
// Admin.gs
// ======================================================================
/**
 * Admin.gs – admin-only tools. Settings are edited directly in the SET_* tabs; these functions
 * handle signed data. A reason is always required and written to AUDIT_LOG.
 *
 *  - unlock ①–③ (QR)       : the signed facts can be corrected; status unchanged
 *  - unlock ④ (DECISION)    : decision cleared, back to WAIT_DECISION (only ANALYSIS or CLOSED_SOLVED)
 *  - reopen                 : CLOSED → VERIFY, CLOSED_SOLVED → WAIT_DECISION
 *  - archive / un-archive
 */

/** Common start of every admin call: admin role, QRAP loaded, reason present. */
function adminStart_(p) {
  const u = currentUser_();
  if (!isAdmin_(u)) fail_('E_NOT_ADMIN');
  const q = getQrapRow_(p.id);
  const reason = str_(p.reason, 500);
  if (reason.length < 5) failMany_([{ code: 'E_REASON', field: 'reason' }]);
  return { u: u, q: q, reason: reason };
}

/**
 * Unlocks a signed part.
 * @param {{id:string, part:string, reason:string}} p part: QR | DECISION
 */
function apiAdminUnlock(p) {
  return apiRun_(() => {
    p = p || {};
    const x = adminStart_(p);
    const q = x.q;
    const part = up_(p.part);
    if (part === 'QR') {
      if (!isLocked_(q, 'QR')) fail_('E_NOT_LOCKED');
      if (QR_STATES.indexOf(q.status) < 0) fail_('E_STATE', { status: q.status });
      dbUpdate_('QRAP', q, { locked_parts: removeLock_(q.locked_parts, 'QR') });
    } else if (part === 'DECISION') {
      if (q.status !== ST.ANALYSIS && q.status !== ST.CLOSED_SOLVED) fail_('E_STATE', { status: q.status });
      dbUpdate_('QRAP', q, {
        status: ST.WAIT_DECISION, decision: '', decided_by: '', decided_at: '', closed_by: '', closed_at: '',
        locked_parts: removeLock_(removeLock_(q.locked_parts, 'DECISION'), 'QR')
      });
    } else {
      fail_('E_INVALID', { field: 'part' });
    }
    audit_(q.qrap_id, 'QRAP', q.qrap_id, 'ADMIN_UNLOCK_' + part, 'reason', '', x.reason);
    return { status: q.status };
  }, true);
}

/** Reopens a closed QRAP. @param {{id:string, reason:string}} p */
function apiAdminReopen(p) {
  return apiRun_(() => {
    p = p || {};
    const x = adminStart_(p);
    const q = x.q;
    if (q.status === ST.CLOSED) {
      dbUpdate_('QRAP', q, { status: ST.VERIFY, closed_by: '', closed_at: '', archived: false,
        locked_parts: removeLock_(q.locked_parts, 'ANALYSIS') });
    } else if (q.status === ST.CLOSED_SOLVED) {
      dbUpdate_('QRAP', q, { status: ST.WAIT_DECISION, decision: '', decided_by: '', decided_at: '',
        closed_by: '', closed_at: '', archived: false,
        locked_parts: removeLock_(removeLock_(q.locked_parts, 'DECISION'), 'QR') });
    } else {
      fail_('E_STATE', { status: q.status });
    }
    audit_(q.qrap_id, 'QRAP', q.qrap_id, 'ADMIN_REOPEN', 'reason', '', x.reason);
    return { status: q.status };
  }, true);
}

/** Archives or restores a QRAP. @param {{id:string, archived:boolean, reason:string}} p */
function apiAdminArchive(p) {
  return apiRun_(() => {
    p = p || {};
    const x = adminStart_(p);
    const on = p.archived === true;
    dbUpdate_('QRAP', x.q, { archived: on });
    audit_(x.q.qrap_id, 'QRAP', x.q.qrap_id, on ? 'ADMIN_ARCHIVE' : 'ADMIN_UNARCHIVE', 'reason', '', x.reason);
    return { archived: on };
  }, true);
}


// ======================================================================
// Setup.gs
// ======================================================================
/**
 * Setup.gs – creates the database tabs and example settings, and checks the installation.
 *
 * setup()    run once from the editor (safe to run again: nothing is duplicated)
 * selfTest() prints a readable report (View → Executions / the log panel)
 */

/** Creates every tab with its headers, formats and example settings. */
function setup() {
  requireOwnerOrAdmin_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open the script from the Google Sheet (Extensions → Apps Script) and run setup() there.');
  PropertiesService.getScriptProperties().setProperty('DB_ID', ss.getId());
  DB_SS_ = ss;
  ss.setSpreadsheetTimeZone(TZ);
  const created = [];
  Object.keys(SCHEMA).forEach(name => { if (ensureSheet_(ss, name)) created.push(name); });
  seedSettings_(ss);
  clearCaches();
  Logger.log('setup() done. New tabs: %s', created.length ? created.join(', ') : 'none');
  Logger.log('Next: create the Drive photo folder, put its ID into SET_CONFIG.PHOTO_FOLDER_ID, deploy, run selfTest().');
}

/**
 * Makes sure a tab exists with all schema headers (missing headers are added at the end,
 * existing columns are never moved). Sets number formats so Sheets does not change the values.
 * @return {boolean} true if the tab was created
 */
function ensureSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  const isNew = !sheet;
  if (isNew) sheet = ss.insertSheet(name);
  const cols = schemaCols_(name);
  let headers = [];
  if (sheet.getLastRow() > 0 && sheet.getLastColumn() > 0) {
    headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  }
  const missing = cols.map(c => c[0]).filter(h => headers.indexOf(h) < 0);
  if (missing.length) {
    const start = headers.filter(Boolean).length + 1;
    if (sheet.getMaxColumns() < start + missing.length - 1) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), start + missing.length - 1 - sheet.getMaxColumns());
    }
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    headers = headers.filter(Boolean).concat(missing);
  }
  const formats = { text: '@', num: '0', bool: 'General', ts: 'yyyy-mm-dd hh:mm', date: 'yyyy-mm-dd' };
  cols.forEach(c => {
    const col = headers.indexOf(c[0]) + 1;
    if (col > 0) sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat(formats[c[1]] || '@');
  });
  const color = SCHEMA[name].settings ? '#fdf1dc' : SCHEMA[name].log ? '#eceff1' : '#dfe9f6';
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground(color);
  sheet.setFrozenRows(1);
  return isNew;
}

/** Example settings. Each SET_* tab is filled only when it has no data rows yet. */
function seedSettings_(ss) {
  // SET_CONFIG: add missing keys only
  const cfgSheet = ss.getSheetByName('SET_CONFIG');
  const existing = cfgSheet.getLastRow() > 1
    ? cfgSheet.getRange(2, 1, cfgSheet.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim()) : [];
  const defaults = Object.assign({}, CONFIG_DEFAULTS);
  try { defaults.APP_URL = ScriptApp.getService().getUrl() || ''; } catch (e) { defaults.APP_URL = ''; }
  const add = Object.keys(defaults).filter(k => existing.indexOf(k) < 0).map(k => [k, defaults[k]]);
  if (add.length) cfgSheet.getRange(cfgSheet.getLastRow() + 1, 1, add.length, 2).setValues(add);

  const fill = (name, rows) => {
    const sh = ss.getSheetByName(name);
    if (sh.getLastRow() > 1 || !rows.length) return;
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  };
  fill('SET_AREAS', [
    ['WH1', 'Sklad 1', 'AREA', 'APU', true],
    ['WH2', 'Sklad 2', 'AREA', 'APU', true],
    ['APU', 'APU Logistika', 'APU', '', true]
  ]);
  const zones = [['Příjem', ['P-01', 'P-02']], ['Sklad', ['S-A01', 'S-A02', 'S-B01']],
    ['Vychystávání', ['V-01', 'V-02']], ['Balení', ['B-01', 'B-02']], ['Expedice / Rampa', ['R-01', 'R-02', 'R-03']]];
  const locs = [];
  ['WH1', 'WH2'].forEach(a => zones.forEach(z => z[1].forEach(code => locs.push([a, z[0], code, true]))));
  fill('SET_LOCATIONS', locs);
  fill('SET_SHIFTS', [
    ['R', 'Ranní', '06:00', '14:00', '12345', true],
    ['O', 'Odpolední', '14:00', '22:00', '12345', true],
    ['N', 'Noční', '22:00', '06:00', '12345', true],
    ['V', 'Víkend', '06:00', '18:00', '67', false]
  ]);
  fill('SET_PEOPLE', [
    ['Kiosek WH1', 'kiosk.wh1@example.com', '', 'KIOSK', 'WH1', '', true],
    ['Kiosek WH2', 'kiosk.wh2@example.com', '', 'KIOSK', 'WH2', '', true],
    ['Jan Novák', '', '1001', 'OPERATOR', 'WH1', '', true],
    ['Petra Svobodová', '', '1002', 'OPERATOR', 'WH1', '', true],
    ['Milan Horák', '', '2001', 'OPERATOR', 'WH2', '', true],
    ['Tomáš Dvořák', 'tl.wh1@example.com', '1003', 'TL', 'WH1', 'supervisor.wh1@example.com', true],
    ['Irena Malá', 'tl.wh2@example.com', '2002', 'TL', 'WH2', 'supervisor.wh2@example.com', true],
    ['Eva Černá', 'supervisor.wh1@example.com', '', 'SUPERVISOR', 'WH1', 'manager@example.com', true],
    ['Ondřej Beneš', 'supervisor.night@example.com', '', 'SUPERVISOR', 'WH1,WH2', 'manager@example.com', true],
    ['Martin Procházka', 'supervisor.wh2@example.com', '', 'SUPERVISOR', 'WH2', 'manager@example.com', true],
    ['Lucie Kučerová', 'pilot1@example.com', '', 'PILOT', 'WH1,WH2', 'supervisor.wh1@example.com', true],
    ['Karel Veselý', 'pilot2@example.com', '', 'PILOT', '*', 'manager@example.com', true],
    ['Jana Horáková', 'quality@example.com', '', 'QUALITY', '*', 'manager@example.com', true],
    ['Pavel Marek', 'ehs@example.com', '', 'EHS', '*', 'manager@example.com', true],
    ['Zuzana Pokorná', 'manager@example.com', '', 'MANAGER', '*', 'apu.manager@example.com', true],
    ['Radek Král', 'apu.manager@example.com', '', 'APU_MANAGER', 'APU', '', true],
    ['Admin eQRAP', 'admin@example.com', '', 'ADMIN', '*', '', true]
  ]);
  const routing = [];
  [['WH1', 'supervisor.wh1@example.com', 'tl.wh1@example.com'], ['WH2', 'supervisor.wh2@example.com', 'tl.wh2@example.com']]
    .forEach(a => {
      routing.push([a[0], '*', 'SUPERVISOR', a[1]]);
      routing.push([a[0], 'N', 'SUPERVISOR', 'supervisor.night@example.com']);
      routing.push([a[0], '*', 'TL', a[2]]);
      routing.push([a[0], '*', 'MANAGER', 'manager@example.com']);
      routing.push([a[0], '*', 'QUALITY', 'quality@example.com']);
      routing.push([a[0], '*', 'EHS', 'ehs@example.com']);
    });
  routing.push(['APU', '*', 'APU_MANAGER', 'apu.manager@example.com']);
  routing.push(['APU', '*', 'MANAGER', 'manager@example.com']);
  routing.push(['APU', '*', 'QUALITY', 'quality@example.com']);
  routing.push(['APU', '*', 'EHS', 'ehs@example.com']);
  fill('SET_ROUTING', routing);
  fill('SET_LISTS', exampleLists_());
}

/** SET_LISTS rows: list | code | value_cz | value_en | order | active */
function exampleLists_() {
  const rows = [];
  const add = (list, items) => items.forEach((it, i) => rows.push([list, it[0], it[1], it[2], (i + 1) * 10, true]));
  add('HOW_FOUND', [
    ['RECEIVING', 'příjem zboží', 'goods receipt'], ['STORAGE', 'skladování', 'storage'],
    ['PICKING', 'vychystávání', 'picking'], ['PACKING', 'balení', 'packing'],
    ['SHIP_CHECK', 'kontrola expedice', 'shipping check'], ['INVENTORY', 'inventura', 'stock count'],
    ['CUSTOMER_CLAIM', 'reklamace zákazníka', 'customer claim'],
    ['SUPPLIER_DELIVERY', 'dodávka dodavatele', 'supplier delivery'], ['OTHER', 'jiné', 'other']
  ]);
  add('UNIT', [['PCS', 'ks', 'pcs'], ['BOX', 'krabice', 'boxes'], ['PAL', 'palety', 'pallets'],
    ['HU', 'manipulační jednotky', 'handling units']]);
  add('ACTION_TYPE', [
    ['BLOCK', 'blokace / karanténa zásob', 'block / quarantine stock'], ['RELABEL', 'přeetiketování', 'relabelling'],
    ['REPACK', 'přebalení', 'repacking'], ['HOLD_SHIP', 'pozdržení expedice', 'hold shipment'],
    ['INFORM', 'informovat zákazníka / dodavatele', 'inform customer / supplier'], ['OTHER', 'jiné', 'other']
  ]);
  add('ALERT_ROLE', [
    ['TL', 'Team Leader', 'Team Leader'], ['SUPERVISOR', 'Supervizor', 'Supervisor'], ['QUALITY', 'Kvalita', 'Quality'],
    ['MANAGER', 'Vedoucí logistiky', 'Logistics manager'], ['PURCHASING', 'Nákup / dodavatel', 'Purchasing / supplier'],
    ['MAINTENANCE', 'Údržba (VZV, zařízení)', 'Maintenance (forklifts, equipment)'], ['OTHER', 'jiné', 'other']
  ]);
  return rows;
}

/**
 * Checks tabs, headers, config keys, the photo folder, time zones, people and routing.
 * @return {string} the report (also written to the log)
 */
function selfTest() {
  requireOwnerOrAdmin_();
  const out = [];
  const ok = (cond, text) => { out.push((cond ? '✓ ' : '✗ ') + text); return cond; };
  const ss = db_();
  Object.keys(SCHEMA).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!ok(!!sh, 'Tab ' + name)) return;
    const headers = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    const missing = schemaCols_(name).map(c => c[0]).filter(h => headers.indexOf(h) < 0);
    if (missing.length) ok(false, '  ' + name + ' is missing columns: ' + missing.join(', '));
  });
  SETTINGS_ = null;
  CacheService.getScriptCache().remove(SETTINGS_CACHE_KEY);
  const s = getSettings_();
  Object.keys(CONFIG_DEFAULTS).forEach(k => ok(s.config[k] !== undefined && s.config[k] !== '' || k === 'APP_URL' && !!appUrl_(),
    'SET_CONFIG.' + k + ' = ' + (s.config[k] || '(empty)')));
  ok(Session.getScriptTimeZone() === TZ, 'Script time zone ' + Session.getScriptTimeZone());
  ok(ss.getSpreadsheetTimeZone() === TZ, 'Spreadsheet time zone ' + ss.getSpreadsheetTimeZone());
  try {
    ok(!!DriveApp.getFolderById(cfg_('PHOTO_FOLDER_ID')).getName(), 'Photo folder is accessible');
  } catch (e) {
    ok(false, 'Photo folder PHOTO_FOLDER_ID is not accessible');
  }
  ok(s.shifts.length > 0, 'Active shifts: ' + s.shifts.map(x => x.code + ' ' + x.start.h + ':' + ('0' + x.start.m).slice(-2)).join(', '));
  ['HOW_FOUND', 'UNIT', 'ACTION_TYPE', 'ALERT_ROLE'].forEach(l => ok((s.lists[l] || []).length > 0, 'List ' + l));
  s.people.forEach(p => {
    const bad = p.roles.filter(r => ALL_ROLES.indexOf(r) < 0);
    if (bad.length) ok(false, 'SET_PEOPLE ' + p.name + ': unknown role(s) ' + bad.join(', '));
  });
  s.areas.forEach(a => {
    if (a.level === 'AREA') {
      ok(!!parentAreaOf_(a.code), 'Area ' + a.code + ' has a parent APU (' + (a.parent || 'none') + ')');
      ['SUPERVISOR', 'MANAGER', 'QUALITY', 'EHS', 'TL'].forEach(role => s.shifts.forEach(sh => {
        const has = s.routing.some(r => r.area === a.code && r.role === role && (r.shift === sh.code || r.shift === '*'));
        if (!has) ok(false, 'Routing missing: ' + a.code + ' / shift ' + sh.code + ' / ' + role);
      }));
    } else {
      ok(s.routing.some(r => r.area === a.code && r.role === 'APU_MANAGER'), 'Routing ' + a.code + ' / APU_MANAGER');
    }
  });
  const handlers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  TRIGGER_HANDLERS.forEach(h => ok(handlers.indexOf(h) >= 0, 'Trigger ' + h + ' installed'));
  ok(MailApp.getRemainingDailyQuota() > 0, 'Mail quota left today: ' + MailApp.getRemainingDailyQuota());
  const report = 'eQRAP selfTest ' + fmt_(new Date(), 'yyyy-MM-dd HH:mm') + '\n' + out.join('\n');
  Logger.log(report);
  return report;
}


// ======================================================================
// SeedDemo.gs
// ======================================================================
/**
 * SeedDemo.gs – about 9 demo QRAPs in different states, so the board, the detail pages and the
 * manager page can be tried at once. No e-mails are sent and no photos are used.
 *
 * Runs once. To run it again, delete the script property DEMO_SEEDED
 * (Project Settings → Script properties).
 */

/** Creates the demo QRAPs (run from the editor after setup()). */
function seedDemoData() {
  requireOwnerOrAdmin_();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('DEMO_SEEDED')) {
    Logger.log('Demo data already exists (script property DEMO_SEEDED). Delete the property to seed again.');
    return;
  }
  MAIL_ENABLED_ = false;
  withWrite_(() => seedDemoRows_());
  props.setProperty('DEMO_SEEDED', nowIso_());
  Logger.log('Demo data created. Open ?page=board&area=WH1');
}

/** ISO time `h` hours ago. */
function agoIso_(h) { return new Date(Date.now() - h * 3600000).toISOString(); }
/** 'yyyy-MM-dd' `d` days from today (negative = past). */
function dayRel_(d) { return addDaysStr_(todayStr_(), d); }

/** Inserts a demo row and back-dates its created_at. */
function seedInsert_(table, data, createdAt) {
  const row = dbInsert_(table, data);
  if (createdAt && SCHEMA[table].audit) { row.created_at = createdAt; row.updated_at = createdAt; }
  return row;
}

/** One demo QRAP with ①②③ filled. */
function seedQrap_(area, hoursAgo, f, alerts, ia) {
  const det = agoIso_(hoursAgo);
  const idInfo = nextQrapId_(area);
  const q = seedInsert_('QRAP', Object.assign({
    qrap_id: idInfo.id, area_code: area, level: 'AREA', seq: idInfo.seq, suffix: '', parent_id: '',
    status: ST.QR_OPEN, template_version: TEMPLATE_VERSION, safety: 'NE', detected_at: det,
    repeat_7d: 'NE', nok_situation: false, photo_exception: 'Demo data – bez fotek', s1_done_at: det,
    s2_done_at: det, s3_done_at: det, sent_at: agoIso_(hoursAgo - 0.2), locked_parts: '', archived: false,
    check_in_progress: false
  }, f), det);
  (alerts || []).forEach(code => seedInsert_('ALERT', { qrap_id: q.qrap_id, role_code: code, other_text: '',
    notified_to: ROUTING_KEYS.indexOf(code) >= 0 ? route_(area, code).join(', ') : '', notified_at: det, removed: false }, det));
  (ia || []).forEach(a => seedInsert_('IMMEDIATE_ACTION', { id: newId_('IA'), qrap_id: q.qrap_id, type: a[0], text: a[1],
    owner_name: a[2], owner_email: (personByName_(a[2]) || {}).email || '', done_at: a[3] === null ? '' : agoIso_(a[3]),
    status: a[3] === null ? 'OPEN' : 'DONE' }, det));
  return q;
}

function seedDecide_(q, decision, comment, hoursAgo, by) {
  const at = agoIso_(hoursAgo);
  Object.assign(q, { decision: decision, decision_comment: comment, decided_by: by, decided_at: at,
    locked_parts: 'QR,DECISION' });
}

function seedWhy_(q, chain, texts, root) {
  texts.forEach((t, i) => seedInsert_('WHY_STEP', { qrap_id: q.qrap_id, chain: chain, step: i + 1, text: t,
    is_root: root === i + 1 }));
}

function seedAction_(q, root, text, pilot, planned, done) {
  return seedInsert_('DEF_ACTION', { id: newId_('DA'), qrap_id: q.qrap_id, root_step: root, text: text,
    pilot_email: pilot, planned: planned, planned_first: planned, done: done || '', status: done ? 'CLOSED' : 'OPENED',
    evidence_url: '' });
}

function seedEff_(q, slot, day, shift, result) {
  seedInsert_('EFFECTIVENESS', { qrap_id: q.qrap_id, round: 1, slot: slot, shift_date: dayRel_(day), shift_code: shift,
    result: result, checked_by: 'Tomáš Dvořák', checked_at: agoIso_(-day * 24 + 1) });
}

function seedAssess_(q, who, hoursAgo, c, feedback, type) {
  seedInsert_('ASSESSMENT', { id: newId_('AS'), qrap_id: q.qrap_id, assessor: who, at: agoIso_(hoursAgo),
    c1: c[0], c2: c[1], c3: c[2], c4: c[3], c5: c[4], ojt_with: q.finder_name, feedback: feedback, feedback_type: type });
}

function seedShifts_(q, codes, hoursAgo, by) {
  codes.forEach(c => seedInsert_('SHIFT_INFO', { qrap_id: q.qrap_id, shift_code: c, informed_by: by,
    informed_at: agoIso_(hoursAgo) }));
}

/** The demo QRAPs themselves. */
function seedDemoRows_() {
  const sup1 = 'supervisor.wh1@example.com';
  const sup2 = 'supervisor.wh2@example.com';
  const TL1 = 'Tomáš Dvořák';

  // 1 · DRAFT – only step 1 saved
  seedQrap_('WH1', 0.3, { status: ST.DRAFT, what: 'Poškozená krabice na paletě při příjmu – promáčknutý roh',
    how_found: 'RECEIVING', zone: 'Příjem', location_code: 'P-01', qty: 2, unit: 'BOX', finder_name: 'Jan Novák',
    s2_done_at: '', s3_done_at: '', sent_at: '' });

  // 2 · QR_OPEN – ③ still open after 30 h (red chip 3)
  seedQrap_('WH1', 30, { what: 'Chybějící etiketa HU na paletě v regálu S-A02', how_found: 'STORAGE', zone: 'Sklad',
    location_code: 'S-A02', qty: 1, unit: 'PAL', finder_name: 'Petra Svobodová', material_no: '4711-123',
    risk_stock_shipped: 'ANO', check_in_progress: true, process_stopped: 'NE' }, ['TL', 'QUALITY'],
  [['BLOCK', 'Paleta zablokována ve WMS', TL1, 29], ['RELABEL', 'Přeetiketovat HU podle dodacího listu', TL1, null]]);

  // 3 · WAIT_DECISION – SAFETY
  const q3 = seedQrap_('WH1', 5, { what: 'Uvolněná stretch fólie na paletě ve 4. úrovni regálu – hrozí pád zboží',
    how_found: 'STORAGE', safety: 'ANO', zone: 'Sklad', location_code: 'S-B01', qty: 1, unit: 'PAL',
    finder_name: 'Jan Novák', risk_stock_shipped: 'NE', process_stopped: 'ANO', restored_at: agoIso_(3.9),
    status: ST.WAIT_DECISION, containment_done_at: agoIso_(3.9) }, ['TL', 'SUPERVISOR', 'MAINTENANCE'],
  [['BLOCK', 'Uzavřít uličku, paletu sundat VZV', TL1, 4.5], ['REPACK', 'Paletu přebalit a zajistit fólií', TL1, 4]]);
  seedShifts_(q3, ['R'], 3.5, sup1);

  // 4 · CLOSED_SOLVED
  const q4 = seedQrap_('WH1', 72, { what: 'Propíchnutá krabice vidlemi VZV při nakládce na rampě R-01',
    how_found: 'SHIP_CHECK', zone: 'Expedice / Rampa', location_code: 'R-01', qty: 1, unit: 'BOX',
    finder_name: 'Petra Svobodová', risk_stock_shipped: 'NE', process_stopped: 'NE', containment_done_at: agoIso_(71) },
  ['TL', 'SUPERVISOR'], [['REPACK', 'Zboží přebaleno do nové krabice', TL1, 71.5]]);
  seedDecide_(q4, 'SOLVED', 'Jednorázová chyba řidiče VZV, OJT provedeno na místě.', 70, sup1);
  Object.assign(q4, { status: ST.CLOSED_SOLVED, closed_by: sup1, closed_at: agoIso_(70) });
  seedShifts_(q4, ['R', 'O', 'N'], 70, sup1);
  seedAssess_(q4, sup1, 69, ['OK', 'OK', 'NOK', 'OK', 'OK'], 'Rychlé opatření. Příště nechat dobrý díl na tabuli.', 'IMPROVE');

  // 5 · ESCALATED + APU copy waiting for the APU manager
  const q5 = seedQrap_('WH1', 48, { what: 'Dodavatel dodal 3 palety s nesprávným počtem kusů (deklarováno 480, skutečně 440)',
    how_found: 'SUPPLIER_DELIVERY', zone: 'Příjem', location_code: 'P-02', qty: 3, unit: 'PAL', finder_name: 'Jan Novák',
    supplier: 'Dodavatel Příklad s.r.o.', hu_or_delivery_no: 'DL-2026-5512', material_no: '6600-410',
    risk_stock_shipped: 'ANO', checked_qty: 1320, wrong_found_qty: 120, process_stopped: 'NE',
    containment_done_at: agoIso_(46) }, ['TL', 'SUPERVISOR', 'QUALITY', 'PURCHASING'],
  [['BLOCK', 'Palety zablokovány v karanténě', TL1, 47], ['INFORM', 'Informován nákup a dodavatel', TL1, 46.5]]);
  const copy = escalateQrap_(q5);
  seedDecide_(q5, 'ESCALATE', 'Opakované problémy dodavatele, řešit na úrovni APU s nákupem.', 45, sup1);
  Object.assign(q5, { status: ST.ESCALATED, assign_ref: copy.qrap_id, closed_by: sup1, closed_at: agoIso_(45) });
  seedShifts_(q5, ['R', 'O', 'N'], 45, sup1);

  // 6 · ANALYSIS – repeat of #4, only 2 whys so far
  const q6 = seedQrap_('WH1', 24, { what: 'Znovu propíchnuté krabice při nakládce na rampě R-02 (4 ks)',
    how_found: 'SHIP_CHECK', zone: 'Expedice / Rampa', location_code: 'R-02', qty: 4, unit: 'BOX',
    finder_name: 'Petra Svobodová', repeat_7d: 'ANO', repeat_ref: q4.qrap_id, risk_stock_shipped: 'ANO',
    checked_qty: 36, wrong_found_qty: 4, process_stopped: 'ANO', restored_at: agoIso_(23), containment_done_at: agoIso_(23) },
  ['TL', 'SUPERVISOR', 'QUALITY'],
  [['HOLD_SHIP', 'Pozdržena expedice kamionu 2 hodiny', TL1, 23.5], ['REPACK', 'Přebaleno 4 krabice', TL1, 23.2]]);
  seedDecide_(q6, 'CONTINUE', 'Druhý případ za 3 dny + 4 NOK při kontrole.', 20, sup1);
  q6.status = ST.ANALYSIS;
  seedShifts_(q6, ['R', 'O', 'N'], 21, sup1);
  seedInsert_('PILOT', { qrap_id: q6.qrap_id, email: 'pilot1@example.com', assigned_by: sup1, assigned_at: agoIso_(20) });
  seedWhy_(q6, 'OCCURRENCE', ['Vidle VZV zajely do krabic ve spodní vrstvě palety.',
    'Řidič najížděl na paletu šikmo kvůli úzkému prostoru u rampy R-02.'], 0);

  // 7 · ACTIONS_OPEN – one action overdue, standard update = ANO
  const q7 = seedQrap_('WH1', 6 * 24, { what: 'Chybně naskladněné palety – lokace ve WMS neodpovídá fyzickému umístění',
    how_found: 'INVENTORY', zone: 'Sklad', location_code: 'S-A01', qty: 5, unit: 'PAL', finder_name: 'Jan Novák',
    material_no: '5520-300', risk_stock_shipped: 'ANO', checked_qty: 120, wrong_found_qty: 5, process_stopped: 'NE',
    containment_done_at: agoIso_(6 * 24 - 3), learned: '', std_update: 'ANO',
    std_update_ref: 'Pracovní instrukce WI-SKL-012 Naskladnění' }, ['TL', 'SUPERVISOR', 'QUALITY'],
  [['OTHER', 'Fyzická inventura uličky A', TL1, 6 * 24 - 2]]);
  seedDecide_(q7, 'CONTINUE', 'Systémový problém, nutná analýza.', 6 * 24 - 5, sup1);
  q7.status = ST.ACTIONS_OPEN;
  seedShifts_(q7, ['R', 'O', 'N'], 6 * 24 - 6, sup1);
  seedInsert_('PILOT', { qrap_id: q7.qrap_id, email: 'pilot2@example.com', assigned_by: sup1, assigned_at: agoIso_(140) });
  seedWhy_(q7, 'OCCURRENCE', ['Palety byly položeny na jinou lokaci, než potvrdil skener.',
    'Skladník potvrdil lokaci ze vzdálenosti bez skenu štítku lokace.',
    'WMS nevyžaduje sken štítku lokace při naskladnění.'], 3);
  seedWhy_(q7, 'NON_DETECTION', ['Chyba se projeví až při vychystávání nebo inventuře.',
    'Neexistuje denní kontrola obsazenosti lokací.'], 2);
  const a1 = seedAction_(q7, 'O3', 'Zapnout povinný sken štítku lokace při naskladnění ve WMS', 'pilot2@example.com', dayRel_(-3));
  seedAction_(q7, 'N2', 'Zavést denní namátkovou kontrolu 10 lokací', 'pilot1@example.com', dayRel_(5));
  seedAction_(q7, 'STD', 'Aktualizovat standard: Pracovní instrukce WI-SKL-012 Naskladnění', 'pilot2@example.com', dayRel_(10));
  seedInsert_('ACTION_NOTE', { id: newId_('AN'), action_id: a1.id, note: 'Čekáme na úpravu nastavení skenerů od IT.',
    review_date: dayRel_(0), review_done: false, author: 'pilot2@example.com', at: agoIso_(30) });
  seedAssess_(q7, 'manager@example.com', 2, ['OK', 'OK', 'NA', 'OK', 'NOK'], 'Dobrá analýza, chybí OJT se skladníkem.', 'IMPROVE');

  // 8 · VERIFY (WH2) – 3 of 5 shifts effective
  const q8 = seedQrap_('WH2', 10 * 24, { what: 'Nesprávné balení – chybí proložka mezi vrstvami, poškrábané díly',
    how_found: 'PACKING', zone: 'Balení', location_code: 'B-01', qty: 12, unit: 'PCS', finder_name: 'Milan Horák',
    material_no: '7788-001', risk_stock_shipped: 'ANO', checked_qty: 240, wrong_found_qty: 12, process_stopped: 'NE',
    containment_done_at: agoIso_(10 * 24 - 2), learned: 'Balicí předpis nebyl u balicího stolu B-01 vyvěšen.',
    std_update: 'NE' }, ['TL', 'SUPERVISOR', 'QUALITY'],
  [['REPACK', 'Přebaleno 240 ks s proložkou', 'Irena Malá', 10 * 24 - 1]]);
  seedDecide_(q8, 'CONTINUE', 'Riziko u zákazníka, nutná analýza.', 9 * 24, sup2);
  q8.status = ST.VERIFY;
  seedShifts_(q8, ['R', 'O', 'N'], 9 * 24, sup2);
  seedInsert_('PILOT', { qrap_id: q8.qrap_id, email: 'pilot2@example.com', assigned_by: sup2, assigned_at: agoIso_(9 * 24) });
  seedWhy_(q8, 'OCCURRENCE', ['Balič nevložil proložku mezi vrstvy.', 'Nevěděl, že materiál 7788-001 proložku vyžaduje.',
    'Balicí předpis nebyl u stolu B-01 k dispozici.'], 3);
  seedAction_(q8, 'O3', 'Vyvěsit balicí předpisy u všech balicích stolů', 'pilot2@example.com', dayRel_(-6), dayRel_(-5));
  seedEff_(q8, 1, -3, 'R', 'EFFECTIVE');
  seedEff_(q8, 2, -3, 'O', 'EFFECTIVE');
  seedEff_(q8, 3, -2, 'R', 'EFFECTIVE');

  // 9 · CLOSED (WH2) – full cycle
  const q9 = seedQrap_('WH2', 14 * 24, { what: 'Záměna materiálu při vychystávání – 4711-200 místo 4711-020',
    how_found: 'PICKING', zone: 'Vychystávání', location_code: 'V-02', qty: 6, unit: 'PCS', finder_name: 'Milan Horák',
    material_no: '4711-020', risk_stock_shipped: 'ANO', checked_qty: 60, wrong_found_qty: 0, process_stopped: 'NE',
    containment_done_at: agoIso_(14 * 24 - 2), learned: 'Podobná čísla materiálu v sousedních lokacích.',
    std_update: 'ANO', std_update_ref: 'WI-VYCH-004 Rozmístění materiálu' }, ['TL', 'SUPERVISOR', 'QUALITY'],
  [['OTHER', 'Zboží vyměněno před expedicí', 'Irena Malá', 14 * 24 - 1]]);
  seedDecide_(q9, 'CONTINUE', 'Riziko záměny u dalších materiálů.', 13 * 24, sup2);
  Object.assign(q9, { status: ST.CLOSED, closed_by: sup2, closed_at: agoIso_(24), locked_parts: 'QR,DECISION,ANALYSIS' });
  seedShifts_(q9, ['R', 'O', 'N'], 13 * 24, sup2);
  seedInsert_('PILOT', { qrap_id: q9.qrap_id, email: 'pilot1@example.com', assigned_by: sup2, assigned_at: agoIso_(13 * 24) });
  seedWhy_(q9, 'OCCURRENCE', ['Picker vzal materiál ze sousední lokace.', 'Materiály 4711-200 a 4711-020 leží vedle sebe.',
    'Rozmístění nebere ohled na podobná čísla materiálu.'], 3);
  seedAction_(q9, 'O3', 'Rozdělit podobná čísla materiálu do různých uliček', 'pilot1@example.com', dayRel_(-10), dayRel_(-9));
  seedAction_(q9, 'STD', 'Aktualizovat standard: WI-VYCH-004 Rozmístění materiálu', 'pilot1@example.com', dayRel_(-8), dayRel_(-8));
  [[-7, 'R'], [-7, 'O'], [-6, 'N'], [-5, 'R'], [-4, 'O']].forEach((x, i) => seedEff_(q9, i + 1, x[0], x[1], 'EFFECTIVE'));
  seedAssess_(q9, sup2, 13 * 24 - 2, ['OK', 'OK', 'OK', 'OK', 'OK'], 'Vzorový QRAP, sdílet na WH1.', 'PRAISE');
  seedAssess_(q9, 'manager@example.com', 20, ['OK', 'OK', 'OK', 'OK', 'OK'], 'Silná analýza rozmístění.', 'STRENGTH');
}
