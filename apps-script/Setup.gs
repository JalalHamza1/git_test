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
