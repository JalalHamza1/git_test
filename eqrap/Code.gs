/**
 * eQRAP Expedice (Lite) – server part. Everything the server does is in this one file.
 *
 * The questions and rules follow the firm's QRAP V3.0 form (logistics version), sections ① to ⑦.
 * Left out on purpose because they only apply to production / APU: APU and plant-level copies of a QRAP.
 *
 * HOW IT FITS TOGETHER
 *   Google Sheet = database + all settings. Keep it (and the folder "eQRAP fotky") in a shared drive and do NOT
 *                  share it with the users – the web app runs as its deployer and needs no Sheet access for them.
 *                  data tabs:     Problémy, Akce, Ověření, Hodnocení, Historie
 *                  settings tabs: Lidé, Seznamy, Nastavení   (admins edit them on the page "Správa" or in the Sheet)
 *   Code.gs      = reads/writes the Sheet, checks what is possible, sends e-mails
 *   PhotoHandoff.gs = the phone photo hand-off (QR code on the kiosk → photos taken on a company phone)
 *   Index.html   = the whole screen; it receives all data when the page opens, so clicking around is instant
 *   Upload.html  = the small page a phone opens after scanning the QR code
 *
 * SPEED
 *   - The list every page needs is built once per DATA VERSION and kept gzipped in CacheService (listCached_).
 *     Page loads and refreshes after that read no sheet at all. Every save makes a new version.
 *   - A save reads only the rows of its own QRAP: a small tab in one call, a big tab by its ID column plus the
 *     matching rows (rowsBy_). History lines are written in one call at the end, SpreadsheetApp.flush() runs once
 *     before the lock is released, slow photo uploads happen outside the lock.
 *   - E-mails do not hold up the person who saves: they are parked in Script Properties and the page asks for them
 *     with a second, background call (apiMail). If the page is closed first, the next refresh sends them (sweepMail_).
 *   - Photos taken on the kiosk are uploaded in the background while the form is still being filled in
 *     (PhotoHandoff.gs, apiStagePhoto), so "Odeslat" sends only text. Small previews are cached (dataUrl_).
 *
 * SAFETY
 *   - Everything a browser can call (google.script.run) is listed in section 3a and goes through run_():
 *     known problems (UserError) come back as a clear message, anything else is logged with a short code.
 *   - Inputs are checked on the server (lists from the Sheet, lengths, counts, dates); text is stored as text
 *     ("'" prefix) so nothing typed runs as a formula; photos are checked by their first bytes.
 *   - Two people editing the same part of a QRAP cannot overwrite each other: the page sends a fingerprint of what
 *     it showed (_fp, see FP_FIELDS); if somebody saved that part meanwhile, nothing is written and the page asks.
 *   - An admin cannot take the ADMIN role away from themselves (no lock-out); settings have sane limits.
 *   - E-mails go only to people in Lidé, the Kvalita / BOZP addresses or the company's own domain.
 *   - Only the columns the page needs are sent to it (Q_PUB …); the photo folder ID lives in Script Properties.
 *
 * ROLES (tab Lidé, column Role). Everybody works with their own Google account – every step is signed with it.
 *   (empty)   user: can do every step of a QRAP – report, ③, ④ decision, ⑤ ⑥, 5-shift check, ⑦, close
 *   MANAŽER   like a user + cancel / reopen / unlock a QRAP (always with a reason in the history),
 *             the dashboard "Přehled manažera", and the e-mails about new problems in their zone
 *   ADMIN     like MANAŽER + the page "Správa" (people, lists, settings) and "Zobrazit jako". There can be several
 *             admins. While Lidé has no active admin, the account the app runs as is admin (nobody gets locked out).
 *
 * DEPLOYMENT – Execute as: Me · Who has access: anyone in the organisation (never "Anyone").
 * HANDOVER – if the deployer leaves, another admin follows the tab "Předání aplikace" (setup writes it).
 *
 * SECTIONS
 *   1. Tabs, columns, defaults     5. Permissions and what the page gets
 *   2. Web app entry (doGet)       6. Sheet access, cache, form checks
 *   3. API used by the page        7. E-mails and daily reminder
 *   4. Status rules                8. Setup, admin menu, example data
 */

// =====================================================================================
// 1. TABS, COLUMNS, DEFAULTS
// =====================================================================================

const TAB = {
  qraps: 'Problémy', actions: 'Akce', effects: 'Ověření', assess: 'Hodnocení', log: 'Historie',
  people: 'Lidé', lists: 'Seznamy', settings: 'Nastavení'
};
const HANDOVER_TAB = 'Předání aplikace';
// Tab Lidé, column "E-maily": ANO or empty = the person gets the app's e-mails, NE = none at all. Found by its header,
// so it may sit in any column (setup and Správa add it as column F when it is missing).
const PEOPLE_MAIL = 'E-maily';
const CFG_KEY = 'cfg:v2'; // cache key of cfg_ – a new name, so a cache from the previous version (without "E-maily") is never used

// [name used in the code, column header in the Sheet]. Do not rename these headers in the Sheet.
const COLS = {
  'Problémy': [
    ['id', 'ID'], ['status', 'Stav'], ['created', 'Nahlášeno'], ['createdBy', 'Účet'],
    // ① POPIS PROBLÉMU
    ['safety', '① SAFETY'], ['what', '① CO je za problém?'], ['whatOther', '① CO – jiné'],
    ['how', '① JAK byl objeven?'], ['howOther', '① JAK – jiné'],
    ['when', '① KDY?'], ['zone', '① KDE? – zóna'], ['location', '① KDE? – lokace'], ['originZone', '① Kde vzniklo?'],
    ['qty', '① KOLIK?'], ['unit', '① Jednotka'], ['nokSituation', '① NOK situace bez kusů'],
    ['repeat7', '① Stejný problém v posledních 7 dnech?'], ['repeatRef', '① Opakovaný QRAP'],
    ['finder', '① JMÉNO'],
    ['descWrong', '① Popis – ŠPATNÝ díl'], ['descRight', '① Popis – DOBRÝ díl'],
    ['materialNo', '① Číslo materiálu'], ['huNo', '① Číslo HU / dodacího listu'], ['supplier', '① Dodavatel'],
    ['reference', '① Reference'],
    ['photoWrong', '① Foto ŠPATNĚ'], ['photoRight', '① Foto SPRÁVNĚ'], ['photoException', '① Výjimka – proč nejsou fotky'],
    // ② KDO BYL UPOZORNĚN?
    ['notified', '② Upozorněni'], ['notifiedOther', '② Jiné – kdo'], ['notifyPeople', '② Informovat e-mailem'],
    // ③ OKAMŽITÁ OPATŘENÍ <24h (the actions themselves are rows in the tab Akce, part ③).
    //   Proces obnoven = "Čas re-startu" on the paper form. Kontrola probíhá / Proces zastaven are kept for old QRAPs.
    ['risk', '③ Riziko u zboží na skladě / expedovaného?'], ['checked', '③ Zkontrolováno ks'],
    ['wrong', '③ Nalezeno špatně ks'], ['checkRunning', '③ Kontrola probíhá'],
    ['processStopped', '③ Proces zastaven?'], ['restoredAt', '③ Proces obnoven'], ['s3Done', '③ Kompletní'],
    // ④ ROZHODNUTÍ OJT
    ['shifts', '④ Informované směny (5\' meeting)'], ['decision', '④ Rozhodnutí'], ['decisionNote', '④ Komentář'],
    ['pilots', '④ Piloti'], ['decisionBy', '④ Podepsal'], ['decisionAt', '④ Podepsáno'],
    // ⑤ PŘÍČINA 5 Proč?
    ['o1', '⑤ Proč vzniklo 1'], ['o2', '⑤ Proč vzniklo 2'], ['o3', '⑤ Proč vzniklo 3'], ['o4', '⑤ Proč vzniklo 4'],
    ['o5', '⑤ Proč vzniklo 5'], ['rootO', '⑤ Kořenová příčina – vzniklo (krok)'],
    ['n1', '⑤ Proč nezachyceno 1'], ['n2', '⑤ Proč nezachyceno 2'], ['n3', '⑤ Proč nezachyceno 3'],
    ['n4', '⑤ Proč nezachyceno 4'], ['n5', '⑤ Proč nezachyceno 5'], ['rootN', '⑤ Kořenová příčina – nezachyceno (krok)'],
    ['learned', '⑤ Co jsme se naučili z QR?'], ['std', '⑤ Příležitost k aktualizaci STANDARDU?'], ['stdRef', '⑤ Který standard'],
    // ⑥ closure (actions: tab Akce part ⑥, 5-shift check: tab Ověření)
    ['closedBy', '⑥ Uzavření podepsal'], ['closedAt', 'Uzavřeno'],
    ['cancelReason', 'Zrušeno – důvod'], ['updated', 'Změněno'], ['updatedBy', 'Změnil']
  ],
  'Akce': [
    ['qrapId', 'QRAP'], ['no', 'Č.'], ['part', 'Část'], ['kind', 'Typ / krok 5 Proč'], ['text', 'Akce'],
    ['owner', 'Kdo / pilot'], ['ownerEmail', 'E-mail'], ['due', 'Plán'], ['dueFirst', 'Původní plán'], ['done', 'Hotovo'],
    ['evidence', 'Odkaz na důkaz'], ['note', 'Poznámka'], ['removed', 'Odebráno'], ['created', 'Vytvořeno']
  ],
  'Ověření': [
    ['qrapId', 'QRAP'], ['round', 'Kolo'], ['slot', 'Slot'], ['date', 'Datum směny'], ['shift', 'Směna'],
    ['result', 'Výsledek'], ['by', 'Zkontroloval'], ['at', 'Kdy']
  ],
  'Hodnocení': [
    ['qrapId', 'QRAP'], ['at', 'Kdy'], ['by', 'Hodnotil'], ['c1', '1 RED BOX'], ['c2', '2 ROZDĚLENÍ'], ['c3', '3 POROVNÁNÍ'],
    ['c4', '4 POUČENÍ A SDÍLENÍ'], ['c5', '5 ON JOB TRAINING'], ['ojtWith', 'OJT s kým'], ['feedback', 'Zpětná vazba'],
    ['feedbackType', 'Typ zpětné vazby']
  ],
  'Historie': [['at', 'Kdy'], ['by', 'Kdo'], ['qrapId', 'QRAP'], ['text', 'Co se stalo']]
};
const TIME_KEYS = ['created', 'when', 'restoredAt', 's3Done', 'decisionAt', 'closedAt', 'updated', 'done', 'at'];
const NUMBER_KEYS = ['qty', 'checked', 'wrong', 'no', 'round', 'slot'];
const DATE_KEYS = ['due', 'dueFirst', 'date'];

// The column each data tab is looked up by: one QRAP = its row in Problémy + its rows in the other tabs.
const KEY_FIELD = { 'Problémy': 'id', 'Akce': 'qrapId', 'Ověření': 'qrapId', 'Hodnocení': 'qrapId', 'Historie': 'qrapId' };

// Tab "Nastavení": [key, default value, explanation shown next to it]. The photo folder ID is in Script Properties.
const SETTINGS = [
  ['NAZEV', 'eQRAP Expedice', 'Název aplikace – nahoře na stránce a v e-mailech.'],
  ['EMAILY', 'ANO', 'ANO = posílat e-maily, NE = neposílat (např. při zkoušení).'],
  ['EMAIL_KVALITA', '', 'E-mail Kvality – dostane zprávu, když je riziko u zboží na skladě / expedovaného (③ = ANO).'],
  ['EMAIL_BOZP', '', 'E-mail BOZP / EHS – dostane zprávu o každém problému se SAFETY = ANO.'],
  ['LHUTA_OPATRENI_HODIN', 24, 'Do kolika hodin od KDY mají být hotová ③ okamžitá opatření.'],
  ['ZOBRAZIT_UZAVRENE_DNI', 60, 'Kolik dní zpět se na přehledu ukazují uzavřené problémy.'],
  ['ODKAZ_APLIKACE', '', 'Adresa aplikace do e-mailů. Prázdné = zjistí se automaticky. Po novém nasazení sem dejte nový odkaz.']
];
const PUBLIC_SETTINGS = ['NAZEV', 'LHUTA_OPATRENI_HODIN', 'ZOBRAZIT_UZAVRENE_DNI']; // all the page needs
const FOLDER_PROP = 'FOTKY_SLOZKA_ID';

// Tab "Seznamy": [name in code, column header, default values]. The admin edits the values in the Sheet.
const LISTS = [
  ['zones', 'Zóny', ['Příjem', 'Sklad', 'Vychystávání', 'Balení', 'Expedice', 'Nakládka']],
  ['problems', 'CO je za problém', ['chybí / špatná etiketa', 'špatný materiál', 'špatné množství', 'poškozené zboží / obal',
    'chybějící dokumentace', 'jiné']],
  ['how', 'JAK byl objeven', ['příjem zboží', 'skladování', 'vychystávání', 'balení', 'kontrola expedice', 'inventura',
    'reklamace zákazníka', 'dodávka dodavatele', 'jiné']],
  ['units', 'Jednotky', ['ks', 'krabice', 'palety', 'manipulační jednotky']],
  ['alert', 'Kdo byl upozorněn', ['Team Leader', 'Supervizor', 'Údržba', 'Kvalita', 'Vedoucí skladu', 'Logistika / nákup', 'jiné']],
  ['shifts', 'Směny', ['Ranní', 'Odpolední', 'Noční', 'Víkend']]
];

// Example people written by setup. The admin replaces them with real colleagues.
const EXAMPLE_PEOPLE = [
  ['Jana Nováková', 'jana.novakova@example.com', 'MANAŽER', 'Expedice', 'ANO'],
  ['Petr Svoboda', 'petr.svoboda@example.com', '', 'Sklad', 'ANO'],
  ['Eva Dvořáková', 'eva.dvorakova@example.com', 'MANAŽER', '', 'ANO'],
  ['Tomáš Černý', 'tomas.cerny@example.com', '', 'Expedice', 'ANO']
];

// What setup writes into the tab "Předání aplikace" – the steps when the person who deployed the app leaves.
const HANDOVER = [
  ['Co dělat, když odejde ten, kdo aplikaci nasadil (webová aplikace běží pod jeho účtem)'],
  ['1. Jiný admin otevře tuto tabulku → Rozšíření → Apps Script → Nasadit → Nová implementace → Webová aplikace.'],
  ['2. Spustit jako: Já. Kdo má přístup: kdokoli v organizaci. → Nasadit.'],
  ['3. Nový odkaz zapíše do listu Nastavení → ODKAZ_APLIKACE a pošle ho kolegům.'],
  ['4. Menu eQRAP → Zapnout denní připomínky e-mailem (připomínky běží pod účtem toho, kdo je zapnul).'],
  ['5. V listu Lidé musí být aspoň jeden aktivní ADMIN, který ve firmě zůstává.'],
  ['6. Menu eQRAP → Nastavit tabulku (zkontroluje složku na fotky ve vlastnostech skriptu).'],
  ['Upravovat tuto tabulku smí jen admini: kdo ji může upravit, může upravit i skript a spustit ho pod účtem toho, kdo aplikaci nasadil.'],
  ['Tabulka i složka „eQRAP fotky“ patří do sdíleného disku, aby nezávisely na jednom člověku.']
];

