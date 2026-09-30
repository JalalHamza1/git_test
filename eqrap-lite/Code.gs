/**
 * eQRAP Expedice (Lite) – server part. Everything the server does is in this one file.
 *
 * HOW IT FITS TOGETHER
 *   Google Sheet = database + all settings (tabs: Problémy, Akce, Historie | Lidé, Seznamy, Nastavení)
 *   Code.gs      = reads/writes the Sheet, checks who may do what, sends e-mails
 *   Index.html   = the whole screen; it receives all data when the page opens, so clicking around is instant
 *
 * ADMIN: you normally never edit this file. People, roles, lists and settings are edited in the Sheet.
 *
 * SECTIONS
 *   1. Tabs, columns, defaults     5. Permissions (who may do what)
 *   2. Web app entry (doGet)       6. Sheet helpers
 *   3. API used by the page        7. E-mails and daily reminder
 *   4. Status rules                8. Setup, admin menu, example data
 */

// =====================================================================================
// 1. TABS, COLUMNS, DEFAULTS
// =====================================================================================

const TAB = { qraps: 'Problémy', actions: 'Akce', log: 'Historie', people: 'Lidé', lists: 'Seznamy', settings: 'Nastavení' };

// [name used in the code, column header in the Sheet]. Do not rename these headers in the Sheet.
const COLS = {
  'Problémy': [
    ['id', 'ID'], ['status', 'Stav'], ['created', 'Nahlášeno'], ['createdBy', 'Účet'],
    ['reporter', '① Kdo hlásí'], ['area', '① Oblast'], ['type', '① Typ problému'], ['what', '① Co se stalo'],
    ['where', '① Kde přesně'], ['when', '① Kdy zjištěno'], ['how', '① Jak zjištěno'], ['customer', '① Zákazník'],
    ['partNo', '① Číslo dílu'], ['delivery', '① Dodací list / zásilka'], ['qty', '① Množství NOK'],
    ['safety', '① Bezpečnost'], ['photos', '① Fotky'], ['notified', '② Kdo byl upozorněn'],
    ['s3Action', '③ Co bylo uděláno'], ['s3Places', '③ Kde zkontrolováno'], ['s3Checked', '③ Zkontrolováno ks'],
    ['s3Nok', '③ Nalezeno NOK ks'], ['s3Customer', '③ Zákazník informován'], ['s3By', '③ Kdo'], ['s3Done', '③ Hotovo'],
    ['decision', '④ Rozhodnutí'], ['decisionNote', '④ Poznámka'], ['decisionBy', '④ Rozhodl'], ['decisionAt', '④ Kdy'],
    ['why1', '⑤ Proč 1'], ['why2', '⑤ Proč 2'], ['why3', '⑤ Proč 3'], ['why4', '⑤ Proč 4'], ['why5', '⑤ Proč 5'],
    ['rootCause', '⑤ Hlavní příčina'], ['causeType', '⑤ Kategorie příčiny'],
    ['effective', '⑥ Účinné'], ['effectiveNote', '⑥ Ověření – poznámka'], ['effectiveBy', '⑥ Ověřil'], ['effectiveAt', '⑥ Ověřeno'],
    ['a1', '⑦ Red box'], ['a2', '⑦ Rozdělení'], ['a3', '⑦ Porovnání'], ['a4', '⑦ Poučení a sdílení'], ['a5', '⑦ OJT'],
    ['aNote', '⑦ Komentář'], ['aBy', '⑦ Hodnotil'], ['aAt', '⑦ Kdy'],
    ['closedAt', 'Uzavřeno'], ['cancelReason', 'Zrušeno – důvod'], ['updated', 'Změněno'], ['updatedBy', 'Změnil']
  ],
  'Akce': [
    ['qrapId', 'QRAP'], ['no', 'Č.'], ['text', 'Akce'], ['owner', 'Odpovědný'], ['ownerEmail', 'E-mail'],
    ['due', 'Termín'], ['done', 'Hotovo'], ['note', 'Poznámka'], ['created', 'Vytvořeno']
  ],
  'Historie': [['at', 'Kdy'], ['by', 'Kdo'], ['qrapId', 'QRAP'], ['text', 'Co se stalo']]
};
const TIME_KEYS = ['created', 'when', 's3Done', 'decisionAt', 'effectiveAt', 'aAt', 'closedAt', 'updated', 'done', 'at'];
const NUMBER_KEYS = ['qty', 's3Checked', 's3Nok', 'no'];
const DATE_KEYS = ['due'];

// Tab "Nastavení": [key, default value, explanation shown next to it]
const SETTINGS = [
  ['NAZEV', 'eQRAP Expedice', 'Název aplikace – nahoře na stránce a v e-mailech.'],
  ['EMAILY', 'ANO', 'ANO = posílat e-maily, NE = neposílat (např. při zkoušení).'],
  ['LHUTA_OPATRENI_HODIN', 24, 'Do kolika hodin od zjištění mají být hotová ③ okamžitá opatření.'],
  ['ZOBRAZIT_UZAVRENE_DNI', 60, 'Kolik dní zpět se na přehledu ukazují uzavřené problémy.'],
  ['KIOSK_NAVRAT_SEKUND', 120, 'Kiosk: po kolika sekundách bez dotyku se obrazovka vrátí na přehled.'],
  ['ODKAZ_APLIKACE', '', 'Adresa aplikace do e-mailů. Prázdné = zjistí se automaticky.'],
  ['FOTKY_SLOZKA_ID', '', 'ID složky na Disku Google pro fotky. Vyplní se samo při setupu.']
];

