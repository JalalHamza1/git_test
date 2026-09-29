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