const DECISIONS = {
  'POKRAČOVAT': 'Pokračovat s analýzou a 5 Proč',
  'VYŘEŠENO': 'Problém vyřešen: ŽÁDNÉ 5 Proč',
  'ESKALACE': 'Eskalace na vyšší úroveň (manažer)'
};
const EFF_RESULTS = ['EFEKTIVNÍ', 'NEOVĚŘENO', 'NEEFEKTIVNÍ'];
const ROLES = ['MANAŽER', 'ADMIN'];
const ASSESS_VALUES = ['OK', 'NOK', 'N/A'];
const FEEDBACK_TYPES = ['pochvala', 'silná stránka', 'ke zlepšení'];
const PARTS = ['popis', 'opatreni', 'smeny', 'rozhodnuti', 'piloti', 'pricina', 'uzavreni'];
const NEXT_STEP = {
  'OPATŘENÍ': '③ okamžitá opatření', 'ROZHODNUTÍ': '④ rozhodnutí', 'ANALÝZA': '⑤ 5 Proč a ⑥ konečné akce',
  'AKCE': '⑥ konečné akce', 'OVĚŘENÍ': '⑥ efektivita 5 směn a podpis uzavření', 'SCHVÁLENÍ': 'podpis uzavření'
};
// Closure conditions – the page gets these labels once and one true/false per QRAP (field "ck").
const CHECK_LABELS = ['QRAP je ve stavu Ověření 5 směn', 'kořenová příčina označena (⑤)', 'všechny konečné akce hotové',
  'otázka na aktualizaci standardu zodpovězena', 'efektivní na 5 různých směnách', '„Co jsme se naučili z QR?“ vyplněno'];

// What the page gets of each row – nothing more (no editor accounts, no internal columns).
const Q_PUB = ['id', 'status', 'created', 'safety', 'what', 'whatOther', 'how', 'howOther', 'when', 'zone', 'location',
  'qty', 'unit', 'nokSituation', 'repeat7', 'repeatRef', 'finder', 'descWrong', 'descRight', 'materialNo', 'huNo',
  'supplier', 'reference', 'photoWrong', 'photoRight', 'photoException', 'notified', 'notifiedOther', 'risk', 'checked', 'wrong',
  'checkRunning', 'restoredAt', 's3Done', 'shifts', 'decision', 'decisionNote', 'pilots', 'decisionBy', 'decisionAt',
  'o1', 'o2', 'o3', 'o4', 'o5', 'rootO', 'n1', 'n2', 'n3', 'n4', 'n5', 'rootN', 'learned', 'std', 'stdRef',
  'closedBy', 'closedAt', 'cancelReason'];
const A_PUB = ['qrapId', 'no', 'part', 'kind', 'text', 'owner', 'ownerEmail', 'due', 'done', 'evidence', 'note'];
const E_PUB = ['qrapId', 'round', 'slot', 'date', 'shift', 'result', 'by'];
const S_PUB = ['qrapId', 'at', 'by', 'c1', 'c2', 'c3', 'c4', 'c5', 'ojtWith', 'feedback', 'feedbackType'];
const QK = Q_PUB.concat(['s3Missing', 'eff', 'ck', 'can']); // column names of the compact list (see listData_)
// What can be done with a QRAP now, sent as one number: bit i = CAN_KEYS[i]. ck works the same way with CHECK_LABELS.
const CAN_KEYS = ['popis', 'opatreni', 'shifts', 'decide', 'analyze', 'pilots', 'effect', 'close', 'assess'];
const AK = A_PUB.concat(['canEdit', 'canDone']);

/**
 * The fields of each part of the form. The page sends a fingerprint of them as it showed them (_fp, see fp_);
 * when the fingerprint of the row now differs, somebody else saved that part meanwhile → the save is refused.
 * The same function runs on the page (Index.html, fpOf), so both sides compute the same value.
 */
const FP_FIELDS = {
  popis: ['safety', 'what', 'whatOther', 'how', 'howOther', 'when', 'zone', 'qty', 'unit', 'nokSituation', 'repeat7',
    'repeatRef', 'finder', 'descWrong', 'descRight', 'reference', 'notified', 'notifiedOther'],
  opatreni: ['risk', 'checked', 'wrong', 'restoredAt'], // + the ③ actions (fpQ_)
  smeny: ['shifts'],
  pricina: ['o1', 'o2', 'o3', 'o4', 'o5', 'rootO', 'n1', 'n2', 'n3', 'n4', 'n5', 'rootN', 'learned', 'std', 'stdRef'],
  akce: ['text', 'kind', 'owner', 'due', 'done', 'evidence', 'note']
};

/** Change this text whenever you deploy a new version: open pages then offer "Obnovit stránku". */
const APP_BUILD = '2026-10-21';

const PERF = {
  FULL_READ_CELLS: 15000, // a tab up to this size is read in one call; a bigger one by ID column + matching rows
  RUN_GAP: 40,            // matching rows closer than this are read together as one block
  CACHE_TTL: 21600,       // 6 h – the CacheService maximum
  CHUNK: 95000,           // characters per cache entry (CacheService limit: 100 KB per entry)
  MAX_CHUNKS: 40
};
const LIMIT = { ROWS: 30, ITEMS: 200, PHOTO_CHARS: 7000000, PHOTO_BYTES: 5 * 1024 * 1024, DEADLINE_H: 720, CLOSED_DAYS: 365 };
const MAIL = { PREFIX: 'MAIL:', LATE: 120000 }; // parked e-mails (Script Properties); older than LATE ms = page gone
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Per-request memory (each server call starts with empty values).
let MEMO_ = {};
let CFG_ = null;
let ME_ = null;
let SS_ = null;
let FOLDER_ = null;
let MAILOK_ = null;
let NO_MAIL_ = false;
let OUTBOX_ = [];    // e-mails waiting until the lock is released (see lock_ and send_)
let LOG_ = [];       // history lines waiting until the end of the save
let IN_LOCK_ = false;
let WROTE_ = false;  // something was written → SpreadsheetApp.flush() before the lock is released
let BUMP_ = false;   // QRAP data changed → new data version, open pages reload
let DEFER_MAIL_ = false; // a call from the page: park the e-mails, the page sends them in the background
let MAIL_KEYS_ = [];     // the parked e-mails of this call (returned to the page as mailKeys)

/** A problem the user can fix (wrong input, wrong state). Its message is shown to the user as it is. */
class UserError extends Error {}

// =====================================================================================
// 2. WEB APP ENTRY
// =====================================================================================

/** Opens the app. All data the page needs is sent together with the page, so it shows immediately. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.up) return uploadPage_(String(p.up)); // a phone that scanned the photo QR code (see PhotoHandoff.gs)
  const page = HtmlService.createTemplateFromFile('Index');
  let boot;
  try {
    boot = startData_((e && e.parameter) || {});
  } catch (err) {
    boot = { error: publicError_('doGet', err), url: appUrl_() };
  }
  // "<" is escaped, so nothing in the data can close the <script> tag it is printed into.
  page.boot = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return page.evaluate()
    .setTitle(boot.cfg ? String(boot.cfg.NAZEV) : 'eQRAP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT); // no framing by other sites
}

function startData_(params) {
  const me = me_(); // refuses visitors without a company account before anything is read
  const ver = dataVersion_(); // read before the data: a change saved meanwhile is picked up by the next refresh
  const c = cfg_();
  const view = String(params.view || '');
  return Object.assign(listCached_(false, ver), {
    me: me,
    ver: ver,
    build: APP_BUILD,
    url: appUrl_(),
    cfg: publicSettings_(c.settings),
    lists: c.lists,
    people: activePeople_(c),
    meta: { checklist: CHECK_LABELS, can: CAN_KEYS },
    params: { id: String(params.id || '').trim().slice(0, 40), view: ['new', 'help'].indexOf(view) >= 0 ? view : '' }
  });
}

// =====================================================================================
// 3. API
//    3a. Everything a browser can call. Each is a thin wrapper around run_(); the work is in 3b.
//        (Functions whose name ends with "_" cannot be called from the browser at all.)
// =====================================================================================

function apiRefresh(all, known) { return run_('apiRefresh', () => refresh_(all, known)); }
function apiGet(id, known) { return run_('apiGet', () => get_(id, known)); }
function apiCreate(f) { return run_('apiCreate', () => create_(f)); }
function apiSave(id, part, f) { return run_('apiSave', () => save_(id, part, f)); }
function apiSaveAction(id, a) { return run_('apiSaveAction', () => saveAction_(id, a)); }
function apiSaveEffect(id, p) { return run_('apiSaveEffect', () => saveEffect_(id, p)); }
function apiAssess(id, f) { return run_('apiAssess', () => assess_(id, f)); }
function apiSetPhoto(id, kind, full, thumb) { return run_('apiSetPhoto', () => setPhoto_(id, kind, full, thumb)); }
function apiPhoto(id, fileId) { return run_('apiPhoto', () => photo_(id, fileId)); }
function apiHistory(id) { return run_('apiHistory', () => history_(id)); }
function apiAdmin(id, op, reason) { return run_('apiAdmin', () => admin_(id, op, reason)); }
function apiViewAs(role) { return run_('apiViewAs', () => viewAs_(role)); }
function apiAdminData() { return run_('apiAdminData', () => adminData_()); }
function apiSavePerson(p) { return run_('apiSavePerson', () => savePerson_(p)); }
function apiSaveList(key, values) { return run_('apiSaveList', () => saveList_(key, values)); }
function apiSaveSettings(obj) { return run_('apiSaveSettings', () => saveSettings_(obj)); }
function apiMail(keys) { return run_('apiMail', () => mailOut_(keys)); }
// (the photo hand-off – apiPhotoSession, apiPhotoPoll, apiPhoneUpload, apiStagePhoto, apiPhotoDiscard – is in PhotoHandoff.gs)

/**
 * Runs one browser call: a UserError keeps its message, anything else is logged and shown only as a code.
 * E-mails of the call are parked; their keys go back to the page (mailKeys), which sends them with apiMail.
 */
function run_(name, fn) {
  DEFER_MAIL_ = true;
  try {
    const res = fn();
    if (MAIL_KEYS_.length) {
      if (res && typeof res === 'object' && !Array.isArray(res)) res.mailKeys = MAIL_KEYS_.slice();
      else sendParked_(MAIL_KEYS_); // nowhere to put the keys: send now
      MAIL_KEYS_ = [];
    }
    return res;
  } catch (e) {
    throw new Error(publicError_(name, e));
  }
}

function publicError_(name, e) {
  if (e instanceof UserError) return e.message;
  const code = Utilities.getUuid().slice(0, 8);
  console.error(name + ' [' + code + '] ' + ((e && e.stack) || e));
  if (/timed out|Service .*(failed|unavailable)|Exceeded maximum/i.test(String((e && e.message) || e))) {
    return 'Služba Google teď neodpovídá. Zkuste to prosím za chvíli znovu. (kód ' + code + ')';
  }
  return 'Nastala neočekávaná chyba (kód ' + code + '). Zkuste to znovu, případně kód pošlete správci aplikace.';
}

// ---- 3b. What each call does

/** Reload the list. known = the version the page has: unchanged → answered without reading anything. */
function refresh_(all, known) {
  me_();
  sweepMail_(); // e-mails a closed page never asked for (one cache read when there are none)
  const ver = dataVersion_();
  if (known && String(known) === ver) return { unchanged: true, ver: ver, build: APP_BUILD }; // the page has this version
  return Object.assign(listCached_(!!all, ver), { ver: ver, build: APP_BUILD });
}

/** One problem with everything that belongs to it. known = the page's data version (sent only if it has the QRAP). */
function get_(id, known) {
  me_();
  id = idOf_(id);
  if (known && String(known) === dataVersion_()) return { unchanged: true };
  return pack_(id);
}

/**
 * ① ② ③ – report a new problem. ③ needs only the risk answer now. Sending the same form twice gives one QRAP.
 * Photos: taken on the kiosk (f.photoWrong …) or handed over from a phone (f.photoToken, see PhotoHandoff.gs).
 * An expired phone session never blocks the save – the answer then carries phoneExpired = true.
 */
function create_(f) {
  f = obj_(f);
  me_();
  const cache = CacheService.getScriptCache();
  const token = /^[\w-]{8,64}$/.test(String(f.token || '')) ? 'create:' + f.token : '';
  const known = token && cache.get(token);
  if (known) return pack_(known); // double click or a lost answer: the QRAP already exists
  rate_('create', 30, 600);
  const phone = phonePhotos_(f.photoToken, f.photoDrop); // photos from the phone hand-off; never throws
  const s3in = obj_(f.s3);
  const q = popisFrom_(f, {});
  Object.assign(q, opatreniFrom_(s3in, q.when));
  const ia = rowsIn_(s3in.ia).filter(r => !r.remove).map(r => iaFields_(r, q.when));
  checkRepeat_(q); // read-only, checked before anything is uploaded
  const files = [];
  let res;
  try {
    q.photoWrong = savePhotoPair_(f.photoWrong, f.photoWrongThumb, files) || phone.WRONG; // slow Drive writes: outside the lock
    q.photoRight = savePhotoPair_(f.photoRight, f.photoRightThumb, files) || phone.RIGHT;
    res = lock_(() => {
      const again = token && cache.get(token);
      if (again) return { id: again, dup: true };
      q.id = nextId_();
      q.created = nowIso_();
      q.createdBy = me_().email;
      addQuality_(q);
      seedNew_(q.id); // a brand-new ID has no rows in the other tabs – nothing to read
      insertMany_(TAB.actions, ia.map((r, i) => Object.assign({ qrapId: q.id, no: i + 1, part: '③', created: nowIso_() }, r)));
      finish_(q, 'Nahlášeno: ' + short_(title_(q)), true);
      mailNew_(q);
      if (token) cache.put(token, q.id, 3600);
      return { id: q.id, dup: false };
    });
  } catch (e) {
    trash_(files); // the phone photos stay: the operator can press Odeslat again
    throw e;
  }
  if (res.dup) trash_(files);
  else { trash_(phone.unused); phoneDone_(f.photoToken); } // phone photos that were removed on the kiosk go to the trash
  const out = pack_(res.id);
  if (phone.expired) out.phoneExpired = true;
  return out;
}

/**
 * Save one part of the form.
 *   'popis' ① ② · 'opatreni' ③ · 'smeny' ④ shifts informed · 'rozhodnuti' ④ decision (signature)
 *   'piloti' add pilots · 'pricina' ⑤ · 'uzavreni' ⑥ closure signature
 */