// Tab "Seznamy": [name in code, column header, default values]. The admin edits the values in the Sheet.
const LISTS = [
  ['areas', 'Oblasti', ['Příjem', 'Sklad', 'Vychystávání', 'Balení', 'Expedice', 'Nakládka / doprava', 'Vratné obaly']],
  ['types', 'Typy problému', ['Chybné množství', 'Záměna dílu', 'Chybná nebo chybějící etiketa', 'Poškozený díl nebo obal',
    'Chybná nebo chybějící dokumentace', 'Pozdní expedice / nakládka', 'Chyba v systému (SAP / WMS)', 'Bezpečnost / úraz', 'Jiné']],
  ['how', 'Jak zjištěno', ['Kontrola při vychystávání', 'Kontrola při nakládce', 'Inventura', 'Reklamace zákazníka',
    'Upozornění dopravce', 'Audit', 'Jiné']],
  ['notify', 'Kdo byl upozorněn', ['Vedoucí směny', 'Mistr skladu', 'Vedoucí expedice', 'Kvalita', 'Zákaznický servis',
    'Dopravce', 'BOZP / EHS']],
  ['places', 'Kde zkontrolováno', ['Sklad', 'Připraveno k expedici', 'Rampa / kamion', 'V přepravě', 'U zákazníka']],
  ['causes', 'Kategorie příčiny', ['Člověk', 'Postup / metoda', 'Materiál / obal', 'Systém (SAP / WMS)', 'Prostředí',
    'Dodavatel / dopravce']]
];

// Example people written by setup. The admin replaces them with real colleagues.
const EXAMPLE_PEOPLE = [
  ['Jana Nováková', 'jana.novakova@example.com', 'VEDOUCÍ', 'Expedice', 'ANO'],
  ['Petr Svoboda', 'petr.svoboda@example.com', 'VEDOUCÍ', 'Sklad', 'ANO'],
  ['Eva Dvořáková', 'eva.dvorakova@example.com', 'MANAŽER', '', 'ANO'],
  ['Tomáš Černý', 'tomas.cerny@example.com', '', 'Expedice', 'ANO'],
  ['Kiosk Expedice', 'kiosk.expedice@example.com', '', 'Expedice', 'ANO']
];

const DECISIONS = {
  'VYŘEŠENO': 'Problém vyřešen – uzavřít bez 5× Proč',
  'ANALÝZA': 'Pokračovat analýzou 5× Proč',
  'ESKALACE': 'Eskalace na manažera'
};
const NEXT_STEP = {
  'OPATŘENÍ': '③ okamžitá opatření', 'ROZHODNUTÍ': '④ rozhodnutí vedoucího',
  'ANALÝZA': '⑤ příčina a ⑥ akce', 'OVĚŘENÍ': '⑥ ověření účinnosti'
};
const MAX_PHOTOS = 5;

// Per-request memory (each server call starts with empty values).
let MEMO_ = {};
let CFG_ = null;
let ME_ = null;
let NO_MAIL_ = false;

// =====================================================================================
// 2. WEB APP ENTRY
// =====================================================================================

/** Opens the app. All data the page needs is sent together with the page, so it shows immediately. */
function doGet(e) {
  const page = HtmlService.createTemplateFromFile('Index');
  let boot;
  try {
    boot = startData_((e && e.parameter) || {});
  } catch (err) {
    boot = { error: String((err && err.message) || err) };
  }
  page.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return page.evaluate()
    .setTitle(boot.cfg ? boot.cfg.NAZEV : 'eQRAP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function startData_(params) {
  const c = cfg_();
  const data = listData_(false);
  return {
    me: me_(),
    cfg: c.settings,
    lists: c.lists,
    people: c.people.filter(p => p.active).map(p => ({ name: p.name, email: p.email })),
    qraps: data.qraps,
    actions: data.actions,
    params: { id: String(params.id || ''), view: String(params.view || ''), kiosk: String(params.kiosk || '') }
  };
}

// =====================================================================================
// 3. API – functions the page calls with google.script.run
//    Each one checks permissions itself, saves, and returns the fresh problem.
// =====================================================================================

/** Reload the list (auto-refresh and the ⟳ button). all = include old closed problems. */
function apiRefresh(all) {
  return listData_(!!all);
}

/** One problem with its actions (the page calls this in the background when a problem is opened). */
function apiGet(id) {
  return pack_(id);
}

/** ① ② (and optionally ③) – report a new problem. Anyone in the company may do this. */
function apiCreate(f) {
  f = f || {};
  const me = me_();
  const q = popisFrom_(f);
  const s3 = f.s3 ? opatreniFrom_(f.s3, '') : null;
  const photoIds = (f.photos || []).slice(0, MAX_PHOTOS).map(savePhoto_);
  return lock_(() => {
    q.id = nextId_(table_(TAB.qraps).rows);
    q.created = nowIso_();
    q.createdBy = me.email;
    q.photos = photoIds.join(',');
    if (s3) Object.assign(q, s3);
    finish_(q, [], 'Nahlášeno: ' + short_(q.what), true);
    if (q.s3Done) log_(q.id, '③ Okamžitá opatření vyplněna');
    mailNew_(q);
    return pack_(q.id);
  });
}

/**
 * Save one part of the form.
 * part: 'popis' (① ②) | 'opatreni' (③) | 'rozhodnuti' (④) | 'pricina' (⑤) | 'overeni' (⑥ check) | 'hodnoceni' (⑦)
 */
function apiSave(id, part, f) {
  f = f || {};
  return lock_(() => {
    const me = me_();
    const q = find_(id);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts);
    let text;

    if (part === 'popis') {
      need_(canPopis_(me, q), 'Popis může upravit ten, kdo problém nahlásil (do rozhodnutí), nebo vedoucí.');
      Object.assign(q, popisFrom_(f));
      text = '①② Popis upraven';

    } else if (part === 'opatreni') {
      need_(canOpatreni_(me, q), 'Po rozhodnutí vedoucího může okamžitá opatření měnit jen vedoucí.');
      Object.assign(q, opatreniFrom_(f, q.s3Done));
      text = '③ Okamžitá opatření uložena';

    } else if (part === 'rozhodnuti') {
      need_(me.lead, 'Rozhoduje vedoucí nebo manažer.');
      need_(canDecide_(me, q), 'Nejdřív musí být hotová ③ okamžitá opatření.');
      const d = oneOf_(f.decision, Object.keys(DECISIONS), 'Vyberte rozhodnutí.');
      const wasEscalated = q.decision === 'ESKALACE';
      q.decision = d;
      q.decisionNote = txt_(f.decisionNote);
      q.decisionBy = me.name;
      q.decisionAt = nowIso_();
      text = '④ Rozhodnutí: ' + DECISIONS[d];
      if (d === 'ESKALACE' && !wasEscalated) mailEscalated_(q);

    } else if (part === 'pricina') {
      need_(canAnalyze_(me, q), 'Příčinu vyplňuje vedoucí po rozhodnutí „analýza“ nebo „eskalace“.');
      ['why1', 'why2', 'why3', 'why4', 'why5'].forEach(k => { q[k] = txt_(f[k]); });
      q.rootCause = txt_(f.rootCause);
      q.causeType = txt_(f.causeType, 100);
      need_(q.why1 && q.rootCause, 'Vyplňte alespoň „Proč 1“ a hlavní příčinu.');
      text = '⑤ Příčina: ' + short_(q.rootCause);

    } else if (part === 'overeni') {
      need_(canVerify_(me, q), 'Ověřit lze, až je vyplněná příčina a všechny akce jsou hotové (vedoucí nebo manažer).');
      q.effective = oneOf_(f.effective, ['ANO', 'NE'], 'Vyberte, zda jsou akce účinné.');
      q.effectiveNote = txt_(f.effectiveNote);
      need_(q.effective === 'ANO' || q.effectiveNote, 'Napište, co se znovu objevilo.');
      q.effectiveBy = me.name;
      q.effectiveAt = nowIso_();
      text = q.effective === 'ANO' ? '⑥ Ověřeno: akce jsou účinné' : '⑥ Ověřeno: NEúčinné – je potřeba další akce';

    } else if (part === 'hodnoceni') {
      need_(canAssess_(me, q), 'Hodnotí vedoucí nebo manažer.');
      ['a1', 'a2', 'a3', 'a4', 'a5'].forEach(k => { q[k] = oneOf_(f[k], ['OK', 'NOK', 'N/A'], 'Ohodnoťte všech 5 bodů.'); });
      q.aNote = txt_(f.aNote);
      q.aBy = me.name;
      q.aAt = nowIso_();
      text = '⑦ Hodnocení QRQC uloženo';

    } else {
      throw new Error('Neznámá část formuláře: ' + part);
    }
    finish_(q, acts, text);
    return pack_(id);
  });
}

