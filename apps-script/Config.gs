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