function save_(id, part, f) {
  id = idOf_(id);
  f = obj_(f);
  need_(PARTS.indexOf(part) >= 0, 'Neznámá část formuláře.');
  let conflict = null;
  lock_(() => {
    const me = me_();
    const q = find_(id);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts, effectsFor_(q));
    // somebody saved this part after the page showed it: write nothing, the page asks what to do
    if (FP_FIELDS[part] && f._fp && String(f._fp) !== fpQ_(q, part, acts)) { conflict = conflictOf_(q); return; }
    let text;

    if (part === 'popis') {
      need_(beforeDecision_(q), 'Popis ① ② lze upravit jen do rozhodnutí ④ (potom jen po odemknutí manažerem).');
      const before = q.safety;
      Object.assign(q, popisFrom_(f, q));
      checkRepeat_(q);
      addQuality_(q);
      if (q.safety === 'ANO' && before !== 'ANO') mailSafety_(q);
      text = '①② Popis upraven';

    } else if (part === 'opatreni') {
      need_(beforeDecision_(q), 'Okamžitá opatření ③ lze měnit jen do rozhodnutí ④.');
      const before = q.risk;
      const s = opatreniFrom_(f, q.when);
      const rows = rowsIn_(f.ia).map(r => (r.remove ? { no: r.no, remove: true } : Object.assign({ no: r.no }, iaFields_(r, q.when))));
      Object.assign(q, s);
      syncIa_(q.id, rows);
      addQuality_(q);
      if (q.risk === 'ANO' && before !== 'ANO') mailQuality_(q);
      text = '③ Okamžitá opatření uložena';

    } else if (part === 'smeny') {
      need_(beforeDecision_(q), 'Směny lze označit jen do rozhodnutí ④.');
      q.shifts = onlyFrom_(f.shifts, cfg_().lists.shifts);
      text = '④ Informované směny: ' + (q.shifts || '–');

    } else if (part === 'rozhodnuti') {
      need_(!q.decision, 'Rozhodnutí už je podepsané. Změnit ho může manažer (Odemknout ①–④).');
      need_(canDecide_(q), 'Rozhodnutí je možné, až jsou okamžitá opatření ③ kompletní.');
      const d = oneOf_(f.decision, Object.keys(DECISIONS), 'Vyberte rozhodnutí.');
      const note = txt_(f.decisionNote);
      const pilots = emailsOf_(f.pilots);
      if (d === 'VYŘEŠENO') {
        need_(q.safety !== 'ANO', 'Bezpečnostní problém (SAFETY = ANO) nelze uzavřít bez 5 Proč.');
        need_(note, 'Napište komentář – proč je problém vyřešen.');
      }
      if (d === 'ESKALACE') need_(note, 'Napište komentář – proč eskalujete.');
      if (d === 'POKRAČOVAT') need_(pilots.length, 'Vyberte alespoň jednoho pilota pro analýzu 5 Proč.');
      if (f.shifts !== undefined) q.shifts = onlyFrom_(f.shifts, cfg_().lists.shifts);
      Object.assign(q, { decision: d, decisionNote: note, pilots: pilots.join(','), decisionBy: me.name, decisionAt: nowIso_() });
      if (d === 'VYŘEŠENO') { q.closedAt = q.decisionAt; q.closedBy = me.name; } // solved without 5 Proč: closed at once
      text = '④ Rozhodnutí podepsáno: ' + DECISIONS[d] + (pilots.length ? ' · piloti: ' + pilots.join(', ') : '');
      if (pilots.length) mailPilots_(q, pilots);
      if (d === 'ESKALACE') mailEscalated_(q);

    } else if (part === 'piloti') {
      need_(isAnalysis_(q), 'Piloty lze přidat během analýzy.');
      const have = list_(q.pilots);
      const added = emailsOf_(f.pilots).filter(e => have.indexOf(e) < 0);
      need_(added.length, 'Vyberte nového pilota.');
      q.pilots = have.concat(added).join(',');
      mailPilots_(q, added);
      text = '⑤ Přidán pilot: ' + added.join(', ');

    } else if (part === 'pricina') {
      need_(canAnalyze_(q), '5 Proč lze vyplnit během analýzy.');
      Object.assign(q, pricinaFrom_(f));
      syncStdAction_(q);
      text = '⑤ Analýza 5 Proč uložena';

    } else { // 'uzavreni'
      need_(canClose_(q), 'QRAP zatím nelze uzavřít – musí být ve stavu „Ověření 5 směn“.');
      if (q.status !== 'SCHVÁLENÍ') {
        const miss = checks_(q, actionsOf_(id), effState_(effectsOf_(id))).map((ok, i) => (ok ? '' : CHECK_LABELS[i])).filter(String);
        need_(!miss.length, 'QRAP zatím nelze uzavřít. Chybí: ' + miss.join(', ') + '.');
      }
      q.closedAt = nowIso_();
      q.closedBy = me.name;
      text = '⑥ Uzavření QRAP podepsáno';
    }
    finish_(q, text);
  });
  const res = pack_(id);
  if (conflict) res.conflict = conflict;
  return res;
}

/** Fingerprint of one part of a QRAP as it is in the Sheet now (see FP_FIELDS). */
function fpQ_(q, part, acts) {
  const vals = FP_FIELDS[part].map(k => q[k]);
  if (part === 'opatreni') iaActions_(acts).forEach(a => vals.push(a.no, a.text, a.owner, a.done));
  return fp_(vals);
}

/**
 * A short fingerprint of a list of values (FNV-1a). Times count to the minute, so a time read back from the Sheet
 * equals the one the page got right after saving. Index.html has the same function (fpOf) – keep them equal.
 */
function fp_(vals) {
  const s = vals.map(v => {
    v = String(v === null || v === undefined ? '' : v);
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) ? v.slice(0, 16) : v;
  }).join('\u001f');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** Who saved the QRAP last and when – told to the person whose save was refused. */
function conflictOf_(q) {
  const p = cfg_().people.filter(x => x.email === q.updatedBy)[0];
  return { by: p ? p.name : String(q.updatedBy || 'někdo jiný'), at: q.updated || '' };
}

/**
 * ⑥ Add or change a definitive action (while the analysis runs).
 *   new: {text, kind, owner, due, evidence, note} · change: {no, …, done, remove} · done: {no, done: true}
 */
function saveAction_(id, a) {
  id = idOf_(id);
  a = obj_(a);
  let conflict = null;
  lock_(() => {
    me_();
    const q = find_(id);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts, effectsFor_(q));
    need_(isAnalysis_(q), 'Konečné akce lze zadávat a měnit jen během analýzy.');
    let text;
    if (a.no) {
      const act = acts.filter(x => x.no === Number(a.no) && x.part === '⑥')[0];
      need_(act && !act.removed, 'Akce nenalezena (možná ji mezitím někdo odebral).');
      if (a._fp && String(a._fp) !== fp_(FP_FIELDS.akce.map(k => act[k]))) { conflict = conflictOf_(q); return; }
      if (a.text !== undefined) {
        const before = act.ownerEmail;
        Object.assign(act, defActionFields_(a, q));
        if (act.due && !act.dueFirst) act.dueFirst = act.due;
        if (act.ownerEmail && act.ownerEmail !== before) mailAction_(q, act);
      }
      if (a.remove === true) act.removed = 'ANO';
      if (a.evidence !== undefined) act.evidence = url_(a.evidence);
      if (a.note !== undefined) act.note = txt_(a.note, 500);
      if (a.done === true && !act.done) act.done = nowIso_();
      else if (typeof a.done === 'string' && a.done) {
        need_(day_(a.done) <= Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'), 'Datum hotovo nemůže být v budoucnosti.');
        act.done = dayIso_(a.done);
      } else if (a.done === false || a.done === '') act.done = '';
      update_(TAB.actions, act);
      text = '⑥ Akce ' + act.no + (act.removed ? ' odebrána' : act.done ? ' hotová' : ' upravena') + ': ' + short_(act.text);
    } else {
      const act = Object.assign({ qrapId: id, no: nextNo_(acts), part: '⑥', done: '', removed: '', created: nowIso_() },
        defActionFields_(a, q));
      act.dueFirst = act.due;
      act.evidence = url_(a.evidence);
      act.note = txt_(a.note, 500);
      insert_(TAB.actions, act);
      text = '⑥ Nová konečná akce ' + act.no + ': ' + short_(act.text) + ' (' + act.owner + ', plán ' + act.due + ')';
      mailAction_(q, act);
    }
    finish_(q, text);
  });
  const res = pack_(id);
  if (conflict) res.conflict = conflict;
  return res;
}

/** ⑥ Efektivita – one slot {slot, date, shift, result}. "NEEFEKTIVNÍ" sends the QRAP back to analysis. */
function saveEffect_(id, p) {
  id = idOf_(id);
  p = obj_(p);
  lock_(() => {
    const me = me_();
    const q = find_(id);
    const acts = actionsOf_(id);
    const rows = effectsOf_(id);
    q.status = statusOf_(q, acts, rows);
    need_(q.status === 'OVĚŘENÍ', 'Efektivita se zapisuje ve stavu „Ověření 5 směn“ (všechny akce hotové).');
    const eff = effState_(rows);
    const slot = Number(p.slot);
    const date = txt_(p.date, 10);
    const shift = txt_(p.shift, 50);
    const result = oneOf_(p.result, EFF_RESULTS, 'Vyberte výsledek.');
    const todayStr = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
    need_(slot >= 1 && slot <= 5, 'Neplatný slot.');
    need_(/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= todayStr, 'Datum směny musí být vyplněné a nesmí být v budoucnosti.');
    const lastDone = defActions_(acts).map(a => a.done).filter(String).sort().pop();
    if (lastDone) {
      need_(date >= Utilities.formatDate(new Date(lastDone), tz_(), 'yyyy-MM-dd'),
        'Směna musí být až po dokončení konečných akcí – nejdříve ' + Utilities.formatDate(new Date(lastDone), tz_(), 'd. M. yyyy') + '.');
    }
    need_(cfg_().lists.shifts.indexOf(shift) >= 0, 'Vyberte směnu.');
    const current = eff.slots[slot - 1];
    need_(!current || current.result !== 'EFEKTIVNÍ', 'Efektivní slot už nelze změnit.');
    need_(result !== 'EFEKTIVNÍ' || !eff.slots.some((s, i) => s && i !== slot - 1 && s.result === 'EFEKTIVNÍ' &&
      s.date === date && s.shift === shift), 'Každý efektivní slot musí být jiná směna (datum + směna).');
    const values = { date: date, shift: shift, result: result, by: me.name, at: nowIso_() };
    if (current) { Object.assign(current, values); update_(TAB.effects, current); }
    else insert_(TAB.effects, Object.assign({ qrapId: id, round: eff.round, slot: slot }, values));
    if (result === 'NEEFEKTIVNÍ') mailNotEffective_(q);
    finish_(q, '⑥ Efektivita – kolo ' + eff.round + ', slot ' + slot + ': ' + result + ' (' + date + ', ' + shift + ')');
  });
  return pack_(id);
}

/** ⑦ Hodnocení QRQC – one more assessment (a QRAP can be assessed many times). */
function assess_(id, f) {
  id = idOf_(id);
  f = obj_(f);
  lock_(() => {
    const me = me_();
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id), effectsFor_(q));
    need_(canAssess_(q), 'Zrušený QRAP nelze hodnotit.');
    const row = { qrapId: id, at: nowIso_(), by: me.name };
    ['c1', 'c2', 'c3', 'c4', 'c5'].forEach(k => { row[k] = oneOf_(f[k], ASSESS_VALUES, 'Ohodnoťte všech 5 bodů (OK / NOK / N/A).'); });
    row.ojtWith = txt_(f.ojtWith, 200);
    row.feedback = txt_(f.feedback);
    row.feedbackType = f.feedbackType ? oneOf_(f.feedbackType, FEEDBACK_TYPES, 'Neplatný typ zpětné vazby.') : '';
    insert_(TAB.assess, row);
    finish_(q, '⑦ Hodnocení QRQC (' + ['c1', 'c2', 'c3', 'c4', 'c5'].map(k => row[k]).join(' / ') + ')');
  });
  return pack_(id);
}

/** ① Replace one photo (kind 'WRONG' / 'RIGHT'). The upload runs outside the lock; a refused save removes it again. */
function setPhoto_(id, kind, full, thumb) {
  id = idOf_(id);
  me_();
  rate_('photo', 40, 600);
  const key = kind === 'RIGHT' ? 'photoRight' : 'photoWrong';
  const locked = 'Fotku lze změnit jen do rozhodnutí ④ (potom jen po odemknutí manažerem).';
  need_(undecided_(find_(id)), locked); // cheap check before the slow upload
  const files = [];
  try {
    const value = savePhotoPair_(full, thumb, files);
    need_(value, 'Chybí fotka.');
    lock_(() => {
      const q = find_(id);
      need_(undecided_(q), locked);
      const old = q[key];
      q[key] = value;
      finish_(q, '① Nahrána fotka ' + (kind === 'RIGHT' ? 'SPRÁVNĚ' : 'ŠPATNĚ') + (old ? ' (předchozí soubory: ' + old + ')' : ''));
    });
  } catch (e) {
    trash_(files);
    throw e;
  }
  return pack_(id);
}

/**
 * One photo as a data URL. Only files stored in this QRAP's photo columns can be read (the app runs as its deployer,
 * so this check is what keeps every other Drive file out of reach). A preview that was already checked and cached
 * (dataUrl_) is answered straight from the cache – no Sheet and no Drive read.
 */
function photo_(id, fileId) {
  me_();
  id = idOf_(id);
  fileId = String(fileId || '');
  need_(/^[\w-]{10,100}$/.test(fileId), 'Fotka k tomuto problému nepatří.');
  const hit = CacheService.getScriptCache().get('img:' + fileId);
  if (hit) return hit;
  const q = find_(id);
  need_(photoIds_(q.photoWrong).concat(photoIds_(q.photoRight)).indexOf(fileId) >= 0, 'Fotka k tomuto problému nepatří.');
  return dataUrl_(fileId);
}

/** Change history of one problem, newest first (reads only that QRAP's history rows). */
function history_(id) {
  me_();
  id = idOf_(id);
  return rowsBy_(TAB.log, id).slice().reverse().map(r => ({ at: r.at, by: r.by, text: r.text }));
}

/** Managers / admins, always with a reason: 'cancel' · 'reopen' · 'unlock' ①–④ (cancels the decision). */
function admin_(id, op, reason) {
  id = idOf_(id);
  need_(['cancel', 'reopen', 'unlock'].indexOf(op) >= 0, 'Neznámá operace.');
  lock_(() => {
    need_(me_().manager, 'Zrušit, znovu otevřít nebo odemknout QRAP může jen manažer nebo admin.');
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id), effectsFor_(q));
    const why = txt_(reason, 300);
    need_(why, 'Napište důvod.');
    let text;
    if (op === 'cancel') {
      need_(isOpen_(q), 'Problém už je uzavřený.');
      q.cancelReason = why;
      text = 'Zrušeno: ' + why;
    } else if (op === 'reopen') {
      need_(!isOpen_(q), 'Problém je otevřený.');
      if (q.cancelReason) q.cancelReason = '';
      else if (q.decision === 'VYŘEŠENO') clearDecision_(q);
      else { q.closedAt = ''; q.closedBy = ''; }
      text = 'Znovu otevřeno: ' + why;
    } else {
      need_(q.decision && isOpen_(q), 'Odemknout lze jen otevřený QRAP s podepsaným rozhodnutím.');
      clearDecision_(q);
      text = 'Odemčeno ①–④ (rozhodnutí zrušeno): ' + why;
    }
    finish_(q, text);
  });
  return pack_(id);
}

/** "Zobrazit jako" – an admin sees the app as another role ('' = admin, '-' = user, 'MANAŽER'). */
function viewAs_(role) {
  const me = me_();
  need_(me.canViewAs, 'Jen pro admina.');
  role = String(role || '');
  need_(['', '-', 'MANAŽER'].indexOf(role) >= 0, 'Neplatná role.');
  const props = PropertiesService.getScriptProperties();
  if (role) props.setProperty('VIEW_AS:' + me.email, role); else props.deleteProperty('VIEW_AS:' + me.email);
  ME_ = null;
  return startData_({});
}

// ---- Správa (ADMIN only): people, lists and settings from the web page instead of the Sheet

function adminData_() {
  need_(me_().admin, 'Správa je jen pro admina.');
  clearCache_();
  const c = cfg_();
  return {
    people: c.people.map(p => ({ row: p.row, name: p.name, email: p.email, role: p.role, area: p.area, active: p.active, mail: p.mail !== false })),
    lists: LISTS.map(l => ({ key: l[0], title: l[1], values: c.lists[l[0]] })),
    settings: SETTINGS.map(x => ({ key: x[0], value: c.settings[x[0]], help: x[2] })),
    roles: ROLES,
    boot: { people: activePeople_(c), lists: c.lists, cfg: publicSettings_(c.settings) }
  };
}