/**
 * ⑥ Add or change an action.
 *   new action:  {text, owner, due, note}           – leader only
 *   change:      {no, text, owner, due, note, done} – leader
 *   mark done:   {no, done: true}                    – leader or the person responsible
 */
function apiSaveAction(id, a) {
  a = a || {};
  return lock_(() => {
    const me = me_();
    const q = find_(id);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts);
    need_(isOpen_(q), 'Problém je uzavřený.');
    let text;

    if (a.no) {
      const act = acts.filter(x => x.no === Number(a.no))[0];
      need_(act, 'Akce nenalezena.');
      const isOwner = me.email && act.ownerEmail === me.email;
      need_(me.lead || isOwner, 'Akci může označit jako hotovou jen odpovědná osoba nebo vedoucí.');
      if (me.lead && a.text !== undefined) {
        const before = act.ownerEmail;
        Object.assign(act, actionFields_(a));
        if (act.ownerEmail && act.ownerEmail !== before) mailAction_(q, act);
      }
      if (a.done === true && !act.done) act.done = nowIso_();
      if (a.done === false && me.lead) act.done = '';
      update_(TAB.actions, act);
      text = '⑥ Akce ' + act.no + (act.done ? ' hotová' : ' upravena') + ': ' + short_(act.text);
    } else {
      need_(canAnalyze_(me, q), 'Akce zadává vedoucí po rozhodnutí „analýza“ nebo „eskalace“.');
      const act = Object.assign({
        qrapId: id, no: acts.reduce((m, x) => Math.max(m, x.no || 0), 0) + 1, done: '', created: nowIso_()
      }, actionFields_(a));
      insert_(TAB.actions, act);
      acts.push(act);
      if (q.effective === 'NE') q.effective = ''; // a new round after a failed check
      text = '⑥ Nová akce ' + act.no + ': ' + short_(act.text) + ' (' + act.owner + ', do ' + act.due + ')';
      mailAction_(q, act);
    }
    finish_(q, acts, text);
    return pack_(id);
  });
}

/** ① Add a photo to an existing problem. dataUrl = "data:image/jpeg;base64,…" (the page shrinks photos first). */
function apiAddPhoto(id, dataUrl) {
  return lock_(() => {
    const me = me_();
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id));
    need_(canPopis_(me, q), 'Fotku může přidat ten, kdo problém nahlásil (do rozhodnutí), nebo vedoucí.');
    const ids = list_(q.photos);
    need_(ids.length < MAX_PHOTOS, 'Maximálně ' + MAX_PHOTOS + ' fotek.');
    ids.push(savePhoto_(dataUrl));
    q.photos = ids.join(',');
    finish_(q, actionsOf_(id), '① Přidána fotka');
    return pack_(id);
  });
}

