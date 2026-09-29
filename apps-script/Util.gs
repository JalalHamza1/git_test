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