/** Add a person (no row) or change one (row = row number in Lidé). People are never deleted – set active false. */
function savePerson_(p) {
  p = obj_(p);
  const me = me_();
  need_(me.admin, 'Správa je jen pro admina.');
  return lock_(() => {
    clearCache_();
    const people = cfg_().people;
    const v = [txt_(p.name, 100), txt_(p.email, 100).toLowerCase(), p.role ? oneOf_(p.role, ROLES, 'Neplatná role.') : '',
      txt_(p.area, 100), p.active === false ? 'NE' : 'ANO', p.mail === false ? 'NE' : 'ANO'];
    need_(v[0], 'Vyplňte jméno.');
    need_(EMAIL_RE.test(v[1]), 'Vyplňte platný e-mail.');
    const row = Number(p.row) || 0;
    need_(!people.some(x => x.email === v[1] && x.row !== row), 'Tento e-mail už v seznamu je.');
    // nobody locks themselves out: your own row keeps ADMIN, active and your e-mail (another admin can change it)
    const self = row && people.filter(x => x.row === row && x.email === me.email)[0];
    need_(!self || (v[2] === 'ADMIN' && v[4] === 'ANO' && v[1] === me.email),
      'Sami sobě nemůžete odebrat roli ADMIN, změnit e-mail ani se deaktivovat – tím byste přišli o Správu. Požádejte jiného admina.');
    const sh = sheet_(TAB.people);
    const mc = mailColOf_(sh); // the "E-maily" column (added when missing)
    // Role, Aktivní and E-maily have a dropdown check in the Sheet: written plain; text columns as text.
    const cells = [v[0] ? "'" + v[0] : '', "'" + v[1], v[2], v[3] ? "'" + v[3] : '', v[4]];
    if (row) {
      need_(people.some(x => x.row === row), 'Osoba nenalezena.');
      if (mc === 6) sh.getRange(row, 1, 1, 6).setValues([cells.concat(v[5])]);
      else { sh.getRange(row, 1, 1, 5).setValues([cells]); sh.getRange(row, mc).setValue(v[5]); }
    } else {
      const line = cells.slice();
      while (line.length < mc) line.push('');
      line[mc - 1] = v[5];
      sh.appendRow(line);
    }
    WROTE_ = true;
    log_('SPRÁVA', 'Lidé: ' + v[0] + ' <' + v[1] + '> ' + (v[2] || 'uživatel') + (v[4] === 'NE' ? ' (neaktivní)' : '') +
      (v[5] === 'NE' ? ' (bez e-mailů)' : ''));
    return adminData_();
  });
}

/** Replace one list of the tab Seznamy (one value per item, empty values and duplicates dropped). */
function saveList_(key, values) {
  need_(me_().admin, 'Správa je jen pro admina.');
  const l = LISTS.filter(x => x[0] === key)[0];
  need_(l, 'Neznámý seznam.');
  const raw = Array.isArray(values) ? values : [];
  need_(raw.length <= LIMIT.ITEMS, 'Seznam je příliš dlouhý (max ' + LIMIT.ITEMS + ' položek).');
  const vals = raw.map(v => noComma_(txt_(v, 100))).filter((v, i, a) => v && a.indexOf(v) === i);
  need_(vals.length, 'Seznam nesmí být prázdný.');
  return lock_(() => {
    const sh = sheet_(TAB.lists);
    const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(v => String(v).trim());
    let col = head.indexOf(l[1]) + 1;
    if (!col) {
      col = head.filter(String).length + 1;
      if (sh.getMaxColumns() < col) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
      sh.getRange(1, col).setValue(l[1]);
    }
    const n = Math.max(vals.length, sh.getLastRow() - 1, 1);
    if (sh.getMaxRows() < n + 1) sh.insertRowsAfter(sh.getMaxRows(), n + 1 - sh.getMaxRows());
    const out = [];
    for (let i = 0; i < n; i++) out.push([vals[i] ? "'" + vals[i] : '']);
    sh.getRange(2, col, n, 1).setValues(out);
    WROTE_ = true;
    log_('SPRÁVA', 'Seznam „' + l[1] + '“: ' + vals.join(', '));
    return adminData_();
  });
}

/** Change settings (only the keys of the tab Nastavení, each checked). */
function saveSettings_(obj) {
  obj = obj_(obj);
  need_(me_().admin, 'Správa je jen pro admina.');
  const numbers = ['LHUTA_OPATRENI_HODIN', 'ZOBRAZIT_UZAVRENE_DNI'];
  const clean = {};
  Object.keys(obj).forEach(k => {
    need_(SETTINGS.some(x => x[0] === k), 'Neznámé nastavení ' + k);
    let v = txt_(obj[k], 300);
    if (numbers.indexOf(k) >= 0) {
      // upper limits: a typo like 99999 days would make every page load slow (all closed QRAPs on the board)
      const max = k === 'LHUTA_OPATRENI_HODIN' ? LIMIT.DEADLINE_H : LIMIT.CLOSED_DAYS;
      need_(/^\d+$/.test(v) && Number(v) > 0 && Number(v) <= max, k + ': zadejte celé číslo od 1 do ' + max + '.');
      v = Number(v);
    }
    if (k === 'EMAILY') v = oneOf_(v, ['ANO', 'NE'], 'EMAILY: ANO nebo NE.');
    if (k === 'EMAIL_KVALITA' || k === 'EMAIL_BOZP') need_(!v || EMAIL_RE.test(v), k + ': neplatný e-mail.');
    if (k === 'ODKAZ_APLIKACE') need_(!v || /^https:\/\/\S+$/.test(v), 'Odkaz aplikace musí začínat https://');
    if (k === 'NAZEV') need_(v, 'Název nesmí být prázdný.');
    clean[k] = v;
  });
  return lock_(() => {
    const sh = sheet_(TAB.settings);
    const rows = sh.getDataRange().getValues();
    Object.keys(clean).forEach(k => {
      const i = rows.findIndex(r => String(r[0]).trim() === k);
      const val = typeof clean[k] === 'number' ? clean[k] : "'" + clean[k];
      if (i >= 0) sh.getRange(i + 1, 2).setValue(val);
      else sh.appendRow([k, val, (SETTINGS.filter(x => x[0] === k)[0] || [])[2] || '']);
    });
    WROTE_ = true;
    BUMP_ = true; // "uzavřené na tabuli (dní)" changes what the list contains
    log_('SPRÁVA', 'Nastavení: ' + Object.keys(clean).map(k => k + ' = ' + clean[k]).join(', '));
    return adminData_();
  });
}

function publicSettings_(settings) {
  const o = {};
  PUBLIC_SETTINGS.forEach(k => { o[k] = settings[k]; });
  return o;
}

/** Active people as the page needs them: name and e-mail (roles stay on the server). */
function activePeople_(c) {
  return c.people.filter(p => p.active && p.email).map(p => ({ name: p.name, email: p.email }));
}

function clearDecision_(q) {
  Object.assign(q, { decision: '', decisionNote: '', decisionBy: '', decisionAt: '', closedAt: '', closedBy: '' });
}

// =====================================================================================
// 4. STATUS RULES – the status is always calculated from what is filled in
// =====================================================================================

/**
 * OPATŘENÍ → ROZHODNUTÍ → (VYŘEŠENO = closed at once) | ANALÝZA → AKCE → OVĚŘENÍ → UZAVŘENO (closure signature)
 * ANALÝZA: root cause not marked or no action yet (after "neefektivní" a NEW action is needed).
 * SCHVÁLENÍ only appears for older QRAPs decided "VYŘEŠENO" before this version: they still need the closure signature.
 */
function statusOf_(q, acts, effs) {
  if (q.cancelReason) return 'ZRUŠENO';
  if (q.closedAt) return 'UZAVŘENO';
  if (!q.s3Done) return 'OPATŘENÍ';
  if (!q.decision) return 'ROZHODNUTÍ';
  if (q.decision === 'VYŘEŠENO') return 'SCHVÁLENÍ';
  const defs = defActions_(acts);
  const eff = effState_(effs);
  const thisRound = eff.reopenAt ? defs.filter(a => a.created > eff.reopenAt) : defs;
  if (!rootOk_(q) || !defs.length || !thisRound.length) return 'ANALÝZA';
  if (defs.some(a => !a.done)) return 'AKCE';
  return 'OVĚŘENÍ';
}

/** The 5-shift rows matter for the status only in the analysis branch of statusOf_ – otherwise they are not read. */
function needsEffects_(q) { return !q.cancelReason && !q.closedAt && !!q.decision && q.decision !== 'VYŘEŠENO'; }
function effectsFor_(q) { return needsEffects_(q) ? effectsOf_(q.id) : []; }

function isOpen_(q) { return q.status !== 'UZAVŘENO' && q.status !== 'ZRUŠENO'; }
function isAnalysis_(q) { return ['ANALÝZA', 'AKCE', 'OVĚŘENÍ'].indexOf(q.status) >= 0; }
function defActions_(acts) { return acts.filter(a => a.part === '⑥' && !a.removed); }
function iaActions_(acts) { return acts.filter(a => a.part === '③' && !a.removed); }
function rootOk_(q) { return !!((q.rootO && q['o' + q.rootO]) || (q.rootN && q['n' + q.rootN])); }

/** Which ③ rules are not met yet (empty list = ③ complete). */
function s3Missing_(q, ia) {
  const m = [];
  if (!q.risk) m.push('odpověď na riziko (ochranná opatření)');
  if (q.risk === 'ANO') {
    if (q.checkRunning) m.push('třídění ještě probíhá');
    else if (q.checked === '' || q.wrong === '') m.push('třídění – data');
  }
  if (!ia.length) m.push('alespoň jedno okamžité opatření');
  else if (ia.some(a => !a.done)) m.push('čas u všech okamžitých opatření');
  return m;
}

/** 5-shift check: current round, its 5 slots, and whether 5 different shifts were effective. */
function effState_(rows) {
  const bad = rows.filter(r => r.result === 'NEEFEKTIVNÍ');
  const round = 1 + bad.reduce((m, r) => Math.max(m, r.round), 0);
  const reopenAt = bad.reduce((m, r) => (r.at > m ? r.at : m), '');
  const slots = [1, 2, 3, 4, 5].map(n => rows.filter(r => r.round === round && r.slot === n).pop() || null);
  const ok = slots.filter(s => s && s.result === 'EFEKTIVNÍ').map(s => s.date + '|' + s.shift);
  return { round: round, reopenAt: reopenAt, slots: slots, okCount: ok.length,
    allOk: ok.length === 5 && ok.filter((x, i) => ok.indexOf(x) === i).length === 5 };
}

/** Closure conditions ("Uzavření QRAP schváleno"): one true / false per label in CHECK_LABELS. */
function checks_(q, acts, eff) {
  const defs = defActions_(acts);
  return [q.status === 'OVĚŘENÍ', rootOk_(q), defs.length > 0 && defs.every(a => a.done),
    q.std === 'NE' || (q.std === 'ANO' && !!q.stdRef), eff.allOk, !!q.learned];
}

/** Recalculate ③ completeness and the status, save the row and queue the history. lock_() does flush + version. */
function finish_(q, text, isNew) {
  const acts = actionsOf_(q.id);
  const complete = !s3Missing_(q, iaActions_(acts)).length;
  if (complete && !q.s3Done) q.s3Done = nowIso_();
  if (!complete && !q.decision) q.s3Done = '';
  const before = q.status;
  q.status = statusOf_(q, acts, effectsFor_(q));
  q.updated = nowIso_();
  q.updatedBy = who_();
  if (isNew) insert_(TAB.qraps, q); else update_(TAB.qraps, q);
  log_(q.id, text);
  if (!isNew && before !== q.status) log_(q.id, 'Stav: ' + q.status);
  BUMP_ = true;
}

// =====================================================================================
// 5. PERMISSIONS AND WHAT THE PAGE GETS
//    Every signed-in company user may do every step – the status decides what is possible right now.
// =====================================================================================

function me_() {
  if (ME_) return ME_;
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { email = ''; }
  // No e-mail = not signed in with a company account (or the app was opened to "Anyone"): refuse.
  need_(email, 'Přihlaste se firemním účtem Google a otevřete aplikaci znovu.');
  const people = cfg_().people.filter(x => x.active && x.email);
  const p = people.filter(x => x.email === email)[0];
  let role = p ? p.role : '';
  // Safety net: while Lidé has no active admin, the account the app runs as is admin (nobody is locked out).
  if (!people.some(x => x.role === 'ADMIN') && email === runAsEmail_()) role = 'ADMIN';
  const realAdmin = role === 'ADMIN';
  let viewAs = '';
  if (realAdmin) {
    viewAs = String(PropertiesService.getScriptProperties().getProperty('VIEW_AS:' + email) || '');
    if (viewAs) role = viewAs === '-' ? '' : viewAs;
  }
  ME_ = person_(email, p ? p.name : email.split('@')[0], role, p ? p.area : '');
  ME_.canViewAs = realAdmin;
  ME_.viewAs = viewAs;
  return ME_;
}