/** Returns one photo as a data URL. Only photos that belong to this problem can be read. */
function apiPhoto(id, fileId) {
  const q = find_(id);
  need_(list_(q.photos).indexOf(fileId) >= 0, 'Fotka k tomuto problému nepatří.');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/** Change history of one problem, newest first. */
function apiHistory(id) {
  return table_(TAB.log).rows.filter(r => r.qrapId === id).reverse()
    .map(r => ({ at: r.at, by: r.by, text: r.text }));
}

/** Manager only: 'cancel' an open problem (with a reason) or 'reopen' a closed / cancelled one. */
function apiAdmin(id, op, reason) {
  return lock_(() => {
    const me = me_();
    need_(me.manager, 'Tuto akci může provést jen manažer.');
    const q = find_(id);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts);
    let text;
    if (op === 'cancel') {
      need_(isOpen_(q), 'Problém už je uzavřený.');
      q.cancelReason = txt_(reason, 300);
      need_(q.cancelReason, 'Napište důvod zrušení.');
      text = 'Zrušeno: ' + q.cancelReason;
    } else if (op === 'reopen') {
      need_(!isOpen_(q), 'Problém je otevřený.');
      if (q.cancelReason) q.cancelReason = '';
      else if (q.effective === 'ANO') q.effective = '';
      else q.decision = '';
      text = 'Znovu otevřeno' + (reason ? ': ' + txt_(reason, 300) : '');
    } else {
      throw new Error('Neznámá operace.');
    }
    finish_(q, acts, text);
    return pack_(id);
  });
}

// =====================================================================================
// 4. STATUS RULES – the status is always calculated from what is filled in
// =====================================================================================

function statusOf_(q, acts) {
  if (q.cancelReason) return 'ZRUŠENO';
  if (!q.s3Done) return 'OPATŘENÍ';                       // ③ not done yet
  if (!q.decision) return 'ROZHODNUTÍ';                   // ④ waiting for the leader
  if (q.decision === 'VYŘEŠENO' || q.effective === 'ANO') return 'UZAVŘENO';
  const allDone = acts.length > 0 && acts.every(a => a.done);
  return q.rootCause && allDone && q.effective !== 'NE' ? 'OVĚŘENÍ' : 'ANALÝZA';
}

function isOpen_(q) {
  return q.status !== 'UZAVŘENO' && q.status !== 'ZRUŠENO';
}

/** Recalculate the status, save the row and write one line to the history. */
function finish_(q, acts, text, isNew) {
  const me = me_();
  const before = q.status;
  q.status = statusOf_(q, acts);
  if (q.status === 'UZAVŘENO' && !q.closedAt) q.closedAt = nowIso_();
  if (q.status !== 'UZAVŘENO') q.closedAt = '';
  q.updated = nowIso_();
  q.updatedBy = me.email;
  if (isNew) insert_(TAB.qraps, q); else update_(TAB.qraps, q);
  log_(q.id, text);
  if (!isNew && before !== 'UZAVŘENO' && q.status === 'UZAVŘENO') log_(q.id, 'Uzavřeno');
}

// =====================================================================================
// 5. PERMISSIONS
//    Anyone in the company: report ①②, fill ③ (until the decision), mark own action done.
//    VEDOUCÍ (leader):      everything in the form ④ ⑤ ⑥ ⑦.
//    MANAŽER:               like a leader + cancel / reopen. The owner of the script is always MANAŽER.
// =====================================================================================

function me_() {
  if (ME_) return ME_;
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { email = ''; }
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const p = cfg_().people.filter(x => x.active && x.email && x.email === email)[0];
  let role = p ? p.role : '';
  if (email && email === owner) role = 'MANAŽER';
  ME_ = {
    email: email,
    name: p ? p.name : (email ? email.split('@')[0] : ''),
    role: role,
    area: p ? p.area : '',
    lead: role === 'VEDOUCÍ' || role === 'MANAŽER',
    manager: role === 'MANAŽER'
  };
  return ME_;
}

function canPopis_(me, q) { return isOpen_(q) && (me.lead || (!!me.email && q.createdBy === me.email && !q.decision)); }
function canOpatreni_(me, q) { return isOpen_(q) && (me.lead || !q.decision); }
function canDecide_(me, q) { return me.lead && isOpen_(q) && !!q.s3Done; }
function canAnalyze_(me, q) { return me.lead && isOpen_(q) && (q.decision === 'ANALÝZA' || q.decision === 'ESKALACE'); }
function canVerify_(me, q) { return me.lead && q.status === 'OVĚŘENÍ'; }
function canAssess_(me, q) { return me.lead && q.status !== 'ZRUŠENO'; }

/** A problem as the page gets it, including what the current user may do with it. */
function pubQ_(q, me) {
  const o = {};
  COLS[TAB.qraps].forEach(c => { o[c[0]] = q[c[0]]; });
  o.can = {
    popis: canPopis_(me, q), opatreni: canOpatreni_(me, q), decide: canDecide_(me, q),
    analyze: canAnalyze_(me, q), verify: canVerify_(me, q), assess: canAssess_(me, q), admin: me.manager
  };
  return o;
}

function pubA_(a, me, q) {
  const o = {};
  COLS[TAB.actions].forEach(c => { o[c[0]] = a[c[0]]; });
  o.canEdit = me.lead && isOpen_(q);
  o.canDone = isOpen_(q) && !a.done && (me.lead || (!!me.email && a.ownerEmail === me.email));
  return o;
}

function pack_(id) {
  const me = me_();
  const q = find_(id);
  const acts = actionsOf_(id);
  q.status = statusOf_(q, acts);
  return { qrap: pubQ_(q, me), actions: acts.map(a => pubA_(a, me, q)) };
}

/** Open problems + problems closed in the last N days (or everything when all = true). */
function listData_(all) {
  const me = me_();
  const since = Date.now() - (Number(setting_('ZOBRAZIT_UZAVRENE_DNI')) || 60) * 864e5;
  const byQrap = {};
  table_(TAB.actions).rows.forEach(a => { (byQrap[a.qrapId] = byQrap[a.qrapId] || []).push(a); });
  const qraps = [];
  const actions = [];
  table_(TAB.qraps).rows.forEach(q => {
    const acts = byQrap[q.id] || [];
    q.status = statusOf_(q, acts);
    if (!all && !isOpen_(q) && new Date(q.closedAt || q.updated || q.created).getTime() < since) return;
    qraps.push(pubQ_(q, me));
    acts.forEach(a => actions.push(pubA_(a, me, q)));
  });
  return { qraps: qraps, actions: actions, all: !!all };
}

