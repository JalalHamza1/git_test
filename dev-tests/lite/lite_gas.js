// Minimal mocks of the Apps Script services used by eQRAP, for local testing in Node.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', '..', 'eqrap-lite');

function makeEnv(opts) {
  opts = opts || {};
  const state = {
    activeUser: opts.owner || 'owner@example.com',
    owner: opts.owner || 'owner@example.com',
    sent: [], toasts: [],
    props: {},
    cache: {},
    triggers: [],
    files: {},
    folders: {},
    calls: { getValues: 0, setValues: 0 },
    spreadsheetTz: 'Etc/UTC'
  };

  // ---------------- Utilities
  function partsIn(d, tz) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23' });
    const o = {};
    f.formatToParts(d).forEach(p => { o[p.type] = p.value; });
    const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour, M: +o.minute, S: +o.second, dow: dowMap[o.weekday] };
  }
  function formatDate(d, tz, pattern) {
    if (!(d instanceof Date) || isNaN(d)) throw new Error('formatDate: invalid date ' + d);
    const p = partsIn(d, tz);
    const offMin = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - Math.floor(d.getTime() / 1000) * 1000) / 60000);
    const pad = (n, l) => String(n).padStart(l || 2, '0');
    const sign = offMin < 0 ? '-' : '+';
    const a = Math.abs(offMin);
    return pattern.replace(/yyyy|MM|M|dd|d|HH|mm|ss|u|XXX|Z|'[^']*'/g, t => {
      switch (t) {
        case 'yyyy': return String(p.y);
        case 'MM': return pad(p.m);
        case 'M': return String(p.m);
        case 'dd': return pad(p.d);
        case 'd': return String(p.d);
        case 'HH': return pad(p.H);
        case 'mm': return pad(p.M);
        case 'ss': return pad(p.S);
        case 'u': return String(p.dow);
        case 'Z': return sign + pad(Math.floor(a / 60)) + pad(a % 60);
        case 'XXX': return sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
        default: return t.slice(1, -1);
      }
    });
  }
  function newBlob(bytes, mime, name) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return { getBytes: () => Array.from(buf), getContentType: () => mime, getName: () => name, _buf: buf };
  }
  const Utilities = {
    formatDate,
    getUuid: () => crypto.randomUUID(),
    base64Decode: s => Array.from(Buffer.from(s, 'base64')),
    base64Encode: b => Buffer.from(b).toString('base64'),
    newBlob,
    sleep: () => {}
  };

  // ---------------- SpreadsheetApp
  class Range {
    constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
    _check() {
      if (this.r < 1 || this.c < 1 || this.r + this.nr - 1 > this.sheet.maxRows || this.c + this.nc - 1 > this.sheet.maxCols) {
        throw new Error('The coordinates of the range are outside the dimensions of the sheet. (' + this.sheet.name +
          ' r' + this.r + ' n' + this.nr + ' max ' + this.sheet.maxRows + ')');
      }
    }
    getValues() {
      this._check();
      state.calls.getValues++;
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = (this.sheet.data[this.r - 1 + i] || [])[this.c - 1 + j];
          row.push(v === undefined ? '' : (v instanceof Date ? new Date(v.getTime()) : v));
        }
        out.push(row);
      }
      return out;
    }
    setValues(vals) {
      this._check();
      state.calls.setValues++;
      if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) {
        throw new Error('setValues dimension mismatch on ' + this.sheet.name + ': ' + vals.length + 'x' + (vals[0] || []).length +
          ' vs ' + this.nr + 'x' + this.nc);
      }
      for (let i = 0; i < this.nr; i++) {
        const rowIdx = this.r - 1 + i;
        while (this.sheet.data.length <= rowIdx) this.sheet.data.push([]);
        for (let j = 0; j < this.nc; j++) {
          let v = vals[i][j];
          if (v !== null && typeof v === 'object' && !(v instanceof Date)) throw new Error('setValues: object value ' + JSON.stringify(v));
          if (typeof v === 'string' && /^[=+@]/.test(v)) throw new Error('FORMULA WRITTEN: ' + v);
          if (typeof v === 'string' && /^-?\d+$/.test(v) && v.length > 1 && v[0] === '0') throw new Error('LEADING ZERO LOST: ' + v);
          if (typeof v === 'string' && v.charAt(0) === "'") v = v.slice(1); // Sheets strips the apostrophe
          this.sheet.data[rowIdx][this.c - 1 + j] = v === undefined || v === null ? '' : v;
        }
      }
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setDataValidation(v) { this.sheet.validations.push(v); return this; }
    getSheet() { return this.sheet; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; this.maxCols = 26; this.protections = []; this.validations = []; }
    protect() { const p = { setDescription: () => p, setWarningOnly: w => { p.warn = w; return p; } }; this.protections.push(p); return p; }
    getProtections() { return this.protections.slice(); }
    getName() { return this.name; }
    getLastRow() {
      for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
      return 0;
    }
    getLastColumn() {
      let m = 0;
      this.data.forEach(r => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== '' && r[j] !== undefined) { m = Math.max(m, j + 1); break; } });
      return m;
    }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    insertRowsAfter(after, n) { this.maxRows += n; }
    insertColumnsAfter(after, n) { this.maxCols += n; }
    getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
    getRange(r, c, nr, nc) {
      if (typeof r === 'string') throw new Error('A1 not supported in mock');
      return new Range(this, r, c, nr || 1, nc || 1);
    }
    setFrozenRows() { return this; }
    appendRow(row) { this.getRange(this.getLastRow() + 1, 1, 1, row.length).setValues([row]); }
  }
  const ss = {
    sheets: {},
    getId: () => 'SS-ID',
    getSheetByName(n) { return this.sheets[n] || null; },
    insertSheet(n) { const s = new Sheet(n); this.sheets[n] = s; return s; },
    getSheets() { return Object.values(this.sheets); },
    setSpreadsheetTimeZone(tz) { state.spreadsheetTz = tz; },
    getSpreadsheetTimeZone() { return state.spreadsheetTz; },
    toast: m => { state.toasts.push(m); }
  };
  const dv = () => { const b = { requireValueInList: (l) => { b.list = l; return b; }, setAllowInvalid: () => b, setHelpText: () => b, build: () => ({ list: b.list }) }; return b; };
  const SpreadsheetApp = { getActiveSpreadsheet: () => ss, getActive: () => ss, openById: () => ss, newDataValidation: dv,
    ProtectionType: { SHEET: 'SHEET' },
    getUi: () => { const m = { items: [], addItem: (a, b) => { m.items.push([a, b]); return m; }, addSeparator: () => m, addToUi: () => { state.menu = m.items; } };
      return { createMenu: () => m }; } };

  // ---------------- other services
  const Session = {
    getActiveUser: () => ({ getEmail: () => state.activeUser }),
    getEffectiveUser: () => ({ getEmail: () => state.owner }),
    getScriptTimeZone: () => 'Europe/Prague'
  };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {}, hasLock: () => true }) };
  const cacheObj = {
    get: k => (k in state.cache ? state.cache[k] : null),
    put: (k, v) => { if (String(v).length > 100000) throw new Error('cache value too big ' + k); state.cache[k] = String(v); },
    remove: k => { delete state.cache[k]; },
    putAll: (o) => Object.keys(o).forEach(k => cacheObj.put(k, o[k])),
    getAll: ks => { const o = {}; ks.forEach(k => { if (k in state.cache) o[k] = state.cache[k]; }); return o; },
    removeAll: ks => ks.forEach(k => delete state.cache[k])
  };
  const CacheService = { getScriptCache: () => cacheObj };
  const PropertiesService = { getScriptProperties: () => ({
    getProperty: k => (k in state.props ? state.props[k] : null),
    setProperty: (k, v) => { state.props[k] = String(v); },
    deleteProperty: k => { delete state.props[k]; }
  }) };
  const MailApp = {
    sendEmail: o => { if (typeof o !== 'object') throw new Error('sendEmail expects object'); state.sent.push(o); },
    getRemainingDailyQuota: () => 1500
  };
  let fileSeq = 0;
  function mkFolder(id, name) {
    const f = {
      id, name, children: [],
      getId: () => id, getName: () => name,
      getFoldersByName: n => { const list = f.children.filter(c => c.name === n); let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; },
      createFolder: n => { const c = mkFolder('FOLDER-' + (++fileSeq), n); f.children.push(c); state.folders[c.id] = c; return c; },
      createFile: blob => { const fid = 'FILE-' + (++fileSeq); state.files[fid] = { id: fid, blob }; return { getId: () => fid }; }
    };
    return f;
  }
  state.folders.PHOTOS = mkFolder('PHOTOS', 'eQRAP photos');
  const DriveApp = {
    createFolder: n => { const c = mkFolder('FOLDER-' + (++fileSeq), n); state.folders[c.id] = c; return c; },
    getFolderById: id => { if (!state.folders[id]) throw new Error('No folder ' + id); return state.folders[id]; },
    getFileById: id => { const f = state.files[id]; if (!f) throw new Error('No file ' + id); return { getBlob: () => f.blob, getName: () => f.blob.getName() }; }
  };
  function evalTemplate(name, vars) {
    let html = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
    html = html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (m, n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8'));
    html = html.replace(/<\?!=\s*(\w+)\s*;?\s*\?>/g, (m, v) => vars[v]);
    return html;
  }
  const HtmlService = {
    createTemplateFromFile: name => {
      const tpl = { evaluate: () => {
        const content = evalTemplate(name, tpl);
        const out = { getContent: () => content, setTitle: () => out, addMetaTag: () => out, setXFrameOptionsMode: () => out };
        return out;
      } };
      return tpl;
    },
    createHtmlOutputFromFile: name => ({ getContent: () => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8') })
  };
  function triggerBuilder(handler) {
    const b = { handler, timeBased: () => b, everyHours: () => b, atHour: () => b, nearMinute: () => b, everyDays: () => b,
      inTimezone: () => b, onWeekDay: () => b,
      create: () => { const t = { getHandlerFunction: () => handler }; state.triggers.push(t); return t; } };
    return b;
  }
  const ScriptApp = {
    getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/example.com/s/TEST/exec' }),
    newTrigger: h => triggerBuilder(h),
    getProjectTriggers: () => state.triggers.slice(),
    deleteTrigger: t => { state.triggers = state.triggers.filter(x => x !== t); },
    WeekDay: { SUNDAY: 'SUNDAY' }
  };
  const logs = [];
  const Logger = { log: (fmt, ...args) => { let i = 0; const s = String(fmt).replace(/%s/g, () => String(args[i++])); logs.push(s); if (opts.verbose) console.log('[Logger]', s); } };
  const consoleProxy = {
    log: (...a) => { if (opts.verbose) console.log('[console]', ...a); },
    warn: (...a) => { logs.push('WARN ' + a.join(' ')); if (opts.verbose) console.log('[warn]', ...a); },
    error: (...a) => { logs.push('ERROR ' + a.join(' ')); console.log('[error]', ...a); }
  };

  const ctx = vm.createContext({
    Utilities, SpreadsheetApp, Session, LockService, CacheService, PropertiesService, MailApp, DriveApp,
    HtmlService, ScriptApp, Logger, console: consoleProxy, Date, JSON, Math, Object, Array, String, Number,
    Boolean, RegExp, Error, isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, Intl, Set, Map, Infinity
  });
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort();
  const code = files.map(f => '// ---- ' + f + '\n' + fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  vm.runInContext(code, ctx, { filename: 'all.gs' });
  // Reset per-call globals like Apps Script does for every server call.
  const RESET = 'MEMO_={};CFG_=null;ME_=null;NO_MAIL_=false;';
  function call(fn, ...args) {
    vm.runInContext(RESET, ctx);
    ctx.__args = JSON.parse(JSON.stringify(args)); // the browser can only send plain JSON
    const res = vm.runInContext(fn + '.apply(null, __args)', ctx);
    // Everything returned to the browser must be JSON-safe (no Date objects)
    if (res !== undefined) {
      const walk = (v, p) => {
        if (v instanceof Date) throw new Error('Date object returned at ' + p + ' from ' + fn);
        if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k));
      };
      walk(res, fn);
    }
    return res === undefined ? undefined : JSON.parse(JSON.stringify(res));
  }
  function as(email) { state.activeUser = email; }
  function sheetRows(name) {
    const s = ss.sheets[name];
    const h = s.data[0];
    return s.data.slice(1).filter(r => r.some(v => v !== '')).map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; });
  }
  function setConfig(key, value) {
    const s = ss.sheets['Nastavení'];
    const row = s.data.find(r => r[0] === key);
    if (row) row[1] = value; else s.data.push([key, value]);
    delete state.cache.cfg;
  }
  return { ctx, state, call, as, ss, sheetRows, setConfig, logs, run: code => vm.runInContext(RESET + code, ctx) };
}

module.exports = { makeEnv };