/** The account the script runs as: through the web app the person who deployed it, from the menu the clicker. */
function runAsEmail_() {
  return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

function person_(email, name, role, area) {
  return { email: email, name: name, role: role, area: area, manager: role === 'MANAŽER' || role === 'ADMIN', admin: role === 'ADMIN' };
}

function beforeDecision_(q) { return isOpen_(q) && !q.decision; } // ① ② ③, photos, shifts informed
function undecided_(q) { return !q.cancelReason && !q.closedAt && !q.decision; } // the same, without reading the status
function canDecide_(q) { return q.status === 'ROZHODNUTÍ'; }
function canAnalyze_(q) { return isAnalysis_(q); }
function canEffect_(q) { return q.status === 'OVĚŘENÍ'; }
function canClose_(q) { return q.status === 'OVĚŘENÍ' || q.status === 'SCHVÁLENÍ'; }
function canAssess_(q) { return q.status !== 'ZRUŠENO'; }

/**
 * A problem as the page gets it (only Q_PUB) with what can be done now – the same for everybody.
 * eff = [round, effective shifts, all 5 ok (1/0)] · ck = closure conditions as bits · can = CAN_KEYS as bits.
 */
function pubQ_(q, acts, effs) {
  const o = only_(q, Q_PUB);
  const eff = effState_(effs);
  const early = beforeDecision_(q);
  const can = [early, early, early, canDecide_(q), canAnalyze_(q), isAnalysis_(q), canEffect_(q), canClose_(q), canAssess_(q)];
  o.s3Missing = s3Missing_(q, iaActions_(acts));
  o.eff = [eff.round, eff.okCount, eff.allOk ? 1 : 0];
  o.ck = bits_(checks_(q, acts, eff));
  o.can = bits_(can);
  return o;
}

function bits_(flags) { return flags.reduce((m, on, i) => m | (on ? 1 << i : 0), 0); }

function pubA_(a, q) {
  const o = only_(a, A_PUB);
  const open = a.part === '⑥' && !a.removed && isAnalysis_(q);
  o.canEdit = open;
  o.canDone = open && !a.done;
  return o;
}

function only_(row, keys) {
  const o = {};
  keys.forEach(k => { o[k] = row[k] === undefined ? '' : row[k]; });
  return o;
}

/** One problem with its actions (removed ones are left out), 5-shift checks and assessments. */
function pack_(id) {
  me_(); // refuses visitors without a company account
  const q = find_(id);
  const acts = actionsOf_(id);
  const effs = effectsOf_(id);
  q.status = statusOf_(q, acts, effs);
  return {
    qrap: pubQ_(q, acts, effs),
    actions: acts.filter(a => !a.removed).map(a => pubA_(a, q)),
    effects: effs.map(r => only_(r, E_PUB)),
    assess: rowsBy_(TAB.assess, id).map(r => only_(r, S_PUB))
  };
}

/**
 * Open problems + problems closed in the last N days (or everything when all = true), compact:
 * every list is { k: column names, r: rows of values }, so a name is sent once, not once per row.
 * Callers check the user (me_) first. The result is the same for every user, which is what makes it cacheable.
 */
function listData_(all) {
  // capped: a huge number typed into the Sheet by hand must not slow down every page load
  const since = Date.now() - Math.min(Number(setting_('ZOBRAZIT_UZAVRENE_DNI')) || 60, LIMIT.CLOSED_DAYS) * 864e5;
  const acts = groupBy_(table_(TAB.actions).all);
  const effs = groupBy_(table_(TAB.effects).all);
  const assess = groupBy_(table_(TAB.assess).all);
  const out = { qraps: { k: QK, r: [] }, actions: { k: AK, r: [] }, effects: { k: E_PUB, r: [] }, assess: { k: S_PUB, r: [] }, all: !!all };
  table_(TAB.qraps).all.forEach(q => {
    const a = (acts.get(q.id) || []).sort((x, y) => x.no - y.no);
    const e = effs.get(q.id) || [];
    q.status = statusOf_(q, a, e);
    if (!all && !isOpen_(q) && new Date(q.closedAt || q.updated || q.created).getTime() < since) return;
    const p = pubQ_(q, a, e);
    out.qraps.r.push(QK.map(k => p[k]));
    a.forEach(x => { if (!x.removed) { const o = pubA_(x, q); out.actions.r.push(AK.map(k => o[k])); } });
    e.forEach(x => out.effects.r.push(E_PUB.map(k => x[k])));
    (assess.get(q.id) || []).forEach(x => out.assess.r.push(S_PUB.map(k => x[k])));
  });
  return out;
}

/** The list for one data version: from the cache if somebody already built it, else built once and cached. */
function listCached_(all, ver) {
  const key = (all ? 'listall:' : 'list:') + ver;
  const hit = cacheGetBig_(key);
  if (hit) return hit;
  const data = listData_(all);
  cachePutBig_(key, data);
  return data;
}

function groupBy_(rows) {
  const m = new Map();
  rows.forEach(r => { const g = m.get(r.qrapId); if (g) g.push(r); else m.set(r.qrapId, [r]); });
  return m;
}

// =====================================================================================
// 6. SHEET ACCESS, CACHE AND FORM CHECKS
// =====================================================================================

function sheet_(name) {
  const sh = (SS_ || (SS_ = SpreadsheetApp.getActiveSpreadsheet())).getSheetByName(name);
  need_(sh, 'V tabulce chybí list „' + name + '“. Spusťte v tabulce menu eQRAP → Nastavit tabulku.');
  return sh;
}

/**
 * Per-request memory of one data tab. Every sheet row exists as ONE object (objs, keyed by row number), however
 * it was read, so a change to it is seen everywhere in the request.
 *   all = the whole tab (small tabs, the list, the daily reminder) · by[id] = the rows of one QRAP (big tabs)
 */
function memo_(name) {
  if (!MEMO_[name]) {
    const t = { name: name, sh: null, idx: null, first: 0, last: 0, lastRow: null, range: null, all: null, by: {}, keys: null, objs: {} };
    t.sheet = () => t.sh || (t.sh = sheet_(name));
    MEMO_[name] = t;
  }
  return MEMO_[name];
}

function setHead_(t, head) {
  const names = head.map(v => String(v).trim());
  const idx = {};
  COLS[t.name].forEach(c => {
    idx[c[0]] = names.indexOf(c[1]);
    need_(idx[c[0]] >= 0, 'V listu „' + t.name + '“ chybí sloupec „' + c[1] + '“. Spusťte menu eQRAP → Nastavit tabulku.');
  });
  const cols = COLS[t.name].map(c => idx[c[0]]);
  t.idx = idx;
  t.first = Math.min.apply(null, cols);
  t.last = Math.max.apply(null, cols);
}

function head_(t) {
  if (!t.idx) setHead_(t, t.sheet().getRange('1:1').getValues()[0]);
  return t;
}

function lastRow_(t) {
  if (t.lastRow === null) { t.range = t.sheet().getDataRange(); t.lastRow = t.range.getLastRow(); }
  return t.lastRow;
}

const small_ = t => lastRow_(t) * COLS[t.name].length <= PERF.FULL_READ_CELLS;

/** The whole tab in one read. */
function table_(name) {
  const t = memo_(name);
  if (t.all) return t;
  lastRow_(t);
  const range = t.range && t.range.getLastRow() === t.lastRow ? t.range : t.sheet().getDataRange();
  const values = range.getValues();
  if (!t.idx) setHead_(t, values[0]);
  t.all = [];
  for (let i = 1; i < values.length; i++) {
    const o = rowObj_(t, values[i], i + 1);
    if (o) t.all.push(o);
  }
  t.lastRow = Math.max(t.lastRow, values.length);
  return t;
}

/**
 * The rows of one QRAP (in Problémy: the QRAP). Small tab → read whole once. Big tab → its ID column, then only
 * the matching rows (rows close together in one block), so the cost does not grow with the size of the Sheet.
 */
function rowsBy_(name, key) {
  const t = memo_(name);
  const field = KEY_FIELD[name];
  key = String(key);
  if (!t.all && !t.by[key] && small_(t)) table_(name);
  if (t.all) return t.all.filter(r => r[field] === key);
  if (!t.by[key]) {
    head_(t);
    const keys = keyCol_(t);
    const nums = [];
    for (let i = 0; i < keys.length; i++) if (keys[i] === key) nums.push(i + 2);
    t.by[key] = readRows_(t, nums);
  }
  return t.by[key];
}

function keyCol_(t) {
  if (!t.keys) {
    const n = lastRow_(t) - 1;
    t.keys = n > 0 ? t.sheet().getRange(2, t.idx[KEY_FIELD[t.name]] + 1, n, 1).getValues().map(r => String(r[0])) : [];
  }
  return t.keys;
}

function readRows_(t, nums) {
  const out = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] - nums[j] <= PERF.RUN_GAP) j++;
    const start = nums[i];
    const values = t.sheet().getRange(start, 1, nums[j] - start + 1, t.last + 1).getValues();
    for (let k = i; k <= j; k++) {
      const o = rowObj_(t, values[nums[k] - start], nums[k]);
      if (o) out.push(o);
    }
    i = j + 1;
  }
  return out;
}

function rowObj_(t, r, rowNum) {
  if (t.objs[rowNum]) return t.objs[rowNum];
  const cols = COLS[t.name];
  const first = r[t.idx[cols[0][0]]];
  if (first === '' || first === undefined || first === null) return null;
  const o = { _row: rowNum, _raw: r };
  cols.forEach(c => { o[c[0]] = fromCell_(c[0], r[t.idx[c[0]]]); });
  t.objs[rowNum] = o;
  return o;
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

function rowOf_(t, o) {
  const row = [];
  for (let i = 0; i <= t.last; i++) row.push('');
  COLS[t.name].forEach(c => {
    if (o[c[0]] === undefined) o[c[0]] = '';
    row[t.idx[c[0]]] = toCell_(c[0], o[c[0]]);
  });
  return row;
}

function insert_(name, o) { insertMany_(name, [o]); }

/** New rows at the end of a tab: one appendRow for one row, one block write for more. */
function insertMany_(name, list) {
  if (!list.length) return;
  const t = head_(memo_(name));
  const sh = t.sheet();
  const start = lastRow_(t) + 1;
  const rows = list.map(o => rowOf_(t, o));
  if (rows.length === 1) sh.appendRow(rows[0]);
  else {
    const missing = start + rows.length - 1 - sh.getMaxRows();
    if (missing > 0) sh.insertRowsAfter(sh.getMaxRows(), missing);
    sh.getRange(start, 1, rows.length, t.last + 1).setValues(rows);
  }
  list.forEach((o, i) => {
    const n = start + i;
    const key = String(o[KEY_FIELD[name]]);
    o._row = n;
    o._raw = rows[i];
    t.objs[n] = o;
    if (t.all) t.all.push(o);
    if (t.by[key]) t.by[key].push(o);
    else if (name === TAB.qraps) t.by[key] = [o]; // an ID is unique: the new QRAP is its only row
    if (t.keys) t.keys[n - 2] = key;
  });
  t.lastRow = start + rows.length - 1;
  WROTE_ = true;
}

/** Writes only the app's own columns of one row (your own extra columns stay untouched). */
function update_(name, o) {
  const t = head_(memo_(name));
  const row = o._raw.slice(t.first, t.last + 1);
  while (row.length < t.last - t.first + 1) row.push('');
  COLS[name].forEach(c => { row[t.idx[c[0]] - t.first] = toCell_(c[0], o[c[0]]); });
  t.sheet().getRange(o._row, t.first + 1, 1, row.length).setValues([row]);
  WROTE_ = true;
}

function find_(id) {
  const q = rowsBy_(TAB.qraps, id)[0];
  need_(q, 'Problém ' + id + ' nebyl nalezen.');
  return q;
}

function actionsOf_(id) { return rowsBy_(TAB.actions, id).slice().sort((a, b) => a.no - b.no); }
function effectsOf_(id) { return rowsBy_(TAB.effects, id); }
function nextNo_(acts) { return acts.reduce((m, x) => Math.max(m, x.no || 0), 0) + 1; }

/** A new QRAP: remember that it has no rows in the other tabs yet, so nothing is read for it. */
function seedNew_(id) {
  [TAB.actions, TAB.effects, TAB.assess].forEach(name => { const t = memo_(name); if (!t.all) t.by[id] = []; });
}

/** All IDs (for the next number): the whole small tab, or only the ID column of a big one. */
function allIds_() {
  const t = memo_(TAB.qraps);
  if (!t.all && small_(t)) table_(TAB.qraps);
  return t.all ? t.all.map(r => r.id) : keyCol_(head_(t));
}

function nextId_() {
  const prefix = 'Q-' + Utilities.formatDate(new Date(), tz_(), 'yyyy') + '-';
  const max = allIds_().reduce((m, id) => {
    id = String(id || '');
    return id.indexOf(prefix) === 0 ? Math.max(m, parseInt(id.slice(prefix.length), 10) || 0) : m;
  }, 0);
  return prefix + ('00' + (max + 1)).slice(-Math.max(3, String(max + 1).length));
}

/** History line: queued and written with the rest at the end of the save (lock_), or at once outside a save. */
function log_(id, text) {
  LOG_.push({ at: nowIso_(), by: who_() || '(neznámý účet)', qrapId: String(id), text: String(text) });
  if (!IN_LOCK_) flushLog_();
}

function flushLog_() {
  const list = LOG_;
  LOG_ = [];
  if (!list.length) return;
  const t = head_(memo_(TAB.log));
  const sh = t.sheet();
  const rows = list.map(o => rowOf_(t, o));
  if (rows.length === 1) sh.appendRow(rows[0]);
  else { // several lines (only a save writes several, and it holds the lock): one write instead of one per line
    const start = sh.getLastRow() + 1;
    const missing = start + rows.length - 1 - sh.getMaxRows();
    if (missing > 0) sh.insertRowsAfter(sh.getMaxRows(), missing);
    sh.getRange(start, 1, rows.length, t.last + 1).setValues(rows);
  }
  Object.assign(t, { lastRow: null, range: null, all: null, by: {}, keys: null, objs: {} }); // read fresh if needed later
  WROTE_ = true;
}

/** Who did it, for the history: the signed-in account. */
function who_() { return me_().email; }

/**
 * Runs fn while nobody else is saving (no duplicate numbers, no lost updates). Inside the lock everything is read
 * fresh. Before the lock is released the history is written and SpreadsheetApp.flush() commits all writes – without
 * it the next caller could read the Sheet without them. Then the data version changes; e-mails are handled after the
 * lock (parked for the page, see mailAfterSave_). If the lock is not free, nothing has been written – the page may
 * safely try again (it does so once by itself, it recognises the word "zaneprázdněná").
 */
function lock_(fn) {
  const lock = LockService.getScriptLock();
  need_(lock.tryLock(20000), 'Aplikace je právě zaneprázdněná. Zkuste to prosím za chvíli znovu.');
  MEMO_ = {};
  LOG_ = [];
  WROTE_ = false;
  BUMP_ = false;
  IN_LOCK_ = true;
  let ok = false;
  let result;
  try {
    result = fn();
    flushLog_();
    ok = true;
  } finally {
    IN_LOCK_ = false;
    if (!ok) { OUTBOX_ = []; LOG_ = []; } // the save failed → no e-mails, no history line
    try { if (WROTE_) SpreadsheetApp.flush(); } catch (e) { console.error('flush: ' + ((e && e.stack) || e)); }
    try { if (BUMP_ || WROTE_) bumpVersion_(); } catch (e) { console.error('version: ' + e); } // also a half-done save
    lock.releaseLock();
  }
  mailAfterSave_();
  return result;
}

/**
 * Data version: changes whenever QRAP data is saved (or the Sheet is edited by hand). Pages send the version they
 * have; unchanged → no sheet is read. Kept 6 h in the cache; if it expires, a new one only means one normal reload.
 */
function dataVersion_() {
  const cache = CacheService.getScriptCache();
  let v = cache.get('ver');
  if (!v) { v = Utilities.getUuid(); cache.put('ver', v, PERF.CACHE_TTL); }
  return v;
}

function bumpVersion_() { CacheService.getScriptCache().put('ver', Utilities.getUuid(), PERF.CACHE_TTL); }

/** Stores a big value: JSON → gzip → base64, split into entries under the 100 KB CacheService limit. */
function cachePutBig_(key, value) {
  try {
    const zipped = Utilities.gzip(Utilities.newBlob(JSON.stringify(value), 'application/json'));
    const b64 = Utilities.base64Encode(zipped.getBytes());
    const n = Math.ceil(b64.length / PERF.CHUNK);
    if (n > PERF.MAX_CHUNKS) return;
    const entries = {};
    for (let i = 0; i < n; i++) entries[key + ':' + i] = b64.slice(i * PERF.CHUNK, (i + 1) * PERF.CHUNK);
    entries[key] = String(n);
    CacheService.getScriptCache().putAll(entries, PERF.CACHE_TTL);
  } catch (e) {
    console.warn('cache put ' + key + ': ' + e.message);
  }
}

/** Reads a value stored by cachePutBig_ (usually in one cache call); null when any part is missing. */
function cacheGetBig_(key) {
  try {
    const cache = CacheService.getScriptCache();
    const keys = [key, key + ':0', key + ':1', key + ':2', key + ':3'];
    const got = cache.getAll(keys);
    const n = Number(got[key]);
    if (!n) return null;
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(key + ':' + i);
    if (n > 4) Object.assign(got, cache.getAll(parts.slice(4)));
    if (parts.some(k => typeof got[k] !== 'string')) return null;
    const blob = Utilities.newBlob(Utilities.base64Decode(parts.map(k => got[k]).join('')), 'application/x-gzip');
    return JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
  } catch (e) {
    console.warn('cache get ' + key + ': ' + e.message);
    return null;
  }
}

/** A simple per-user limit (e.g. 30 new QRAPs in 10 minutes) against runaway scripts and double sends. */
function rate_(bucket, max, seconds) {
  const cache = CacheService.getScriptCache();
  const key = 'rate:' + bucket + ':' + me_().email;
  const n = Number(cache.get(key)) || 0;
  need_(n < max, 'Příliš mnoho požadavků za krátkou dobu. Zkuste to prosím za pár minut znovu.');
  cache.put(key, String(n + 1), seconds);
}

/**
 * Settings, lists and people – read from the Sheet, remembered for 30 minutes. A change in Správa, a hand edit in the
 * Sheet (onEdit) or the menu "Použít změny v nastavení hned" clears it at once.
 */
function cfg_() {
  if (CFG_) return CFG_;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CFG_KEY);
  if (hit) { CFG_ = JSON.parse(hit); return CFG_; }
  CFG_ = { settings: readSettings_(), lists: readLists_(), people: readPeople_() };
  try { cache.put(CFG_KEY, JSON.stringify(CFG_), 1800); } catch (e) { /* too big for the cache – fine */ }
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
    out[l[0]] = i < 0 ? l[2] : values.slice(1).map(r => noComma_(String(r[i]).trim())).filter(String);
  });
  return out;
}