// =====================================================================================
// 6. SHEET HELPERS
// =====================================================================================

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('V tabulce chybí list „' + name + '“. Spusťte v tabulce menu eQRAP → Nastavit tabulku.');
  return sh;
}

/** Reads a whole data tab once per request: { sh, idx, rows:[{key: value, _row, _raw}] }. */
function table_(name) {
  if (MEMO_[name]) return MEMO_[name];
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const head = values[0].map(v => String(v).trim());
  const idx = {};
  COLS[name].forEach(c => {
    idx[c[0]] = head.indexOf(c[1]);
    if (idx[c[0]] < 0) throw new Error('V listu „' + name + '“ chybí sloupec „' + c[1] + '“. Spusťte menu eQRAP → Nastavit tabulku.');
  });
  const first = COLS[name][0][0];
  const rows = [];
  values.slice(1).forEach((r, i) => {
    if (r[idx[first]] === '') return;
    const o = { _row: i + 2, _raw: r };
    COLS[name].forEach(c => { o[c[0]] = fromCell_(c[0], r[idx[c[0]]]); });
    rows.push(o);
  });
  const cols = COLS[name].map(c => idx[c[0]]);
  MEMO_[name] = { sh: sh, idx: idx, rows: rows, first: Math.min.apply(null, cols), last: Math.max.apply(null, cols) };
  return MEMO_[name];
}

function fromCell_(key, v) {
  if (v instanceof Date) return DATE_KEYS.indexOf(key) >= 0 ? Utilities.formatDate(v, tz_(), 'yyyy-MM-dd') : v.toISOString();
  if (NUMBER_KEYS.indexOf(key) >= 0) return v === '' ? '' : Number(v);
  return String(v);
}

function toCell_(key, v) {
  if (v === '' || v === null || v === undefined) return '';
  if (TIME_KEYS.indexOf(key) >= 0) return new Date(v);
  if (DATE_KEYS.indexOf(key) >= 0) { const p = String(v).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  if (NUMBER_KEYS.indexOf(key) >= 0) return Number(v);
  return "'" + String(v); // stored as plain text: keeps "00123" and never runs as a formula
}

function insert_(name, o) {
  const t = table_(name);
  const row = [];
  for (let i = 0; i <= t.last; i++) row.push('');
  COLS[name].forEach(c => { row[t.idx[c[0]]] = toCell_(c[0], o[c[0]]); });
  t.sh.appendRow(row);
  o._row = t.sh.getLastRow();
  o._raw = row;
  t.rows.push(o);
}

/** Writes only the app's own columns of one row (your own extra columns to the right stay untouched). */
function update_(name, o) {
  const t = table_(name);
  const row = o._raw.slice(t.first, t.last + 1);
  while (row.length < t.last - t.first + 1) row.push('');
  COLS[name].forEach(c => { row[t.idx[c[0]] - t.first] = toCell_(c[0], o[c[0]]); });
  t.sh.getRange(o._row, t.first + 1, 1, row.length).setValues([row]);
}

function find_(id) {
  const q = table_(TAB.qraps).rows.filter(r => r.id === id)[0];
  need_(q, 'Problém ' + id + ' nebyl nalezen.');
  return q;
}

function actionsOf_(id) {
  return table_(TAB.actions).rows.filter(a => a.qrapId === id).sort((a, b) => a.no - b.no);
}

function log_(id, text) {
  sheet_(TAB.log).appendRow([new Date(), me_().email || '(neznámý účet)', "'" + id, "'" + text]);
}

function nextId_(rows) {
  const prefix = 'Q-' + Utilities.formatDate(new Date(), tz_(), 'yyyy') + '-';
  const max = rows.reduce((m, r) => (r.id.indexOf(prefix) === 0 ? Math.max(m, parseInt(r.id.slice(prefix.length), 10) || 0) : m), 0);
  return prefix + ('00' + (max + 1)).slice(-Math.max(3, String(max + 1).length));
}

/** Runs fn while nobody else is saving (prevents two problems getting the same number). */
function lock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Aplikace je právě zaneprázdněná. Zkuste to prosím za chvíli znovu.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Settings, lists and people – read from the Sheet, remembered for 5 minutes. */
function cfg_() {
  if (CFG_) return CFG_;
  const cache = CacheService.getScriptCache();
  const hit = cache.get('cfg');
  if (hit) { CFG_ = JSON.parse(hit); return CFG_; }
  CFG_ = { settings: readSettings_(), lists: readLists_(), people: readPeople_() };
  try { cache.put('cfg', JSON.stringify(CFG_), 300); } catch (e) { /* too big for the cache – fine */ }
  return CFG_;
}

function setting_(key) { return cfg_().settings[key]; }

function readSettings_() {
  const s = {};
  SETTINGS.forEach(x => { s[x[0]] = x[1]; });
  sheet_(TAB.settings).getDataRange().getValues().slice(1).forEach(r => {
    const k = String(r[0]).trim();
    if (k) s[k] = typeof r[1] === 'string' ? r[1].trim() : r[1];
  });
  return s;
}

function readLists_() {
  const values = sheet_(TAB.lists).getDataRange().getValues();
  const head = values[0].map(v => String(v).trim());
  const out = {};
  LISTS.forEach(l => {
    const i = head.indexOf(l[1]);
    out[l[0]] = i < 0 ? l[2] : values.slice(1).map(r => String(r[i]).trim()).filter(String);
  });
  return out;
}

function readPeople_() {
  return sheet_(TAB.people).getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim() || String(r[1]).trim())
    .map(r => ({
      name: String(r[0]).trim(),
      email: String(r[1]).trim().toLowerCase(),
      role: roleOf_(r[2]),
      area: String(r[3]).trim(),
      active: plain_(r[4]) !== 'NE'
    }));
}

/** "Vedoucí", "VEDOUCI", "leader" … → 'VEDOUCÍ'; "Manažer", "manager", "admin" → 'MANAŽER'; else ''. */
function roleOf_(v) {
  const r = plain_(v);
  if (['VEDOUCI', 'LEADER', 'LEAD', 'TL', 'SUPERVIZOR', 'SUPERVISOR', 'MISTR'].indexOf(r) >= 0) return 'VEDOUCÍ';
  if (['MANAZER', 'MANAGER', 'ADMIN'].indexOf(r) >= 0) return 'MANAŽER';
  return '';
}

// ---- small value helpers
function plain_(v) { return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
function need_(ok, msg) { if (!ok) throw new Error(msg); }
function txt_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 2000); }
function short_(s) { s = String(s || ''); return s.length > 70 ? s.slice(0, 67) + '…' : s; }
function list_(s) { return String(s || '').split(',').map(x => x.trim()).filter(String); }
function multi_(v) { return (Array.isArray(v) ? v : list_(v)).map(x => txt_(x, 100)).filter(String).join(', '); }
function nowIso_() { return new Date().toISOString(); }
function tz_() { return Session.getScriptTimeZone() || 'Europe/Prague'; }
function fmt_(iso) { return iso ? Utilities.formatDate(new Date(iso), tz_(), 'd.M.yyyy HH:mm') : ''; }

function oneOf_(v, allowed, msg) {
  v = txt_(v, 50);
  need_(allowed.indexOf(v) >= 0, msg);
  return v;
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  need_(isFinite(n) && n >= 0, 'Počet kusů musí být kladné číslo.');
  return Math.round(n);
}

function iso_(v) {
  if (!v) return '';
  const d = new Date(v);
  need_(!isNaN(d.getTime()), 'Neplatné datum nebo čas.');
  return d.toISOString();
}

function day_(v) {
  v = txt_(v, 10);
  need_(/^\d{4}-\d{2}-\d{2}$/.test(v), 'Vyplňte platný termín.');
  return v;
}

/** ① ② fields from the form, checked. */
function popisFrom_(f) {
  const q = {
    reporter: txt_(f.reporter, 100), area: txt_(f.area, 100), type: txt_(f.type, 100), what: txt_(f.what),
    where: txt_(f.where, 200), when: iso_(f.when), how: txt_(f.how, 100), customer: txt_(f.customer, 100),
    partNo: txt_(f.partNo, 100), delivery: txt_(f.delivery, 100), qty: num_(f.qty),
    safety: f.safety === true || f.safety === 'ANO' ? 'ANO' : '', notified: multi_(f.notified)
  };
  const missing = [['reporter', 'Kdo hlásí'], ['area', 'Oblast'], ['type', 'Typ problému'], ['what', 'Co se stalo'],
    ['when', 'Kdy zjištěno'], ['notified', '② Kdo byl upozorněn']].filter(x => !q[x[0]]).map(x => x[1]);
  need_(!missing.length, 'Vyplňte prosím: ' + missing.join(', ') + '.');
  need_(new Date(q.when).getTime() <= Date.now() + 15 * 60000, 'Čas zjištění nemůže být v budoucnosti.');
  return q;
}

/** ③ fields from the form, checked. Saving ③ means "the immediate actions are done". */
function opatreniFrom_(f, doneBefore) {
  const s = {
    s3Action: txt_(f.s3Action), s3Places: multi_(f.s3Places), s3Checked: num_(f.s3Checked), s3Nok: num_(f.s3Nok),
    s3Customer: txt_(f.s3Customer, 30), s3By: txt_(f.s3By, 100), s3Done: doneBefore || nowIso_()
  };
  const missing = [['s3Action', 'Co bylo uděláno'], ['s3Customer', 'Zákazník informován'], ['s3By', 'Kdo opatření provedl']]
    .filter(x => !s[x[0]]).map(x => x[1]);
  need_(!missing.length, 'Vyplňte prosím: ' + missing.join(', ') + '.');
  need_(s.s3Nok === '' || s.s3Checked === '' || s.s3Nok <= s.s3Checked, 'NOK kusů nemůže být víc než zkontrolovaných.');
  return s;
}

/** ⑥ action fields, checked. The e-mail is looked up by name in the tab Lidé. */
function actionFields_(a) {
  const f = { text: txt_(a.text), owner: txt_(a.owner, 100), due: a.due ? day_(a.due) : '', note: txt_(a.note, 500) };
  need_(f.text && f.owner && f.due, 'Vyplňte akci, odpovědnou osobu a termín.');
  const key = f.owner.toLowerCase();
  const p = cfg_().people.filter(x => x.active && (x.name.toLowerCase() === key || x.email === key))[0];
  f.ownerEmail = p ? p.email : (/^[^@\s]+@[^@\s]+$/.test(key) ? key : '');
  if (p) f.owner = p.name;
  return f;
}

/** Stores a photo in the Drive folder from the settings and returns its file ID. */
function savePhoto_(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp|gif));base64,(.+)$/.exec(String(dataUrl || ''));
  need_(m, 'Fotka musí být obrázek (JPG nebo PNG).');
  const bytes = Utilities.base64Decode(m[3]);
  need_(bytes.length <= 5 * 1024 * 1024, 'Fotka je příliš velká (max 5 MB).');
  need_(setting_('FOTKY_SLOZKA_ID'), 'Složka pro fotky není nastavená – spusťte menu eQRAP → Nastavit tabulku.');
  const folder = DriveApp.getFolderById(setting_('FOTKY_SLOZKA_ID'));
  return folder.createFile(Utilities.newBlob(bytes, m[1], 'eqrap_' + Date.now() + '.' + m[2])).getId();
}