function readPeople_() {
  const values = sheet_(TAB.people).getDataRange().getValues();
  const mi = mailCol_(values[0]) - 1; // no "E-maily" column (-1): everybody gets e-mails, as before
  return values.slice(1)
    .map((r, i) => ({
      row: i + 2,
      name: String(r[0]).trim(),
      email: String(r[1]).trim().toLowerCase(),
      role: roleOf_(r[2]),
      area: String(r[3]).trim(),
      active: plain_(r[4]) !== 'NE',
      mail: mi < 0 || plain_(r[mi]) !== 'NE' // only an explicit NE switches the e-mails off
    }))
    .filter(p => p.name || p.email);
}

/** The column number (1-based) of "E-maily" in the header row of Lidé, 0 when there is none ("Emaily" works too). */
function mailCol_(head) {
  return (head || []).map(h => plain_(h).replace(/[^A-Z]/g, '')).indexOf('EMAILY') + 1;
}

/** The "E-maily" column of the tab Lidé – created as column F (or the first free column) when it is missing. */
function mailColOf_(sh) {
  const last = Math.max(sh.getLastColumn(), 5);
  const head = sh.getRange(1, 1, 1, last).getValues()[0];
  let c = mailCol_(head);
  if (!c) {
    c = String(head[5] === undefined ? '' : head[5]).trim() ? last + 1 : 6;
    if (sh.getMaxColumns() < c) sh.insertColumnsAfter(sh.getMaxColumns(), c - sh.getMaxColumns());
    sh.getRange(1, c).setValue(PEOPLE_MAIL);
  }
  return c;
}

/** Does this person get the app's e-mails? Active, with an e-mail, and not "E-maily = NE". */
function wantsMail_(p) { return !!(p && p.active && p.email && p.mail !== false); }

/** Role from the column Role: MANAŽER and ADMIN; older words ("Vedoucí", "TL", "správce" …) keep working. */
function roleOf_(v) {
  const r = plain_(v);
  if (['MANAZER', 'MANAGER', 'VEDOUCI', 'LEADER', 'LEAD', 'TL', 'SUPERVIZOR', 'SUPERVISOR', 'MISTR'].indexOf(r) >= 0) return 'MANAŽER';
  if (['ADMIN', 'SPRAVCE'].indexOf(r) >= 0) return 'ADMIN';
  return '';
}

// ---- small value helpers
/** List items must not contain a comma (chosen values are stored comma-separated): a comma becomes " / ". */
function noComma_(v) { return String(v || '').replace(/\s*,\s*/g, ' / ').trim(); }
function plain_(v) { return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
function need_(ok, msg) { if (!ok) throw new UserError(msg); }
function txt_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 2000); }
function short_(s) { s = String(s || ''); return s.length > 70 ? s.slice(0, 67) + '…' : s; }
function list_(s) { return String(s || '').split(',').map(x => x.trim()).filter(String); }
function multi_(v) { return (Array.isArray(v) ? v : list_(v)).slice(0, LIMIT.ITEMS).map(x => txt_(x, 100)).filter(String).join(', '); }
function onlyFrom_(v, allowed) { return list_(multi_(v)).filter(x => allowed.indexOf(x) >= 0).join(', '); }
function isOther_(v) { return plain_(v) === 'JINE'; }
function yn_(v) { v = plain_(v); return v === 'ANO' || v === 'NE' ? v : ''; }
function nowIso_() { return new Date().toISOString(); }
function tz_() { return Session.getScriptTimeZone() || 'Europe/Prague'; }
function fmt_(iso) { return iso ? Utilities.formatDate(new Date(iso), tz_(), 'd.M.yyyy HH:mm') : ''; }
/** Anything that is not a plain object becomes {} – the browser can send any JSON value. */
function obj_(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
/** A list of rows from the form, at most LIMIT.ROWS of them. */
function rowsIn_(v) {
  const a = Array.isArray(v) ? v : [];
  need_(a.length <= LIMIT.ROWS, 'Příliš mnoho řádků (max ' + LIMIT.ROWS + ').');
  return a.map(obj_);
}
function idOf_(v) {
  const id = txt_(v, 41);
  need_(id && id.length <= 40, 'Neplatné číslo QRAP.');
  return id;
}

function oneOf_(v, allowed, msg) {
  v = txt_(v, 50);
  need_(allowed.indexOf(v) >= 0, msg);
  return v;
}

/** A value from a list in the Sheet – or the value the QRAP already has (old QRAPs keep values a list dropped). */
function pick_(v, allowed, current, label) {
  v = txt_(v, 100);
  need_(!v || v === current || allowed.indexOf(v) >= 0, label + ': hodnota „' + v + '“ není v seznamu.');
  return v;
}

function pickMany_(v, allowed, current, label) {
  const cur = list_(current);
  const out = list_(multi_(v));
  out.forEach(x => need_(allowed.indexOf(x) >= 0 || cur.indexOf(x) >= 0, label + ': hodnota „' + x + '“ není v seznamu.'));
  return out.join(', ');
}

function num_(v, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  need_(isFinite(n) && n >= 0 && n <= 1e7 && Math.round(n) === n, (label || 'Počet') + ' musí být celé číslo od 0 do 10 000 000.');
  return n;
}

function iso_(v) {
  if (!v) return '';
  const d = new Date(v);
  need_(!isNaN(d.getTime()), 'Neplatné datum nebo čas.');
  return d.toISOString();
}

function day_(v) {
  v = txt_(v, 10);
  need_(/^\d{4}-\d{2}-\d{2}$/.test(v), 'Vyplňte platné datum.');
  return v;
}

/** A day "2026-10-05" stored as a time at noon, so it shows the same day in every time zone. */
function dayIso_(v) { const p = day_(v).split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12).toISOString(); }

function url_(v) {
  v = txt_(v, 500);
  need_(!v || /^https?:\/\/\S+$/i.test(v), 'Odkaz na důkaz musí začínat http:// nebo https://');
  return v;
}

function notFuture_(iso, label) {
  need_(!iso || new Date(iso).getTime() <= Date.now() + 5 * 60000, label + ' nemůže být v budoucnosti.');
}

function domainOf_(email) { const i = String(email).lastIndexOf('@'); return i > 0 ? String(email).slice(i + 1).toLowerCase() : ''; }

/** Same company domain as the account the app runs as (never a public mail domain). */
function sameDomain_(email) {
  const d = domainOf_(runAsEmail_());
  return !!d && ['gmail.com', 'googlemail.com'].indexOf(d) < 0 && domainOf_(email) === d;
}

/** Names or e-mails from the form → e-mails of active people in the tab Lidé. */
function emailsOf_(v) {
  const people = cfg_().people.filter(p => p.active && p.email);
  return list_(multi_(v)).map(x => {
    const k = x.toLowerCase();
    const p = people.filter(y => y.email === k || y.name.toLowerCase() === k)[0];
    need_(p, 'Osoba „' + x + '“ není na listu Lidé.');
    return p.email;
  }).filter((e, i, a) => a.indexOf(e) === i);
}

/**
 * ① ② from the form, checked like the paper form and against the lists in the Sheet.
 * cur = the QRAP as it is now ({} for a new one). Old QRAPs keep their KDE – lokace, Kde vzniklo, NOK situace,
 * photo exception and extra e-mails (no longer asked).
 */
function popisFrom_(f, cur) {
  const L = cfg_().lists;
  const q = {
    safety: yn_(f.safety),
    how: pick_(f.how, L.how, cur.how, 'JAK byl objeven?'), howOther: txt_(f.howOther, 200),
    what: pick_(f.what, L.problems, cur.what, 'CO je za problém?'), whatOther: txt_(f.whatOther, 200),
    when: iso_(f.when), zone: pick_(f.zone, L.zones, cur.zone, 'KDE?'),
    nokSituation: f.qtyNA === 'ANO' || f.qtyNA === true ? 'ANO' : '',
    qty: num_(f.qty, 'KOLIK špatných dílů'), unit: pick_(f.unit, L.units, cur.unit, 'Jednotka'),
    repeat7: yn_(f.repeat7), repeatRef: txt_(f.repeatRef, 40).toUpperCase(), finder: txt_(f.finder, 100),
    descWrong: txt_(f.descWrong, 1000), descRight: txt_(f.descRight, 1000),
    reference: txt_(f.reference, 200),
    notified: pickMany_(f.notified, L.alert, cur.notified, '② Kdo byl upozorněn?'), notifiedOther: txt_(f.notifiedOther, 200)
  };
  if (q.nokSituation) { q.qty = ''; q.unit = ''; } // KOLIK = N/A
  if (!isOther_(q.how)) q.howOther = '';
  if (!isOther_(q.what)) q.whatOther = '';
  if (q.repeat7 !== 'ANO') q.repeatRef = '';
  if (!list_(q.notified).some(isOther_)) q.notifiedOther = '';
  const miss = [];
  if (!q.safety) miss.push('SAFETY');
  if (!q.what) miss.push('CO je za problém?'); else if (isOther_(q.what) && !q.whatOther) miss.push('CO – jiné');
  if (!q.how) miss.push('JAK byl objeven?'); else if (isOther_(q.how) && !q.howOther) miss.push('JAK – jiné');
  if (!q.when) miss.push('KDY?');
  if (!q.zone) miss.push('KDE?');
  if (q.qty === '' && !q.nokSituation) miss.push('KOLIK špatných dílů? (nebo N/A)');
  if (!q.repeat7) miss.push('Stejný problém v posledních 7 dnech?');
  if (!q.finder) miss.push('JMÉNO (kdo vyplňuje formulář)');
  if (!q.descWrong) miss.push('Popis – ŠPATNÝ díl');
  if (!q.descRight) miss.push('Popis – DOBRÝ díl');
  if (!q.notified) miss.push('② Kdo byl upozorněn?');
  else if (list_(q.notified).some(isOther_) && !q.notifiedOther) miss.push('② Jiné – kdo');
  need_(!miss.length, 'Vyplňte prosím: ' + miss.join(', ') + '.');
  notFuture_(q.when, 'KDY');
  need_(!(q.qty > 0) || q.unit, 'Vyberte jednotku (KOLIK špatných dílů).');
  need_(q.repeat7 !== 'ANO' || q.repeatRef, 'Vyberte N° opakovaného QRAP.');
  return q;
}

/** CO je za problém (the "jiné" text when chosen). */
function what_(q) { return isOther_(q.what) && q.whatOther ? q.whatOther : q.what; }

/** A short title for lists, e-mails and the history: CO + the description of the wrong part. */
function title_(q) { return what_(q) + (q.descWrong ? ' – ' + q.descWrong : ''); }

/** "Stejný problém v posledních 7 dnech? = ANO" → the QRAP must exist and be from the 7 days before KDY. */
function checkRepeat_(q) {
  if (q.repeat7 !== 'ANO') return;
  const r = q.repeatRef && q.repeatRef !== q.id ? rowsBy_(TAB.qraps, q.repeatRef)[0] : null;
  const det = new Date(q.when).getTime();
  const ref = r ? new Date(r.when).getTime() : 0;
  need_(r && ref <= det + 60000 && ref >= det - 7 * 864e5, 'Opakovaný QRAP ' + q.repeatRef + ' neexistuje nebo není z posledních 7 dnů před KDY.');
}

/** ③ answers from the form (the actions are checked by iaFields_). Only the risk answer is required. */
function opatreniFrom_(f, when) {
  const s = {
    risk: yn_(f.risk), checked: num_(f.checked, 'Přetříděno'), wrong: num_(f.wrong, 'Špatné kusy'),
    checkRunning: '', restoredAt: iso_(f.restoredAt)
  };
  need_(s.risk, 'Odpovězte: Je zde riziko na již naskladněném nebo expedovaném zboží?');
  if (s.risk !== 'ANO') Object.assign(s, { checked: '', wrong: '' });
  need_(s.wrong === '' || s.checked === '' || s.wrong <= s.checked, '„Špatné kusy“ nemůže být víc než „Přetříděno“.');
  notFuture_(s.restoredAt, 'Čas re-startu');
  need_(!s.restoredAt || s.restoredAt >= when, 'Čas re-startu nemůže být před KDY.');
  return s;
}

/** One ③ immediate action as on the paper: Okamžitá opatření (what), Kdo, Čas (empty = still running). */
function iaFields_(r, when) {
  const a = { kind: txt_(r.kind, 100), text: txt_(r.text, 500), owner: txt_(r.owner, 100), done: iso_(r.done) };
  need_(a.text && a.owner, 'U každého okamžitého opatření vyplňte, co bylo uděláno, a Kdo.');
  notFuture_(a.done, 'Čas opatření');
  need_(!a.done || a.done >= when, 'Čas opatření nemůže být před KDY.');
  return a;
}

/** Saves the ③ action rows: new ones are added, changed ones updated, removed ones marked (never deleted). */
function syncIa_(id, rows) {
  const existing = actionsOf_(id).filter(a => a.part === '③');
  const added = [];
  let no = nextNo_(actionsOf_(id));
  rows.forEach(r => {
    const cur = r.no ? existing.filter(a => a.no === Number(r.no))[0] : null;
    if (cur) {
      if (r.remove) cur.removed = 'ANO'; else Object.assign(cur, { kind: r.kind, text: r.text, owner: r.owner, done: r.done });
      update_(TAB.actions, cur);
    } else if (!r.remove) {
      added.push({ qrapId: id, no: no++, part: '③', kind: r.kind, text: r.text, owner: r.owner, done: r.done, created: nowIso_() });
    }
  });
  insertMany_(TAB.actions, added);
}

/** ⑤ both 5 Proč chains, root causes, lesson and standard. */
function pricinaFrom_(f) {
  const s = {};
  [['o', 'Proč to vzniklo?'], ['n', 'Proč to nebylo zachyceno?']].forEach(c => {
    const texts = [1, 2, 3, 4, 5].map(i => txt_(f[c[0] + i], 1000));
    const last = texts.reduce((m, t, i) => (t ? i + 1 : m), 0);
    for (let i = 0; i < last; i++) need_(texts[i], '„' + c[1] + '“: krok ' + (i + 1) + ' je prázdný – kroky musí jít po sobě.');
    const root = Number(f['root' + c[0].toUpperCase()]) || '';
    need_(!root || (root >= 1 && root <= 5 && texts[root - 1]), '„' + c[1] + '“: kořenová příčina musí být vyplněný krok.');
    texts.forEach((t, i) => { s[c[0] + (i + 1)] = t; });
    s['root' + c[0].toUpperCase()] = root;
  });
  s.learned = txt_(f.learned);
  s.std = yn_(f.std);
  s.stdRef = s.std === 'ANO' ? txt_(f.stdRef, 300) : '';
  need_(s.std !== 'ANO' || s.stdRef, 'Napište, který standard se aktualizuje.');
  return s;
}