// =====================================================================================
// 7. E-MAILS AND DAILY REMINDER
//    Only 3 e-mails: new problem → leaders of the area, escalation → managers, new action → its owner.
// =====================================================================================

function leaders_(area) {
  const l = cfg_().people.filter(p => p.active && p.role === 'VEDOUCÍ' && (!p.area || p.area === area)).map(p => p.email);
  return l.length ? l : managers_();
}

function managers_() {
  return cfg_().people.filter(p => p.active && p.role === 'MANAŽER').map(p => p.email);
}

function mailNew_(q) {
  const to = leaders_(q.area).concat(q.safety ? managers_() : []);
  send_(to, (q.safety ? 'BOZP! ' : '') + q.id + ' – nový problém (' + q.area + ')', [
    'Byl nahlášen nový problém.', '',
    'Co: ' + q.what, 'Typ: ' + q.type, 'Kde: ' + [q.area, q.where].filter(String).join(', '),
    'Kdy: ' + fmt_(q.when), 'Hlásí: ' + q.reporter, '',
    q.s3Done ? 'Okamžitá opatření jsou vyplněná. Další krok: ④ rozhodnutí vedoucího.'
      : 'Další krok: ③ okamžitá opatření do ' + setting_('LHUTA_OPATRENI_HODIN') + ' h, potom ④ rozhodnutí vedoucího.'
  ], q.id);
}

function mailEscalated_(q) {
  send_(managers_(), q.id + ' – eskalace (' + q.area + ')', [
    me_().name + ' eskaloval(a) problém na manažera.', '',
    'Co: ' + q.what, 'Kde: ' + [q.area, q.where].filter(String).join(', '),
    'Poznámka: ' + (q.decisionNote || '–')
  ], q.id);
}

function mailAction_(q, a) {
  if (!a.ownerEmail) return;
  send_([a.ownerEmail], q.id + ' – máte novou akci (termín ' + a.due + ')', [
    'Byla vám přidělena akce k problému ' + q.id + '.', '',
    'Akce: ' + a.text, 'Termín: ' + a.due, 'Problém: ' + q.what, '',
    'Až bude hotovo, otevřete odkaz a klikněte na „✓ Hotovo“.'
  ], q.id);
}

function send_(to, subject, lines, id) {
  if (NO_MAIL_ || plain_(setting_('EMAILY')) !== 'ANO') return;
  const list = to.filter((x, i) => /^[^@\s]+@[^@\s]+$/.test(x) && to.indexOf(x) === i);
  if (!list.length) return;
  try {
    MailApp.sendEmail({
      to: list.join(','),
      subject: '[' + setting_('NAZEV') + '] ' + subject,
      body: lines.concat(['', 'Otevřít: ' + link_(id)]).join('\n'),
      name: String(setting_('NAZEV'))
    });
  } catch (e) {
    console.warn('E-mail se nepodařilo odeslat: ' + e.message); // saving must not fail because of an e-mail
  }
}

function link_(id) {
  let url = String(setting_('ODKAZ_APLIKACE') || '');
  if (!url) { try { url = ScriptApp.getService().getUrl(); } catch (e) { url = ''; } }
  return url + (id ? '?id=' + encodeURIComponent(id) : '');
}

/** Every morning (if switched on in the menu): leaders get their open problems, owners their late actions. */
function dailyReminder() {
  const allActs = table_(TAB.actions).rows;
  const open = table_(TAB.qraps).rows.filter(q => {
    q.status = statusOf_(q, allActs.filter(a => a.qrapId === q.id));
    return isOpen_(q);
  });
  const today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  cfg_().people.filter(p => p.active && p.role).forEach(p => {
    const mine = open.filter(q => !p.area || p.area === q.area);
    if (!mine.length) return;
    send_([p.email], 'otevřené problémy: ' + mine.length, ['Dobré ráno, tyto problémy jsou otevřené:', '']
      .concat(mine.map(q => q.id + '  čeká: ' + NEXT_STEP[q.status] + '  –  ' + short_(q.what))), '');
  });
  const late = allActs.filter(a => !a.done && a.ownerEmail && a.due && a.due <= today &&
    open.some(q => q.id === a.qrapId));
  const owners = late.map(a => a.ownerEmail).filter((x, i, arr) => arr.indexOf(x) === i);
  owners.forEach(email => {
    const mine = late.filter(a => a.ownerEmail === email);
    send_([email], 'akce po termínu: ' + mine.length, ['Tyto vaše akce mají termín dnes nebo už prošel:', '']
      .concat(mine.map(a => a.qrapId + '  ' + a.due + '  –  ' + short_(a.text))), '');
  });
}

// =====================================================================================
// 8. SETUP, ADMIN MENU, EXAMPLE DATA
// =====================================================================================

/** Adds the "eQRAP" menu to the Sheet, so the admin never needs to open the code. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('eQRAP')
    .addItem('Nastavit tabulku (setup)', 'setup')
    .addItem('Použít změny v nastavení hned', 'clearCache')
    .addSeparator()
    .addItem('Zapnout denní připomínky e-mailem', 'installReminder')
    .addItem('Vypnout denní připomínky', 'removeReminder')
    .addSeparator()
    .addItem('Vložit ukázková data', 'exampleData')
    .addToUi();
}

/** Changes in the tabs Lidé, Seznamy and Nastavení apply immediately. */
function onEdit(e) {
  const name = e && e.range ? e.range.getSheet().getName() : '';
  if ([TAB.people, TAB.lists, TAB.settings].indexOf(name) >= 0) clearCache();
}

function clearCache() {
  CacheService.getScriptCache().remove('cfg');
  CFG_ = null;
  ME_ = null;
}