/** "Příležitost k aktualizaci STANDARDU? = ANO" creates the action "Aktualizovat standard" (NE removes it while open). */
function syncStdAction_(q) {
  const acts = actionsOf_(q.id);
  const std = defActions_(acts).filter(a => a.kind === 'STD')[0];
  if (q.std === 'ANO') {
    const text = 'Aktualizovat standard: ' + q.stdRef;
    if (!std) {
      const pilot = list_(q.pilots)[0] || me_().email;
      const p = cfg_().people.filter(x => x.email === pilot)[0];
      const due = Utilities.formatDate(new Date(Date.now() + 14 * 864e5), tz_(), 'yyyy-MM-dd');
      insert_(TAB.actions, { qrapId: q.id, no: nextNo_(acts), part: '⑥', kind: 'STD', text: text, owner: p ? p.name : pilot,
        ownerEmail: pilot, due: due, dueFirst: due, created: nowIso_() });
    } else if (!std.done && std.text !== text) {
      std.text = text;
      update_(TAB.actions, std);
    }
  } else if (std && !std.done) {
    std.removed = 'ANO';
    update_(TAB.actions, std);
  }
}

/** ⑥ definitive action fields. "kind" = the 5 Proč step it removes (O1…O5, N1…N5) or STD. */
function defActionFields_(a, q) {
  const f = { text: txt_(a.text, 500), kind: txt_(a.kind, 5).toUpperCase(), owner: txt_(a.owner, 100), due: a.due ? day_(a.due) : '' };
  need_(f.text && f.kind && f.owner && f.due, 'Vyplňte konečnou akci, krok 5 Proč, pilota a plán.');
  const m = /^([ON])([1-5])$/.exec(f.kind);
  need_(f.kind === 'STD' || (m && q[m[1].toLowerCase() + m[2]]), 'Akce musí odstraňovat vyplněný krok 5 Proč.');
  const key = f.owner.toLowerCase();
  const p = cfg_().people.filter(x => x.active && (x.name.toLowerCase() === key || x.email === key))[0];
  // E-mail only to a colleague: never to an address typed into the form (that would make the app a mail relay).
  f.ownerEmail = p ? p.email : (EMAIL_RE.test(key) && sameDomain_(key) ? key : '');
  if (p) f.owner = p.name;
  return f;
}

/** When the risk is ANO, "Kvalita" is added to ② automatically (as on the paper form). */
function addQuality_(q) {
  if (q.risk !== 'ANO') return;
  const k = cfg_().lists.alert.filter(x => /kvalit/i.test(x))[0];
  if (k && list_(q.notified).indexOf(k) < 0) q.notified = list_(q.notified).concat(k).join(', ');
}

// ---- photos: a cell holds "fullId" or "fullId|thumbId" (older QRAPs: only fullId)

function photoIds_(v) { return String(v || '').split('|').map(x => x.trim()).filter(String); }

/** Saves a photo and its small preview; returns the cell value. Created file IDs are added to files (for cleanup). */
function savePhotoPair_(full, thumb, files) {
  if (!full) return '';
  const id = savePhoto_(full);
  files.push(id);
  let tid = '';
  if (thumb) {
    try { tid = savePhoto_(thumb); files.push(tid); } catch (e) { console.warn('preview not saved: ' + e.message); }
  }
  return tid ? id + '|' + tid : id;
}

/** Stores one photo in the photo folder. The data must really be an image of the type it claims (first bytes). */
function savePhoto_(dataUrl) {
  const s = String(dataUrl || '');
  need_(s.length <= LIMIT.PHOTO_CHARS, 'Fotka je příliš velká (max 5 MB).');
  const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+=*)$/.exec(s);
  need_(m, 'Fotka musí být obrázek (JPG nebo PNG).');
  const bytes = Utilities.base64Decode(m[2]);
  need_(bytes.length <= LIMIT.PHOTO_BYTES, 'Fotka je příliš velká (max 5 MB).');
  need_(imageType_(bytes) === m[1], 'Soubor není obrázek nebo neodpovídá svému typu.');
  return folder_().createFile(Utilities.newBlob(bytes, 'image/' + m[1], 'eqrap_' + Date.now() + '.' + m[1])).getId();
}

/** Image type from the file's first bytes. */
function imageType_(b) {
  const u = i => (b[i] === undefined ? -1 : b[i] & 255);
  if (u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF) return 'jpeg';
  if (u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return 'png';
  if (u(0) === 0x47 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x38) return 'gif';
  if (u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 && u(8) === 0x57 && u(9) === 0x45 && u(10) === 0x42 && u(11) === 0x50) return 'webp';
  return '';
}

function folder_() {
  if (!FOLDER_) {
    const id = photoFolderId_();
    need_(id, 'Složka pro fotky není nastavená – spusťte menu eQRAP → Nastavit tabulku.');
    FOLDER_ = DriveApp.getFolderById(id);
  }
  return FOLDER_;
}

/** Photo folder ID from Script Properties (older installs had it in Nastavení – it is moved over once). */
function photoFolderId_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(FOLDER_PROP) || '';
  if (!id) {
    id = String(cfg_().settings[FOLDER_PROP] || '').trim();
    if (id) props.setProperty(FOLDER_PROP, id);
  }
  return id;
}

/**
 * One checked photo file as a data URL (only an image of an allowed type). Callers check first that the file belongs
 * to a QRAP or to the caller's own hand-off. Small ones (the previews) are cached 1 h: a Drive file never changes
 * (a new photo is a new file), so the cache can never show an outdated picture; 1 h keeps the cache free for the list.
 */
function dataUrl_(fileId) {
  const blob = DriveApp.getFileById(fileId).getBlob();
  const type = String(blob.getContentType());
  need_(/^image\/(jpeg|png|webp|gif)$/.test(type), 'Soubor není obrázek.');
  const url = 'data:' + type + ';base64,' + Utilities.base64Encode(blob.getBytes());
  if (url.length < 95000) {
    try { CacheService.getScriptCache().put('img:' + fileId, url, 3600); } catch (e) { /* cache full – fine */ }
  }
  return url;
}

/** Moves files to the Drive trash (recoverable for 30 days) – used when a save with new photos fails. */
function trash_(ids) {
  ids.forEach(id => {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { console.warn('trash ' + id + ': ' + e.message); }
  });
}

// =====================================================================================
// 7. E-MAILS AND DAILY REMINDER
// =====================================================================================

/** Managers of a zone (Oblast empty = all zones). If there are none, all managers. */
function zoneManagers_(zone) {
  // only people who want e-mails: when every manager of the zone said NE, the other managers are told instead
  const m = cfg_().people.filter(p => wantsMail_(p) && p.role === 'MANAŽER' && (!p.area || p.area === zone)).map(p => p.email);
  return m.length ? m : managers_();
}

/** All managers who get e-mails – or, when there are none, all admins who do. */
function managers_() {
  const people = cfg_().people.filter(wantsMail_);
  const m = people.filter(p => p.role === 'MANAŽER').map(p => p.email);
  return m.length ? m : people.filter(p => p.role === 'ADMIN').map(p => p.email);
}

function facts_(q) {
  return ['CO: ' + what_(q) + ' (JAK: ' + (isOther_(q.how) && q.howOther ? q.howOther : q.how) + ')',
    'ŠPATNÝ díl: ' + (q.descWrong || '–'), 'DOBRÝ díl: ' + (q.descRight || '–'),
    'KDE: ' + [q.zone, q.location].filter(Boolean).join(' / '), 'KDY: ' + fmt_(q.when),
    'KOLIK: ' + (q.nokSituation ? 'N/A' : q.qty === '' || q.qty === undefined ? '–' : q.qty + ' ' + (q.unit || '')),
    'JMÉNO: ' + q.finder].concat(q.reference ? ['Reference: ' + q.reference] : []);
}

function mailNew_(q) {
  send_(zoneManagers_(q.zone), q.id + ' – nový problém (' + q.zone + ')', ['Byl nahlášen nový QRAP.', ''].concat(facts_(q), ['',
    q.s3Done ? 'Okamžitá opatření ③ jsou kompletní. Další krok: ④ rozhodnutí.'
      : 'Další krok: ③ okamžitá opatření do ' + setting_('LHUTA_OPATRENI_HODIN') + ' h, potom ④ rozhodnutí.']), q.id);
  if (q.safety === 'ANO') mailSafety_(q);
  if (q.risk === 'ANO') mailQuality_(q);
}

function mailSafety_(q) {
  send_([setting_('EMAIL_BOZP')].concat(managers_()), 'SAFETY! ' + q.id + ' – bezpečnostní problém (' + q.zone + ')',
    ['Byl nahlášen problém se SAFETY = ANO.', ''].concat(facts_(q)), q.id);
}

function mailQuality_(q) {
  send_([setting_('EMAIL_KVALITA')], q.id + ' – riziko u zboží na skladě / expedovaného',
    ['U problému je riziko, že stejná chyba je i u zboží na skladě nebo už expedovaného.', ''].concat(facts_(q),
      ['Přetříděno: ' + (q.checked === '' ? '–' : q.checked) + ' ks · Špatné kusy: ' + (q.wrong === '' ? '–' : q.wrong) + ' ks']), q.id);
}

function mailPilots_(q, emails) {
  send_(emails, q.id + ' – jste pilot analýzy 5 Proč', [me_().name + ' vás určil(a) jako pilota.', ''].concat(facts_(q),
    ['', 'Vyplňte ⑤ PŘÍČINA 5 Proč? a ⑥ konečné akce.']), q.id);
}

function mailEscalated_(q) {
  send_(managers_(), q.id + ' – eskalace (' + q.zone + ')', [me_().name + ' eskaloval(a) problém na vyšší úroveň.', '']
    .concat(facts_(q), ['Komentář: ' + (q.decisionNote || '–')]), q.id);
}

function mailAction_(q, a) {
  if (!a.ownerEmail) return;
  send_([a.ownerEmail], q.id + ' – máte konečnou akci (plán ' + a.due + ')', [
    'Byla vám přidělena konečná akce k problému ' + q.id + '.', '',
    'Akce: ' + a.text, 'Plán: ' + a.due, 'Problém: ' + title_(q), '',
    'Až bude hotovo, otevřete odkaz a klikněte na „✓ Hotovo“.'
  ], q.id);
}

function mailNotEffective_(q) {
  send_(list_(q.pilots).concat(zoneManagers_(q.zone)), q.id + ' – efektivita nepotvrzena', [
    'Chyba se znovu objevila. QRAP se vrátil do analýzy 5 Proč a počítání 5 směn začne znovu.', ''].concat(facts_(q)), q.id);
}

/**
 * Queues one e-mail. Recipients are only colleagues (people in Lidé, the Kvalita / BOZP addresses, the company's own
 * domain), so nothing typed into a form can make the app send mail outside. lock_() sends the queue after the save.
 */
function send_(to, subject, lines, id) {
  if (NO_MAIL_ || plain_(setting_('EMAILY')) !== 'ANO') return;
  const list = to.map(x => String(x || '').trim().toLowerCase())
    .filter((x, i, a) => EMAIL_RE.test(x) && a.indexOf(x) === i && mailAllowed_(x));
  if (!list.length) return;
  const name = String(setting_('NAZEV') || 'eQRAP');
  OUTBOX_.push({
    to: list.join(','),
    subject: ('[' + name + '] ' + subject).replace(/[\r\n]+/g, ' ').slice(0, 250),
    body: lines.concat(['', 'Otevřít: ' + link_(id)]).join('\n'),
    name: name.replace(/[\r\n"<>]+/g, ' ').slice(0, 80)
  });
}

/**
 * Allowed recipients (one check per request): people in Lidé who get e-mails, the Kvalita / BOZP addresses, the company
 * domain. Never anybody in Lidé with "E-maily = NE" or "Aktivní = NE" – whatever sends the e-mail (pilot, action owner,
 * manager, daily reminder). The Kvalita / BOZP addresses always get theirs: they are set on purpose in Nastavení.
 */
function mailAllowed_(email) {
  if (!MAILOK_) {
    const c = cfg_();
    const fixed = [c.settings.EMAIL_KVALITA, c.settings.EMAIL_BOZP].map(x => String(x || '').trim().toLowerCase()).filter(String);
    MAILOK_ = {
      ok: new Set(c.people.filter(wantsMail_).map(p => p.email).concat(fixed)),
      off: new Set(c.people.filter(p => p.email && !wantsMail_(p) && fixed.indexOf(p.email) < 0).map(p => p.email))
    };
  }
  if (MAILOK_.off.has(email)) return false;
  return MAILOK_.ok.has(email) || sameDomain_(email);
}

/** Sends the queued e-mails now (daily reminder, menu functions). */
function sendMail_() {
  const box = OUTBOX_;
  OUTBOX_ = [];
  deliver_(box);
}

/**
 * After a save. A call from the page parks its e-mails in Script Properties (durable, unlike the cache) and the page
 * sends them with apiMail as soon as it has shown the result – nobody waits for MailApp. Anything else sends at once.
 * If parking fails (e.g. an unusually long e-mail), the e-mails are sent at once – they are never lost.
 */
function mailAfterSave_() {
  if (!DEFER_MAIL_) { sendMail_(); return; }
  const box = OUTBOX_;
  OUTBOX_ = [];
  if (!box.length) return;
  const parked = {};
  const now = Date.now();
  box.forEach((m, i) => { parked[MAIL.PREFIX + now + ':' + i + Utilities.getUuid().slice(0, 8)] = JSON.stringify(m); });
  const props = PropertiesService.getScriptProperties();
  try {
    props.setProperties(parked);
    MAIL_KEYS_ = MAIL_KEYS_.concat(Object.keys(parked));
    const cache = CacheService.getScriptCache();
    if (!cache.get('mailq')) cache.put('mailq', String(now), PERF.CACHE_TTL); // "something is waiting since …"
  } catch (e) {
    console.warn('mail park: ' + e.message);
    Object.keys(parked).forEach(k => { try { props.deleteProperty(k); } catch (x) { /* was not written */ } });
    deliver_(box);
  }
}

/** apiMail: the page sends the e-mails of its last save. Only parked e-mails can be sent this way – nothing else. */
function mailOut_(keys) {
  me_();
  rate_('mail', 60, 600);
  sendParked_((Array.isArray(keys) ? keys : []).map(String).filter(k => k.indexOf(MAIL.PREFIX) === 0).slice(0, 20));
  return { ok: true };
}

/** Takes parked e-mails out of Script Properties and sends them; an e-mail already taken is skipped. */
function sendParked_(keys) {
  if (!keys.length) return;
  const props = PropertiesService.getScriptProperties();
  const box = [];
  keys.forEach(k => {
    const v = props.getProperty(k);
    if (!v) return; // already sent
    props.deleteProperty(k);
    try { box.push(JSON.parse(v)); } catch (e) { console.warn('mail ' + k + ': ' + e.message); }
  });
  deliver_(box);
}

/**
 * E-mails a page never asked for (closed right after saving) go out with the next refresh once they are MAIL.LATE
 * old – or all of them (all = true, daily reminder). Costs one cache read when nothing waits. Sweeps take turns
 * through the lock, so two of them never send the same e-mail; a save in progress just means "next time".
 */
function sweepMail_(all) {
  const cache = CacheService.getScriptCache();
  const since = Number(cache.get('mailq')) || 0;
  if (!all && (!since || Date.now() - since < MAIL.LATE)) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(all ? 20000 : 1)) return;
  const box = [];
  try {
    const props = PropertiesService.getScriptProperties();
    const stored = props.getProperties();
    const now = Date.now();
    const age = k => now - (Number(k.split(':')[1]) || 0);
    const keys = Object.keys(stored).filter(k => k.indexOf(MAIL.PREFIX) === 0);
    const rest = [];
    keys.forEach(k => {
      if (!all && age(k) < MAIL.LATE) { rest.push(k); return; }
      props.deleteProperty(k);
      try { box.push(JSON.parse(stored[k])); } catch (e) { console.warn('mail ' + k + ': ' + e.message); }
    });
    if (rest.length) cache.put('mailq', String(now - Math.max.apply(null, rest.map(age))), PERF.CACHE_TTL);
    else cache.remove('mailq');
  } finally {
    lock.releaseLock();
  }
  deliver_(box);
}

/** Sends e-mails within the daily MailApp quota. A failed e-mail never undoes a save. */
function deliver_(box) {
  if (!box.length) return;
  let left = Infinity;
  try { left = MailApp.getRemainingDailyQuota(); } catch (e) { /* unknown – try to send */ }
  box.forEach(m => {
    const n = m.to.split(',').length;
    if (n > left) { console.warn('Denní kvóta e-mailů je vyčerpaná – neodesláno: ' + m.subject); return; }
    try { MailApp.sendEmail(m); left -= n; } catch (e) { console.warn('E-mail se nepodařilo odeslat: ' + e.message); }
  });
}

function link_(id) {
  let url = String(setting_('ODKAZ_APLIKACE') || '');
  if (!url) { try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; } }
  return url + (id ? '?id=' + encodeURIComponent(id) : '');
}

/** The app's address for the page itself ("Obnovit stránku"); never throws – also used when the start failed. */
function appUrl_() {
  try { return link_(''); } catch (e) { /* settings not readable */ }
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/** Every morning (if switched on in the menu): managers and admins get the open problems of their zone. */
function dailyReminder(e) {
  const fromTrigger = !!(e && e.triggerUid) && ScriptApp.getProjectTriggers().some(t => t.getUniqueId() === String(e.triggerUid));
  if (!fromTrigger) menuOnly_();
  sweepMail_(true); // e-mails of pages that were closed before they sent them
  const actRows = table_(TAB.actions).all;
  const acts = groupBy_(actRows);
  const effs = groupBy_(table_(TAB.effects).all);
  const open = table_(TAB.qraps).all.filter(q => {
    q.status = statusOf_(q, acts.get(q.id) || [], effs.get(q.id) || []);
    return isOpen_(q);
  });
  const openIds = new Set(open.map(q => q.id));
  const today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  const MAX = 100;
  cfg_().people.filter(p => wantsMail_(p) && p.role).forEach(p => {
    const mine = open.filter(q => !p.area || p.area === q.zone);
    if (!mine.length) return;
    send_([p.email], 'otevřené problémy: ' + mine.length, ['Dobré ráno, tyto QRAP jsou otevřené:', '']
      .concat(mine.slice(0, MAX).map(q => q.id + '  čeká: ' + NEXT_STEP[q.status] + '  –  ' + short_(title_(q))),
        mine.length > MAX ? ['… a dalších ' + (mine.length - MAX)] : []), '');
  });
  const late = new Map(); // owner e-mail → their late actions
  actRows.forEach(a => {
    if (a.part !== '⑥' || a.done || a.removed || !a.ownerEmail || !a.due || a.due > today || !openIds.has(a.qrapId)) return;
    const g = late.get(a.ownerEmail);
    if (g) g.push(a); else late.set(a.ownerEmail, [a]);
  });
  late.forEach((mine, email) => {
    send_([email], 'konečné akce po termínu: ' + mine.length, ['Tyto vaše akce mají plán dnes nebo už prošel:', '']
      .concat(mine.map(a => a.qrapId + '  ' + a.due + '  –  ' + short_(a.text))), '');
  });
  sendMail_();
}

// =====================================================================================
// 8. SETUP, ADMIN MENU, EXAMPLE DATA
// =====================================================================================

/**
 * Maintenance functions (setup, example data, reminders) run only from the Sheet menu or the script editor – never
 * from the web page. From the menu the script runs as the person who clicks; through the web app it runs as the
 * deployer, so "signed-in user = run-as user" is false for every visitor except the deployer.
 */
function menuOnly_() {
  let active = '';
  try { active = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { active = ''; }
  need_(active && active === runAsEmail_(), 'Tuto funkci spusťte z menu eQRAP v tabulce.');
}

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

/** Hand edits in the Sheet: settings apply at once, open pages reload at their next refresh. */
function onEdit(e) {
  // A real edit event carries Range objects; a call from a browser (google.script.run) can only send plain JSON.
  if (!e || !e.range || typeof e.range.getSheet !== 'function') return;
  if ([TAB.people, TAB.lists, TAB.settings].indexOf(e.range.getSheet().getName()) >= 0) clearCache_();
  bumpVersion_();
}

/** Menu: apply changes made by hand in Lidé / Seznamy / Nastavení right away. */
function clearCache() {
  menuOnly_();
  clearCache_();
  bumpVersion_();
  toast_('Změny v nastavení platí.');
}

function clearCache_() {
  CacheService.getScriptCache().removeAll(['cfg', CFG_KEY]);
  CFG_ = null;
  ME_ = null;
  MAILOK_ = null;
}

/** Creates (or repairs) all tabs. Safe to run again – it never deletes data. */
function setup() {
  menuOnly_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(tz_());

  [TAB.qraps, TAB.actions, TAB.effects, TAB.assess, TAB.log].forEach(name => {
    const sh = makeTab_(ss, name, COLS[name].map(c => c[1]));
    if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
      sh.protect().setDescription('Data aplikace eQRAP – měňte přes aplikaci').setWarningOnly(true); // only a warning, not a lock
    }
  });

  let people = ss.getSheetByName(TAB.people);
  if (!people) {
    people = makeTab_(ss, TAB.people, ['Jméno', 'E-mail', 'Role', 'Oblast', 'Aktivní', PEOPLE_MAIL]);
    const rows = [['Správce aplikace', Session.getEffectiveUser().getEmail(), 'ADMIN', '', 'ANO']].concat(EXAMPLE_PEOPLE);
    people.getRange(2, 1, rows.length, 5).setValues(rows);
    people.getRange(2, 5, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['ANO', 'NE'], true).build());
  }
  // E-maily: ANO / NE per person (an older Sheet gets the column now; empty = ANO, nobody loses e-mails)
  people.getRange(2, mailColOf_(people), 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['ANO', 'NE'], true)
    .setHelpText('ANO nebo prázdné = dostává e-maily z aplikace. NE = nedostane žádný (lze nastavit i v aplikaci: Správa → Lidé).').build());
  // The Role dropdown always offers the current roles (older values still work, see roleOf_).
  people.getRange(2, 3, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(ROLES, true).setAllowInvalid(false)
    .setHelpText('Prázdné = uživatel (může vše v QRAP). MANAŽER = navíc Přehled manažera a e-maily ze své zóny. ADMIN = navíc Správa.').build());

  // Seznamy: a missing list gets its own column with the default values (existing columns stay as they are).
  const lists = ss.getSheetByName(TAB.lists) || ss.insertSheet(TAB.lists);
  const head = lists.getLastRow() ? lists.getRange(1, 1, 1, Math.max(lists.getLastColumn(), 1)).getValues()[0].map(v => String(v).trim()) : [];
  let col = head.filter(String).length ? lists.getLastColumn() + 1 : 1;
  LISTS.filter(l => head.indexOf(l[1]) < 0).forEach(l => {
    if (lists.getMaxColumns() < col) lists.insertColumnsAfter(lists.getMaxColumns(), col - lists.getMaxColumns());
    lists.getRange(1, col, l[2].length + 1, 1).setValues([[l[1]]].concat(l[2].map(v => [v])));
    col++;
  });
  lists.getRange(1, 1, 1, Math.max(lists.getLastColumn(), 1)).setFontWeight('bold').setBackground('#eef1f5');
  lists.setFrozenRows(1);

  const st = makeTab_(ss, TAB.settings, ['Klíč', 'Hodnota', 'Popis']);
  const have = st.getDataRange().getValues().map(r => String(r[0]).trim());
  const add = SETTINGS.filter(s => have.indexOf(s[0]) < 0);
  if (add.length) st.getRange(st.getLastRow() + 1, 1, add.length, 3).setValues(add);

  clearCache_();
  const warn = setupPhotoFolder_(ss, st);
  clearCache_();

  if (!ss.getSheetByName(HANDOVER_TAB)) {
    const sh = ss.insertSheet(HANDOVER_TAB);
    sh.getRange(1, 1, HANDOVER.length, 1).setValues(HANDOVER);
    sh.getRange(1, 1).setFontWeight('bold');
    sh.setColumnWidth(1, 900);
  }
  SpreadsheetApp.flush();
  bumpVersion_();
  toast_(warn || 'Tabulka je připravená. Pokračujte nasazením: Nasadit → Nová implementace → Webová aplikace.');
  return 'Hotovo';
}

/**
 * The photo folder ID lives in Script Properties (not in the Sheet, not on the page): moved there from Nastavení
 * (older installs), checked, or created next to this Sheet. Returns a warning text, or '' when all is fine.
 */
function setupPhotoFolder_(ss, st) {
  const props = PropertiesService.getScriptProperties();
  const rows = st.getDataRange().getValues();
  const i = rows.findIndex(r => String(r[0]).trim() === FOLDER_PROP);
  if (i > 0) {
    const old = String(rows[i][1] || '').trim();
    if (old && !props.getProperty(FOLDER_PROP)) props.setProperty(FOLDER_PROP, old);
    st.deleteRow(i + 1);
  }
  const id = props.getProperty(FOLDER_PROP);
  if (id) {
    try { DriveApp.getFolderById(id).getName(); return ''; } catch (e) {
      return 'Složka na fotky (' + id + ') není dostupná. Opravte přístup, nebo smažte vlastnost skriptu ' + FOLDER_PROP +
        ' (Nastavení projektu) a spusťte setup znovu.';
    }
  }
  // Created next to this Sheet – in a shared drive it belongs to the team, not to one person.
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const folder = (parents.hasNext() ? parents.next() : DriveApp.getRootFolder()).createFolder('eQRAP fotky');
  props.setProperty(FOLDER_PROP, folder.getId());
  return '';
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
  menuOnly_();
  removeReminder_();
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(6).create();
  toast_('Denní připomínky jsou zapnuté (každé ráno kolem 6:00).');
}

function removeReminder() {
  menuOnly_();
  removeReminder_();
  toast_('Denní připomínky jsou vypnuté.');
}

function removeReminder_() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyReminder').forEach(t => ScriptApp.deleteTrigger(t));
}

/** Three example problems in different stages, to see how the app works. No e-mails are sent. */
function exampleData() {
  menuOnly_();
  // the menu item sits next to everyday ones: one wrong click must not put example QRAPs into real data
  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* run from the script editor – the developer knows */ }
  if (ui && ui.alert('Vložit ukázková data?', 'Do tabulky se vloží 3 ukázkové QRAP. Při ostrém provozu je nevkládejte ' +
    '(pak je musí manažer v aplikaci zrušit).\n\nOpravdu vložit?', ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    toast_('Nic se nevložilo.');
    return;
  }
  NO_MAIL_ = true;
  let b = '', c = '';
  try {
    const L = cfg_().lists;
    const pick = (list, want) => (list.indexOf(want) >= 0 ? want : list.filter(x => !isOther_(x))[0] || want);
    const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
    const base = { safety: 'NE', repeat7: 'NE', finder: 'Ukázka', notified: pick(L.alert, 'Team Leader') };
    create_(Object.assign({}, base, {
      how: pick(L.how, 'skladování'), what: pick(L.problems, 'poškozené zboží / obal'), when: hoursAgo(2),
      zone: pick(L.zones, 'Sklad'), qty: 2, unit: pick(L.units, 'krabice'),
      descWrong: 'Promáčknutý obal na paletě B-12-03, 2 krabice poškozené', descRight: 'Obal celý, krabice bez poškození',
      reference: '00-4711', s3: { risk: 'NE' }
    }));
    b = create_(Object.assign({}, base, {
      how: pick(L.how, 'kontrola expedice'), what: pick(L.problems, 'chybí / špatná etiketa'), when: hoursAgo(5),
      zone: pick(L.zones, 'Expedice'), qty: 4, unit: pick(L.units, 'krabice'),
      descWrong: 'Rampa 3: na 4 boxech chybí etiketa zákazníka', descRight: 'Každý box má etiketu zákazníka na čelní straně',
      reference: 'DL-2026-0815', notified: [pick(L.alert, 'Team Leader'), pick(L.alert, 'Supervizor')].join(', '),
      s3: { risk: 'ANO', checked: 40, wrong: 4,
        ia: [{ text: 'Etikety doplněny na všech 4 boxech', owner: 'Ukázka', done: hoursAgo(4) }] }
    })).qrap.id;
    c = create_(Object.assign({}, base, {
      how: pick(L.how, 'reklamace zákazníka'), what: pick(L.problems, 'špatné množství'), when: hoursAgo(50),
      zone: pick(L.zones, 'Nakládka'), qty: 1, unit: pick(L.units, 'palety'),
      descWrong: 'Zákazník obdržel o 1 paletu méně, než je na dodacím listu', descRight: 'Počet palet = počet na dodacím listu',
      reference: 'DL-2026-0790', notified: [pick(L.alert, 'Supervizor'), pick(L.alert, 'Logistika / nákup')].join(', '),
      s3: { risk: 'NE', ia: [{ text: 'Chybějící paleta odeslána expresem', owner: 'Ukázka', done: hoursAgo(48) }] }
    })).qrap.id;
    const lead = cfg_().people.filter(p => p.active && p.role && p.email)[0] || { name: me_().name, email: me_().email };
    save_(c, 'rozhodnuti', { decision: 'POKRAČOVAT', decisionNote: 'Opakuje se podruhé tento měsíc', pilots: lead.email,
      shifts: L.shifts.join(', ') });
    save_(c, 'pricina', { o1: 'Paleta nebyla naložena', o2: 'Nebyla na nakládacím seznamu',
      o3: 'Seznam se tiskl před posledním vychystáním', rootO: 3, n1: 'Počet palet se při nakládce nekontroluje', rootN: 1,
      learned: 'Nakládací seznam až po potvrzení vychystání', std: 'NE' });
    const due = Utilities.formatDate(new Date(Date.now() + 7 * 864e5), tz_(), 'yyyy-MM-dd');
    saveAction_(c, { text: 'Tisknout nakládací seznam až po potvrzení vychystání ve WMS', kind: 'O3', owner: lead.name, due: due });
    const r = saveAction_(c, { text: 'Kontrola počtu palet při nakládce (podpis řidiče)', kind: 'N1', owner: lead.name, due: due });
    saveAction_(c, { no: r.actions.filter(a => a.part === '⑥').pop().no, done: true });
  } finally {
    NO_MAIL_ = false;
  }
  toast_('Ukázková data vložena (' + b + ', ' + c + ' a jeden nový).');
}

function toast_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'eQRAP', 10); } catch (e) { /* not in the Sheet */ }
  console.log(msg);
}