/** Creates (or repairs) all tabs. Safe to run again – it never deletes data. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(tz_());

  [TAB.qraps, TAB.actions, TAB.log].forEach(name => {
    const sh = makeTab_(ss, name, COLS[name].map(c => c[1]));
    if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
      sh.protect().setDescription('Data aplikace eQRAP – měňte přes aplikaci').setWarningOnly(true);
    }
  });

  if (!ss.getSheetByName(TAB.people)) {
    const sh = makeTab_(ss, TAB.people, ['Jméno', 'E-mail', 'Role', 'Oblast', 'Aktivní']);
    const rows = [['Správce aplikace', Session.getEffectiveUser().getEmail(), 'MANAŽER', '', 'ANO']].concat(EXAMPLE_PEOPLE);
    sh.getRange(2, 1, rows.length, 5).setValues(rows);
    sh.getRange(2, 3, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['VEDOUCÍ', 'MANAŽER'], true).setAllowInvalid(false)
      .setHelpText('Prázdné = běžný uživatel. VEDOUCÍ = rozhoduje a vede analýzu. MANAŽER = navíc eskalace a správa.').build());
    sh.getRange(2, 5, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['ANO', 'NE'], true).build());
  }

  if (!ss.getSheetByName(TAB.lists)) {
    const sh = makeTab_(ss, TAB.lists, LISTS.map(l => l[1]));
    const n = Math.max.apply(null, LISTS.map(l => l[2].length));
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(LISTS.map(l => l[2][i] || ''));
    sh.getRange(2, 1, n, LISTS.length).setValues(rows);
  }

  const st = makeTab_(ss, TAB.settings, ['Klíč', 'Hodnota', 'Popis']);
  const have = st.getDataRange().getValues().map(r => String(r[0]).trim());
  const add = SETTINGS.filter(s => have.indexOf(s[0]) < 0);
  if (add.length) st.getRange(st.getLastRow() + 1, 1, add.length, 3).setValues(add);

  clearCache();
  if (!setting_('FOTKY_SLOZKA_ID')) {
    const folder = DriveApp.createFolder('eQRAP fotky');
    const rows = st.getDataRange().getValues();
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === 'FOTKY_SLOZKA_ID') st.getRange(i + 1, 2).setValue(folder.getId());
    }
    clearCache();
  }
  toast_('Tabulka je připravená. Pokračujte nasazením: Nasadit → Nová implementace → Webová aplikace.');
  return 'Hotovo';
}

function makeTab_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const have = sh.getLastRow() ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(v => String(v).trim()) : [];
  const missing = headers.filter(x => have.indexOf(x) < 0);
  if (missing.length) {
    const start = have.filter(String).length ? sh.getLastColumn() + 1 : 1;
    const need = start + missing.length - 1;
    if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
  }
  sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).setFontWeight('bold').setBackground('#eef1f5');
  sh.setFrozenRows(1);
  return sh;
}

function installReminder() {
  removeReminder();
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(6).create();
  toast_('Denní připomínky jsou zapnuté (každé ráno kolem 6:00).');
}

function removeReminder() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyReminder').forEach(t => ScriptApp.deleteTrigger(t));
}

/** Three example problems in different stages, to see how the app works. No e-mails are sent. */
function exampleData() {
  NO_MAIL_ = true;
  const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
  const base = { reporter: 'Ukázka', notified: 'Vedoucí směny' };
  apiCreate(Object.assign({}, base, {
    area: 'Sklad', type: 'Poškozený díl nebo obal', when: hoursAgo(2), where: 'Regál B-12',
    what: 'Promáčknutý obal na paletě, 2 krabice poškozené', partNo: '00-4711', qty: 2
  }));
  const b = apiCreate(Object.assign({}, base, {
    area: 'Expedice', type: 'Chybná nebo chybějící etiketa', when: hoursAgo(5), where: 'Rampa 3', customer: 'Zákazník A',
    delivery: 'DL-2026-0815', what: 'Na 4 boxech chybí etiketa zákazníka',
    s3: { s3Action: 'Zásilka zastavena, etikety doplněny', s3Places: 'Připraveno k expedici', s3Checked: 40, s3Nok: 4,
      s3Customer: 'NENÍ POTŘEBA', s3By: 'Ukázka' }
  })).qrap.id;
  const c = apiCreate(Object.assign({}, base, {
    area: 'Nakládka / doprava', type: 'Chybné množství', when: hoursAgo(50), customer: 'Zákazník B',
    delivery: 'DL-2026-0790', what: 'Zákazník obdržel o 1 paletu méně, než je na dodacím listu', qty: 1,
    s3: { s3Action: 'Chybějící paleta dohledána a odeslána expresem', s3Places: 'Sklad, Rampa / kamion', s3Checked: 12, s3Nok: 1,
      s3Customer: 'ANO', s3By: 'Ukázka' }
  })).qrap.id;
  apiSave(c, 'rozhodnuti', { decision: 'ANALÝZA', decisionNote: 'Opakuje se podruhé tento měsíc' });
  apiSave(c, 'pricina', { why1: 'Paleta nebyla naložena', why2: 'Nebyla na seznamu k nakládce',
    why3: 'Seznam se tiskl před posledním vychystáním', rootCause: 'Nakládací seznam se netiskne po dokončení vychystání',
    causeType: 'Postup / metoda' });
  const due = Utilities.formatDate(new Date(Date.now() + 7 * 864e5), tz_(), 'yyyy-MM-dd');
  apiSaveAction(c, { text: 'Tisknout nakládací seznam až po potvrzení vychystání ve WMS', owner: 'Jana Nováková', due: due });
  apiSaveAction(c, { text: 'Zaškolit směnu na kontrolu počtu palet při nakládce', owner: 'Petr Svoboda', due: due });
  apiSaveAction(c, { no: 2, done: true });
  NO_MAIL_ = false;
  toast_('Ukázková data vložena (' + b + ', ' + c + ' a jeden nový).');
}

function toast_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'eQRAP', 10); } catch (e) { /* not in the Sheet */ }
  Logger.log(msg);
}
