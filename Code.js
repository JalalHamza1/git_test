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
 *   Code.gs      = reads/writes the Sheet, checks what is possible, writes notifications
 *   PhotoHandoff.gs = the phone photo hand-off (QR code on the kiosk → photos taken on a company phone)
 *   Index.html   = the whole screen; it receives all data when the page opens, so clicking around is instant
 *   Upload.html  = the small page a phone opens after scanning the QR code
 *
 * SPEED
 *   - The list every page needs is built once per DATA VERSION and kept gzipped in CacheService (listCached_).
 *     Page loads and refreshes reuse that board; access is checked against the current people sheet. Every save makes a new version.
 *   - A save reads only the rows of its own QRAP: a small tab in one call, a big tab by its ID column plus the
 *     matching rows (rowsBy_). History lines are written in one call at the end, SpreadsheetApp.flush() runs once
 *     before the lock is released, slow photo uploads happen outside the lock.
 *   - Notifications do not hold up the person who saves: they are parked in Script Properties and the page has them
 *     written with a second, background call (apiMail). If the page is closed first, the next refresh does it (sweepMail_).
 *   - The app's lock is never held while the other file (notifications, HR) is read or written: a save only marks the
 *     QRAP; the page's background call snapshots the recipients under the lock (local, short) and then writes the
 *     notification sheet under its own lease (syncAlerts_). People chosen in a form are checked against HR before the
 *     lock (prewarmHr_). The HR directory and the OSČ list are cached 6 h; the journal Operace is pruned after 3 days.
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
 *   - Notifications are rows in the notification sheet (Nastavení → NOTIFIKACE_TABULKA), only for the people listed in
 *     Správa → Notifikace, plus selected HR people in Jiné, QRAP pilots and action owners. No e-mails are sent.
 *   - Only the columns the page needs are sent to it (Q_PUB …); the photo folder ID lives in Script Properties.
 *
 * ROLES (tab Lidé, column Role). Everybody works with their own Google account – every step is signed with it.
 *   MONITOR   read only. An ordinary account reports and edits its own early sections. Assignments grant scoped rights.
 *   TEAM LEADER handles containment and shift checks. SUPERVIZOR signs decisions, assigns pilots, closes and assesses.
 *   MANAŽER   like a user + cancel / reopen / unlock a QRAP (always with a reason in the history),
 *             and the dashboard "Přehled manažera"
 *   ADMIN     like MANAŽER + the page "Správa" (people, lists, settings) and "Zobrazit jako". There can be several
 *             admins. A trusted workbook maintainer can restore a missing admin in Lidé.
 *
 * DEPLOYMENT – Execute as: Me · Who has access: anyone in the organisation (never "Anyone").
 * HANDOVER – if the deployer leaves, another admin follows the tab "Předání aplikace" (setup writes it).
 *
 * SECTIONS
 *   1. Tabs, columns, defaults     5. Permissions and what the page gets
 *   2. Web app entry (doGet)       6. Sheet access, cache, form checks
 *   3. API used by the page        7. Notifications (rows in a sheet)
 *   4. Status rules                8. Setup, admin menu, example data
 */

// =====================================================================================
// 1. TABS, COLUMNS, DEFAULTS
// =====================================================================================

const TAB = {
  qraps: 'Problémy', shortages: 'Nedodávky', actions: 'Akce', effects: 'Ověření', assess: 'Hodnocení', log: 'Historie',
  people: 'Lidé', lists: 'Seznamy', settings: 'Nastavení'
};
const HANDOVER_TAB = 'Předání aplikace';
// Tab Lidé, column "E-maily": ANO or empty = the person gets the app's e-mails, NE = none at all. Found by its header,
// so it may sit in any column (setup and Správa add it as column F when it is missing).
const PEOPLE_MAIL = 'E-maily';
const CFG_KEY = 'cfg:test1'; // cache key of cfg_ – a new name, so a cache from the previous version (without "Notifikace") is never used // NOTIF

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
    ['descWrong', '① Skutečný stav'], ['descRight', '① Požadovaný stav'],
    ['materialNo', '① Číslo materiálu'], ['huNo', '① Číslo HU / dodacího listu'], ['supplier', '① Dodavatel'],
    ['partVersion', '① Verze'],
    ['photoWrong', '① Foto skutečného stavu'], ['photoRight', '① Foto požadovaného stavu'], ['photoException', '① Výjimka – proč nejsou fotky'],
    // ② KDO BYL UPOZORNĚN?
    ['notified', '② Upozorněni'], ['notifiedOther', '② Jiné – kdo'],
    ['productionSupervisor', '② Vybraní supervizoři výroby'], ['apuManager', '② APU Manager'], ['notifyPeople', '② Informovat e-mailem'],
    ['alertTestMode','Režim upozornění při vytvoření'], ['alertTestRecipient','Testovací příjemce při vytvoření'],
    // ③ OKAMŽITÁ OPATŘENÍ <24h (the actions themselves are rows in the tab Akce, part ③).
    //   Proces obnoven = "Čas restartu" on the paper form. Kontrola probíhá / Proces zastaven are kept for old QRAPs.
    ['risk', '③ Riziko u zboží na skladě / expedovaného?'], ['checked', '③ Zkontrolováno ks'],
    ['wrong', '③ Nalezeno špatně ks'], ['checkRunning', '③ Kontrola probíhá'],
    ['processStopped', '③ Proces zastaven?'], ['restoredAt', '③ Proces obnoven'], ['s3Done', '③ Kompletní'],
    // ④ ROZHODNUTÍ OJT
    ['shifts', '④ Informované směny (5\' meeting)'], ['decision', '④ Rozhodnutí'], ['decisionNote', '④ Komentář'],
    // ④ Piloti: "Jméno <e-mail>, …" chosen from the HR org chart (older QRAPs: bare e-mails – both are read, see pilotsOf_)
    ['pilots', '④ Piloti'], ['decisionBy', '④ Podepsal'], ['decisionAt', '④ Podepsáno'],
    // ⑤ PŘÍČINA 5 Proč?
    ['o1', '⑤ Proč vzniklo 1'], ['o2', '⑤ Proč vzniklo 2'], ['o3', '⑤ Proč vzniklo 3'], ['o4', '⑤ Proč vzniklo 4'],
    ['o5', '⑤ Proč vzniklo 5'], ['rootO', '⑤ Kořenová příčina – vzniklo (krok)'],
    ['n1', '⑤ Proč nezachyceno 1'], ['n2', '⑤ Proč nezachyceno 2'], ['n3', '⑤ Proč nezachyceno 3'],
    ['n4', '⑤ Proč nezachyceno 4'], ['n5', '⑤ Proč nezachyceno 5'], ['rootN', '⑤ Kořenová příčina – nezachyceno (krok)'],
    ['learned', '⑤ Co jsme se naučili z QR?'], ['std', '⑤ Příležitost k aktualizaci STANDARDU?'], ['stdRef', '⑤ Který standard'],
    // ⑥ closure (actions: tab Akce part ⑥, 5-shift check: tab Ověření)
    ['closedBy', '⑥ Uzavření podepsal'], ['closedAt', 'Uzavřeno'],
    ['cancelReason', 'Zrušeno – důvod'], ['updated', 'Změněno'], ['updatedBy', 'Změnil'], ['revision', 'Verze změny']
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
  'Nedodávky': [['qrapId', 'QRAP'], ['when', 'Čas'], ['partVersion', 'Verze'], ['qty', 'Počet'],
    ['created', 'Zapsáno'], ['by', 'Zapsal'], ['receipt', 'Klíč zápisu']],
  'Operace': [['key', 'Klíč'], ['json', 'Data']],
  'Historie': [['at', 'Kdy'], ['by', 'Kdo'], ['qrapId', 'QRAP'], ['text', 'Co se stalo']]
};
const TIME_KEYS = ['created', 'when', 'restoredAt', 's3Done', 'decisionAt', 'closedAt', 'updated', 'done', 'at'];
const NUMBER_KEYS = ['qty', 'checked', 'wrong', 'no', 'round', 'slot'];
const DATE_KEYS = ['due', 'dueFirst', 'date'];

// The column each data tab is looked up by: one QRAP = its row in Problémy + its rows in the other tabs.
const KEY_FIELD = { 'Nedodávky': 'qrapId', 'Operace': 'key', 'Problémy': 'id', 'Akce': 'qrapId', 'Ověření': 'qrapId', 'Hodnocení': 'qrapId', 'Historie': 'qrapId' };

// Tab "Nastavení": [key, default value, explanation shown next to it]. The photo folder ID is in Script Properties.
const SETTINGS = [
  ['NAZEV', 'eQRAP', 'Název aplikace – nahoře na stránce a v e-mailech.'],
  ['LOGO_URL', '', 'Veřejný odkaz na obrázek loga (nebo Base64 kód).'],
  ['EMAILY', 'ANO', 'ANO = posílat upozornění, NE = neposílat (např. při zkoušení). Kdo je dostane: Správa → Notifikace.'], // NOTIF
  ['NOTIFIKACE_TABULKA', '', 'Odkaz na tabulku upozornění (Můj plán) – zapisuje se do listů „Alerts_eQRAP Log“ a „Alerts_eQRAP Log_Safety“. Prázdné = upozornění se nikam nezapisují.'], // NOTIF
  ['NOTIFIKACE_APLIKACE', 'eQRAP', 'Co se zapíše do sloupce „Aplikace“ v tabulce upozornění.'], // NOTIF
  ['LHUTA_OPATRENI_HODIN', 24, 'Do kolika hodin od KDY mají být hotová ③ okamžitá opatření.'],
  ['ZOBRAZIT_UZAVRENE_DNI', 60, 'Kolik dní zpět se na přehledu ukazují uzavřené problémy.'],
  ['ODKAZ_APLIKACE', '', 'Adresa aplikace do e-mailů. Prázdné = zjistí se automaticky. Po novém nasazení sem dejte nový odkaz.']
];
const PUBLIC_SETTINGS = ['NAZEV', 'LOGO_URL', 'LHUTA_OPATRENI_HODIN', 'ZOBRAZIT_UZAVRENE_DNI']; // all the page needs
const FOLDER_PROP = 'FOTKY_SLOZKA_ID';

// Tab "Seznamy": [name in code, column header, default values]. The admin edits the values in the Sheet.
const LOGISTICS_ROLE = 'Supervizor logistiky';
const PRODUCTION_ROLE = 'Supervizor výroby';
const ROUTE_PREFIX = 'Výroba → APU: '; // older notification settings
const SPU_RECIPIENT = 'APU Manager';
const SPU_RECIPIENT_OLD = 'Supervizor SPU'; // the row name before the rename – still read until Správa saves again
function alertRole_(value) { return plain_(value) === 'SUPERVIZOR' ? LOGISTICS_ROLE : value; }
function alertRoles_(value) { return [...new Set(list_(multi_(value)).map(alertRole_))].join(', '); }

const LISTS = [
  ['zones', 'Zóny', ['Příjem', 'Sklad', 'Vychystávání', 'Balení', 'Expedice', 'Nakládka']],
  ['problems', 'CO je za problém', ['chybí / špatná etiketa', 'špatný materiál', 'špatné množství', 'poškozené zboží / obal',
    'chybějící dokumentace', 'jiné']],
  ['how', 'JAK byl objeven', ['příjem zboží', 'skladování', 'vychystávání', 'balení', 'kontrola expedice', 'inventura',
    'reklamace zákazníka', 'dodávka dodavatele', 'jiné']],
  ['units', 'Jednotky', ['ks', 'krabice', 'palety', 'manipulační jednotky']],
  ['alert', 'Kdo byl upozorněn', ['Team Leader', LOGISTICS_ROLE, PRODUCTION_ROLE, 'Údržba', 'Kvalita', 'Vedoucí skladu', 'Logistika / nákup', 'jiné']],
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
  ['4. Menu eQRAP → Zapnout denní dopsání čekajících upozornění. Nový účet musí mít právo upravovat tabulku upozornění (Nastavení → NOTIFIKACE_TABULKA).'], // NOTIF
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
const ROLES = ['MONITOR', 'TEAM LEADER', 'SUPERVIZOR', 'MANAŽER', 'ADMIN'];
const ASSESS_VALUES = ['OK', 'NOK', 'N/A'];
const FEEDBACK_TYPES = ['pochvala', 'silná stránka', 'ke zlepšení'];
const PARTS = ['popis', 'opatreni', 'smeny', 'rozhodnuti', 'piloti', 'pricina', 'uzavreni'];
// Closure conditions – the page gets these labels once and one true/false per QRAP (field "ck").
const CHECK_LABELS = ['QRAP je ve stavu Ověření 5 směn', 'kořenová příčina označena (⑤)', 'všechny konečné akce hotové',
  'otázka na aktualizaci standardu zodpovězena', 'efektivní na 5 různých směnách', '„Co jsme se naučili z QR?“ vyplněno'];

// What the page gets of each row – nothing more (no editor accounts, no internal columns).
const Q_PUB = ['id', 'status', 'created', 'safety', 'what', 'whatOther', 'how', 'howOther', 'when', 'zone', 'location',
  'qty', 'unit', 'nokSituation', 'repeat7', 'partVersion', 'finder', 'descWrong', 'descRight', 'materialNo', 'huNo',
  'supplier', 'productionSupervisor', 'apuManager', 'photoWrong', 'photoRight', 'photoException', 'notified', 'notifiedOther', 'risk', 'checked', 'wrong',
  'checkRunning', 'restoredAt', 's3Done', 'shifts', 'decision', 'decisionNote', 'pilots', 'decisionBy', 'decisionAt',
  'o1', 'o2', 'o3', 'o4', 'o5', 'rootO', 'n1', 'n2', 'n3', 'n4', 'n5', 'rootN', 'learned', 'std', 'stdRef',
  'closedBy', 'closedAt', 'cancelReason', 'updated', 'revision'];
const A_PUB = ['qrapId', 'no', 'part', 'kind', 'text', 'owner', 'ownerEmail', 'due', 'done', 'evidence', 'note'];
const E_PUB = ['qrapId', 'round', 'slot', 'date', 'shift', 'result', 'by'];
const S_PUB = ['qrapId', 'at', 'by', 'c1', 'c2', 'c3', 'c4', 'c5', 'ojtWith', 'feedback', 'feedbackType'];
const QK = Q_PUB.concat(['s3Missing', 'eff', 'ck', 'can', 'shortages', 'shortageCount']); // public column names of the compact list
// What can be done with a QRAP now, sent as one number: bit i = CAN_KEYS[i]. ck works the same way with CHECK_LABELS.
const CAN_KEYS = ['popis', 'opatreni', 'shifts', 'decide', 'analyze', 'pilots', 'effect', 'close', 'assess'];
const AK = A_PUB.concat(['canEdit', 'canDone', 'canProgress']);

/**
 * The fields of each part of the form. The page sends a fingerprint of them as it showed them (_fp, see fp_);
 * when the fingerprint of the row now differs, somebody else saved that part meanwhile → the save is refused.
 * The same function runs on the page (Index.html, fpOf), so both sides compute the same value.
 */
const FP_FIELDS = {
  popis: ['safety', 'what', 'whatOther', 'how', 'howOther', 'when', 'zone', 'qty', 'unit', 'nokSituation', 'repeat7',
    'partVersion', 'finder', 'descWrong', 'descRight', 'notified', 'notifiedOther', 'productionSupervisor'],
  opatreni: ['risk', 'checked', 'wrong', 'restoredAt'], // + the ③ actions (fpQ_)
  smeny: ['shifts'],
  pricina: ['o1', 'o2', 'o3', 'o4', 'o5', 'rootO', 'n1', 'n2', 'n3', 'n4', 'n5', 'rootN', 'learned', 'std', 'stdRef'],
  akce: ['text', 'kind', 'owner', 'ownerEmail', 'due', 'done', 'evidence', 'note']
};

/** Change this text whenever you deploy a new version: open pages then offer "Obnovit stránku". */
const APP_BUILD = '2026-11-26-apu-refresh';

const PERF = {
  FULL_READ_CELLS: 15000, // a tab up to this size is read in one call; a bigger one by ID column + matching rows
  RUN_GAP: 40,            // matching rows closer than this are read together as one block
  CACHE_TTL: 21600,       // 6 h – the CacheService maximum
  CHUNK: 95000,           // characters per cache entry (CacheService limit: 100 KB per entry)
  MAX_CHUNKS: 40
};
const LIMIT = { ROWS: 30, ITEMS: 200, PHOTO_CHARS: 7000000, PHOTO_BYTES: 5 * 1024 * 1024, DEADLINE_H: 720, CLOSED_DAYS: 365 };
const MAIL = { PREFIX: 'MAIL:' }; // Legacy property queues are retired after successful reconciliation.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Per-request memory (each server call starts with empty values).
let MEMO_ = {};
let CFG_ = null;
let ME_ = null;
let SS_ = null;
let FOLDER_ = null;
let MAILOK_ = null;
let NO_MAIL_ = false;
let OUTBOX_ = [];    // Compatibility reset for interrupted saves; delivery now uses Alerty_stav.
let LOG_ = [];       // history lines waiting until the end of the save
let IN_LOCK_ = false;
let WROTE_ = false;  // something was written → SpreadsheetApp.flush() before the lock is released
let BUMP_ = false;   // QRAP data changed → new data version, open pages reload
let DEFER_MAIL_ = false; // Web calls request immediate background reconciliation after saving.
let MAIL_KEYS_ = [];     // QRAP reconciliation keys returned to the page as mailKeys.
let ME_AT_ = 0;           // when me_() last read the tab Lidé (lock_ re-reads it only if that was not just now)

/** A problem the user can fix (wrong input, wrong state). Its message is shown to the user as it is. */
class UserError extends Error {}
class AccountAccessError extends UserError {}

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
    boot = { error: publicError_('doGet', err), url: appUrl_(), params: {id: String(p.id || '').slice(0,40), view: String(p.view || '').slice(0,20)} };
  }
  // "<" is escaped, so nothing in the data can close the <script> tag it is printed into.
  page.boot = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return page.evaluate()
    .setTitle(boot.cfg ? String(boot.cfg.NAZEV) : 'eQRAP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // no framing by other sites
}

function startData_(params) {
  const me = me_(); // refuses visitors without a company account before anything is read
  const ver = dataVersion_(); // read before the data: a change saved meanwhile is picked up by the next refresh
  const c = cfg_();
  const view = String(params.view || '');
  return Object.assign(boardFor_(false, ver, me), {
    me: me,
    ver: viewerVersion_(ver, me),
    build: APP_BUILD,
    configVersion: c.revision,
    url: appUrl_(),
    cfg: publicSettings_(c.settings),
    lists: c.lists,
    people: activePeople_(c),
    meta: { checklist: CHECK_LABELS, can: CAN_KEYS },
    params: { id: String(params.id || '').trim().slice(0, 40), view: ['new', 'help', 'dash'].indexOf(view) >= 0 ? view : '' }
  });
}

// =====================================================================================
// 3. API
//    3a. Everything a browser can call. Each is a thin wrapper around run_(); the work is in 3b.
//        (Functions whose name ends with "_" cannot be called from the browser at all.)
// =====================================================================================

function apiStart(params) { return run_('apiStart', () => startData_(obj_(params))); }
function apiRefresh(all, known, configVersion) {
  return run_('apiRefresh', () => refresh_(all, known, configVersion));
}
function apiRecoverAlerts() {
  return run_('apiRecoverAlerts', () => { me_(); return sweepMail_(); });
}
function apiGet(id, known) { return run_('apiGet', () => get_(id, known)); }
function apiBoardPage(filters) { return run_('apiBoardPage', () => allBoardPage_(filters)); }
function apiAppendShortage(id, f) { return run_('apiAppendShortage', () => appendShortage_(id, f)); }
function apiShortages(id) { return run_('apiShortages', () => shortageList_(id)); }
function apiCreate(f) { return run_('apiCreate', () => create_(f)); }
function apiSave(id, part, f) { return run_('apiSave', () => save_(id, part, f)); }
function apiSaveAction(id, a) { return run_('apiSaveAction', () => saveAction_(id, a)); }
function apiSaveEffect(id, p) { return run_('apiSaveEffect', () => saveEffect_(id, p)); }
function apiAssess(id, f) { return run_('apiAssess', () => assess_(id, f)); }
function apiSetPhoto(id, kind, full, thumb, expected) { return run_('apiSetPhoto', () => setPhoto_(id, kind, full, thumb, expected)); }
function apiPhoto(id, fileId) { return run_('apiPhoto', () => photo_(id, fileId)); }
function apiHistory(id) { return run_('apiHistory', () => history_(id)); }
function apiAdmin(id, op, reason, version) { return run_('apiAdmin', () => admin_(id, op, reason, version)); }
function apiViewAs(role) { return run_('apiViewAs', () => viewAs_(role)); }
function apiAdminData() { return run_('apiAdminData', () => adminData_()); }
function apiSavePerson(p) { return run_('apiSavePerson', () => savePerson_(p)); }
function apiSaveList(key, values, version) { return run_('apiSaveList', () => saveList_(key, values, version)); }
function apiSaveSettings(obj, originals) { return run_('apiSaveSettings', () => saveSettings_(obj, originals)); }
function apiMail(keys) { return run_('apiMail', () => mailOut_(keys)); }
function apiSaveNotif(o) { return run_('apiSaveNotif', () => saveNotif_(o)); } // NOTIF: Správa → Notifikace
// Start loading the shared HR index while the reporter is completing earlier steps.
function apiWarmPeople() {
  return run_('apiWarmPeople', () => {
    requireWriter_();
    const cache = CacheService.getScriptCache();
    if (!cache.get(NOTIF.ORG_KEY) && !cache.get(NOTIF.ORG_KEY + ':warming')) {
      rate_('hr-warm',4,60);
      cache.put(NOTIF.ORG_KEY + ':warming','1',30);
      try { orgChart_(); }
      finally { cache.remove(NOTIF.ORG_KEY + ':warming'); }
    }
    return {ok:true};
  });
}
// A writer downloads the small public identity fields once per active form session.
// Verification of chosen identities and permissions remains in each save endpoint.
function apiPeopleIndex(fresh) {
  return run_('apiPeopleIndex', () => {
    requireWriter_();
    need_(fresh == null || typeof fresh === 'boolean', 'Neplatný požadavek HR.');
    rate_('hr-directory',12,60);
    if (fresh) rate_('hr-reload',4,60);
    const config = cfg_(), off = disabledRecipients_();
    const people = orgChart_(fresh === true).map(p =>
      [p.n,p.e,p.p,p.o !== '' && !off.has(p.e) ? 1 : 0]);
    return {people,configVersion:config.revision};
  });
}
function apiFindPeople(query, purpose, omit) {
  return run_('apiFindPeople', () => {
    const actor = requireWriter_();
    need_(['assignment','finder','configured'].includes(purpose), 'Neplatné hledání v HR.');
    if (purpose === 'configured') requireRight_(actor.admin);
    rate_('hr-search', 120, 60);
    const term = plain_(txt_(query, 254)).toLowerCase();
    if (!term) return {people:[]};
    need_(omit == null || (Array.isArray(omit) && omit.length <= (actor.admin ? 500 : 10)), 'Příliš mnoho osob.');
    const taken = new Set((omit || []).map(e => txt_(e,254).toLowerCase()));
    const words = term.split(/\s+/);
    const cache = CacheService.getScriptCache();
    const cacheKey = 'hr-hits:' + digest_([cfg_().revision,purpose,term,[...taken].sort()]);
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
    const excluded = purpose === 'assignment' ? disabledRecipients_() : null;
    const ranked = [[], [], []];
    for (const p of orgChart_()) {
      if (taken.has(p.e) || (excluded && (p.o === '' || excluded.has(p.e)))) continue;
      if (!words.every(word => p.search.includes(word))) continue;
      const rank = p.e === term || p.normal === term ? 0 : p.normal.startsWith(term) || p.e.startsWith(term) ? 1 : 2;
      if (ranked[rank].length < 8) ranked[rank].push({n:p.n, e:p.e, p:p.p});
      if (ranked[0].length === 8) break;
    }
    const result = {people:ranked.flat().slice(0,8)};
    // A miss may be an HR update arriving now. Only reuse successful searches.
    if (result.people.length) cache.put(cacheKey,JSON.stringify(result),60);
    return result;
  });
}
function apiRestoreArchivedQrap(id) { return run_('apiRestoreArchivedQrap', () => restoreArchived_(id, true)); } // CHANGED: Správa → Archiv called it, but it did not exist
// (the photo hand-off – apiPhotoSession, apiPhotoPoll, apiPhoneUpload, apiStagePhoto, apiPhotoDiscard – is in PhotoHandoff.gs)

/**
 * Runs one browser call: a UserError keeps its message, anything else is logged and shown only as a code.
 * E-mails of the call are parked; their keys go back to the page (mailKeys), which sends them with apiMail.
 */
function run_(name, fn) {
  DEFER_MAIL_ = true;
  try {
    const res = fn();
    if (ALERT_WARNING_ && res && typeof res === 'object') res.alertWarning = ALERT_WARNING_;
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
  if (e instanceof AccountAccessError && name.startsWith('api') && name !== 'apiPhoneUpload') return '[EQ_ACCOUNT] ' + e.message;
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
function viewerVersion_(ver, actor) { return [ver, actor.email, actor.role].join('|'); }
function refresh_(all, known, configVersion) {
  const me = me_(), c = cfg_(), ver = dataVersion_();
  const reply = {ver:viewerVersion_(ver,me), build:APP_BUILD, me:me, configVersion:c.revision};
  if (!configVersion || configVersion !== c.revision) {
    Object.assign(reply, {cfg:publicSettings_(c.settings), lists:c.lists, people:activePeople_(c)});
  }
  if (!CacheService.getScriptCache().get('alerts:recent-sweep')) {
    if (configVersion === undefined) sweepMail_(); // clients opened before this release
    else reply.recoverAlerts = true;
  }
  if (known && String(known) === reply.ver && (!configVersion || configVersion === c.revision)) return Object.assign(reply, {unchanged:true});
  return Object.assign(reply, boardFor_(!!all, ver, me));
}

/** One problem with everything that belongs to it. known = the page's data version (sent only if it has the QRAP). */
function get_(id, known) {
  const actor = me_();
  id = idOf_(id);
  const ver = viewerVersion_(dataVersion_(),actor);
  if (known && String(known) === ver) return {unchanged:true, ver:ver, build:APP_BUILD, me:actor};
  return Object.assign(pack_(id), {ver:ver, build:APP_BUILD, me:actor});
}

/**
 * ① ② ③ – report a new problem. ③ requires the risk answer and at least one HR-assigned immediate action. Sending the same form twice gives one QRAP.
 * Photos: taken on the kiosk (f.photoWrong …) or handed over from a phone (f.photoToken, see PhotoHandoff.gs).
 * Photos never block the save: kinds that could not be attached come back in photoLost (the page uploads them again).
 */
function create_(f) {
  requireWriter_(true);
  rate_('create-input', 90, 600);
  f = obj_(f);
  checkFormSize_(f);
  const key = operationKey_('create', f.token);
  const hash = digest_(f);
  const previous = operation_(key);
  if (previous) {
    need_(previous.hash === hash, 'Tento formulář už byl odeslán s jinými údaji. Otevřete původní QRAP nebo nový formulář.');
    const result = lock_(() => resumeCreate_(key, operation_(key)));
    if (f.photoToken && psMeta_(f.photoToken) && psMeta_(f.photoToken).owner === me_().email) phoneDone_(f.photoToken);
    const out = pack_(result.id); out.dup = true; return out;
  }
  // Respect in-flight drafts created by the previous deployed version while its cache survives.
  const legacy = CacheService.getScriptCache().get('create:' + f.token);
  if (legacy) {
    const q = find_(legacy);
    need_(q.createdBy === me_().email, 'Formulář patří jinému účtu.');
    const out = pack_(legacy); out.dup = true; return out;
  }
  rate_('create', 30, 600);
  const q = popisFrom_(f, {});
  const s3in = obj_(f.s3);
  Object.assign(q, opatreniFrom_(s3in, q.when));
  const ia = rowsIn_(s3in.ia).filter(r => r.remove !== true).map(r => iaFields_(r, q.when));
  need_(ia.length, 'Přidejte alespoň jedno okamžité opatření a vyberte osobu z HR.');
  const started = Date.now();
  prewarmHr_([f.productionSupervisor, f.productionSupervisor ? readNotif_().spuSupervisor : '']);
  const phone = phonePhotos_(f.photoToken, f.photoKeep, f.photoDrop);
  const files = [];
  let res, locked = 0;
  try {
    q.photoWrong = savePhotoPair_(f.photoWrong, f.photoWrongThumb, files) || phone.WRONG;
    q.photoRight = savePhotoPair_(f.photoRight, f.photoRightThumb, files) || phone.RIGHT;
    locked = Date.now();
    res = lock_(() => {
      let op = operation_(key);
      if (op) { need_(op.hash === hash, 'Formulář byl odeslán s jinými údaji.'); return resumeCreate_(key, op); }
      const test = readNotif_();
      q.alertTestMode = test.testMode; q.alertTestRecipient = test.testRecipient;
      applyProductionSelection_(q, f.productionSupervisor, {});
      q.id = nextId_(); seedNew_(q.id); q.created = nowIso_(); q.createdBy = me_().email;
      addQuality_(q);
      op = {hash: hash, state: 'pending', q: q, ia: ia.map((r, i) => Object.assign({qrapId:q.id, no:i+1, part:'③', created:q.created}, r))};
      saveOperation_(key, op);
      return resumeCreate_(key, op);
    });
  } catch (e) {
    trashUnreferenced_(files);
    if (phone.mine) phoneReopen_(f.photoToken);
    throw e;
  }
  // Timing in Apps Script → Executions, to see where a slow "Odeslat" spends its time.
  console.log('apiCreate ' + res.id + ': photos ' + (locked - started) + ' ms, save ' + (Date.now() - locked) + ' ms');
  const saved = find_(res.id);
  const attached = photoIds_(saved.photoWrong).concat(photoIds_(saved.photoRight));
  trashUnreferenced_(files.filter(id => attached.indexOf(id) < 0));
  trashUnreferenced_(phone.unused);
  if (phone.mine) phoneDone_(f.photoToken);
  const out = pack_(res.id); out.dup = res.dup;
  if (phone.expired) out.phoneExpired = true;
  const lost = phone.lost.filter(k => !out.qrap[k === 'RIGHT' ? 'photoRight' : 'photoWrong']);
  if (lost.length) out.photoLost = lost;
  return out;
}


// Internal recovery journal. No alert queue or recipient changes are made here.
const OPS_TAB = 'Operace';
// Bound work before hashing user input, including drafts carrying inline images.
function checkPhotoSizes_(full, thumb) {
  for (const value of [full, thumb]) {
    need_(value == null || (typeof value === 'string' && value.length <= LIMIT.PHOTO_CHARS), 'Fotka je příliš velká nebo má neplatný formát.');
  }
}
function checkFormSize_(form) {
  let cells = 0, chars = 0;
  const visit = (v, depth) => {
    need_(depth <= 5 && ++cells <= 750, 'Formulář má neplatnou strukturu.');
    if (typeof v === 'string') chars += v.length;
    else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      need_(keys.length <= 200, 'Příliš mnoho polí formuláře.');
      keys.forEach(k => { chars += k.length; visit(v[k], depth + 1); });
    }
    need_(chars <= 80000, 'Text formuláře je příliš dlouhý.');
  };
  const text = Object.assign(Object.create(null), form);
  for (const k of ['photoWrong','photoRight']) {
    checkPhotoSizes_(form[k], form[k + 'Thumb']);
    delete text[k]; delete text[k + 'Thumb'];
  }
  visit(text, 0);
}
function stableJson_(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson_).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableJson_(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function digest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, stableJson_(value), Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function operation_(key) {
  const journal = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPS_TAB);
  if (!journal || journal.getLastRow() === 0) return null;
  const row = rowsBy_(OPS_TAB, key)[0];
  return row ? JSON.parse(row.json) : null;
}
// durable = false only for a final "done" mark inside lock_(), which flushes before the lock is released anyway.
function saveOperation_(key, value, durable = true) {
  value.savedAt = nowIso_(); // for pruneOperations_
  const json = JSON.stringify(value);
  need_(json.length <= 45000, 'Operace je příliš velká. Kontaktujte správce; data nebyla zahozena.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const journal = ss.getSheetByName(OPS_TAB) || ss.insertSheet(OPS_TAB);
  if (journal.getLastRow() === 0) { journal.getRange(1, 1, 1, 2).setValues([['Klíč', 'Data']]); delete MEMO_[OPS_TAB]; }
  const row = rowsBy_(OPS_TAB, key)[0];
  if (row) { row.json = json; update_(OPS_TAB, row); }
  else insert_(OPS_TAB, {key: key, json: json});
  if (durable) SpreadsheetApp.flush(); // reservation must be durable before business rows are written
}
function operationKey_(kind, token) {
  need_(typeof token === 'string' && /^[\w-]{8,64}$/.test(token), 'Neplatný identifikátor formuláře. Obnovte stránku.');
  return kind + ':' + me_().email + ':' + token;
}
function operationHistory_(op) {
  (op.logs || []).forEach(log => {
    const exists = rowsBy_(TAB.log, log.qrapId).some(r => r.at === log.at && r.by === log.by && r.text === log.text);
    if (!exists) insert_(TAB.log, Object.assign({}, log));
  });
}
function finishOperation_(key, op, q, text, isNew) {
  if (!op.logs) {
    finish_(q, text, isNew);
    op.logs = LOG_.slice(); LOG_ = [];
    saveOperation_(key, op);
  }
  operationHistory_(op);
  op.state = 'done';
  if (key.startsWith('create:')) { op.q = {id:q.id}; delete op.ia; delete op.logs; }
  saveOperation_(key, op, false); // the last mark – lock_() flushes before the lock is released
}
/** Uncertain failures retain files for recovery; only positively unused files are removed. */
function trashUnreferenced_(files) {
  if (!files.length) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    MEMO_ = {};
    const refs = new Set();
    table_(TAB.qraps).all.forEach(q => photoIds_(q.photoWrong).concat(photoIds_(q.photoRight)).forEach(id => refs.add(id)));
    const archive = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.qraps + ' - Archiv');
    if (archive && archive.getLastRow() > 1) {
      const data = archive.getDataRange().getValues(), headers = data[0].map(String);
      const columns = ['photoWrong','photoRight'].map(k => headers.map(qrapHeader_).indexOf(COLS[TAB.qraps].find(c => c[0] === k)[1]));
      if (columns.some(i => i < 0)) return; // unknown archive layout: retain files
      data.slice(1).forEach(row => columns.forEach(i => photoIds_(row[i]).forEach(id => refs.add(id))));
    }
    const pending = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPS_TAB) ? table_(OPS_TAB).all.filter(r => r.key.indexOf('upload:') !== 0 && JSON.parse(r.json).state !== 'done').map(r => r.json).join('\n') : '';
    trash_(files.filter(id => !refs.has(id) && pending.indexOf(id) < 0));
  } catch (e) { console.warn('Fotky ponechány pro obnovu: ' + e.message); }
  finally { lock.releaseLock(); }
}
function resumeCreate_(key, op) {
  if (op.state === 'done') return {id: op.q.id, dup: true};
  const existing = rowsBy_(TAB.qraps, op.q.id)[0];
  if (existing) {
    // A parent row is written only after its child rows. A retry repairs history, even if
    // the report has since been signed; it must never write the signed record or its actions.
    need_(existing.createdBy === op.q.createdBy && Math.abs(Date.parse(existing.created)-Date.parse(op.q.created)) < 1000,
      'Číslo QRAP patří jinému hlášení. Kontaktujte správce.');
    if (!op.logs) op.logs = [{at:op.q.created, by:op.q.createdBy, qrapId:op.q.id, text:'Nahlášeno: ' + short_(title_(op.q))}];
    operationHistory_(op);
    op.state='done'; op.q={id:existing.id}; delete op.ia; delete op.logs;
    saveOperation_(key,op); alertTouch_(existing); BUMP_=true;
    return {id:existing.id,dup:true};
  }
  const q = Object.assign({}, op.q);
  const acts = actionsOf_(q.id);
  insertMany_(TAB.actions, op.ia.filter(a => !acts.some(x => x.no === a.no && x.part === a.part)).map(a => Object.assign({}, a)));
  const title = 'Nahlášeno: ' + short_(title_(q));
  finish_(q, title, true);
  // A create has one deterministic audit line. The existing parent and the pending reservation
  // suffice to recover at any boundary, including a lost response after signing later.
  LOG_ = [];
  operationHistory_({logs:[{at:q.created, by:q.createdBy, qrapId:q.id, text:title}]});
  op.state = 'done'; op.q = {id:q.id}; delete op.ia; delete op.logs;
  saveOperation_(key,op,false); // SPEED: lock_() flushes right after – no second flush needed
  notifyNew_(q); // Reconciliation uses the committed QRAP and durable alert state.
  return {id: q.id, dup: false};
}

/**
 * Save one part of the form.
 *   'popis' ① ② · 'opatreni' ③ · 'smeny' ④ shifts informed · 'rozhodnuti' ④ decision (signature, pilots)
 *   'piloti' add pilots · 'pricina' ⑤ · 'uzavreni' ⑥ closure signature
 */
// Reserve a signature or management transition before modifying the record. Replays repair the audit
// trail under the same lock without ever applying an old decision to a subsequently changed QRAP.
function transition_(q, kind, version, input) {
  need_(typeof version === 'string' && version.length <= 40, STALE_);
  const key = 'transition:' + q.id + ':' + digest_([who_(),kind,version]);
  const hash = digest_(input), op = operation_(key);
  if (op) need_(op.hash === hash, STALE_);
  else requireVersion_(q, version);
  return {key:key,hash:hash,op:op};
}
function commitTransition_(tx, q, message, before) {
  let op = tx.op;
  if (!op) {
    const at = new Date(Math.max(Date.now(), (Date.parse(q.updated) || 0) + 1)).toISOString();
    const status = statusOf_(q, actionsOf_(q.id), effectsFor_(q));
    const patch = {status:status, updated:at, updatedBy:who_(), revision:Utilities.getUuid()};
    for (const k of ['decision','decisionBy','decisionAt','decisionNote','pilots','shifts','closedAt','closedBy','cancelReason']) patch[k] = q[k] || '';
    const logs = [{at:at,by:who_(),qrapId:q.id,text:message}];
    if (before !== status) logs.push({at:at,by:who_(),qrapId:q.id,text:'Stav: ' + status});
    op = {state:'pending',hash:tx.hash,base:recordRevision_(q),patch:patch,logs:logs};
    saveOperation_(tx.key,op);
  }
  if (op.state === 'done') return;
  if (op.state === 'pending') {
    if (recordRevision_(q) === op.base) {
      ensureQrapColumns_();
      Object.assign(q,op.patch);
      update_(TAB.qraps,q);
      SpreadsheetApp.flush();
    } else need_(q.revision === op.patch.revision && q.updatedBy === op.patch.updatedBy &&
      q.status === op.patch.status, 'Záznam se během obnovy změnil. Kontaktujte správce.');
    op.state = 'applied'; saveOperation_(tx.key,op,false); // SPEED: recovery recognises the applied patch by its revision
  }
  operationHistory_(op);
  op.state = 'done'; saveOperation_(tx.key,op,false); // lock_() flushes before the lock is released
  BUMP_ = true; alertTouch_(q);
}
function save_(id, part, f) {
  id = idOf_(id);
  f = obj_(f);
  checkFormSize_(f);
  need_(PARTS.indexOf(part) >= 0, 'Neznámá část formuláře.');
  me_();
  prewarmHr_([f.finder, f.pilots, f.notifiedOther, f.productionSupervisor, Array.isArray(f.ia) ? f.ia.map(r => r && r.owner) : [],
    f.productionSupervisor ? readNotif_().spuSupervisor : '']);
  // ⑤ with "update the standard" = ANO: the action goes to the first available pilot – check them before the lock too
  if (part === 'pricina' && f.std === 'ANO') { try { prewarmHr_([find_(id).pilots, me_().email]); } catch (e) { /* checked inside */ } }
  let conflict = null;
  lock_(() => {
    const me = me_();
    const q = find_(id);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts, effectsFor_(q));
    const right = {popis:'popis', opatreni:'opatreni', smeny:'shifts', rozhodnuti:'decide', piloti:'pilots', pricina:'analyze', uzavreni:'close'}[part];
    requireRight_(rights_(q.createdBy, q.pilots, me)[right]);
    const signed = part === 'rozhodnuti' || part === 'uzavreni';
    const tx = signed ? transition_(q,part,f.version,f) : null;
    const before = q.status;
    if (tx && tx.op) { commitTransition_(tx,q); return; }
    if (!signed && !FP_FIELDS[part]) requireVersion_(q, f.version);
    // somebody saved this part after the page showed it: write nothing, the page asks what to do
    if (FP_FIELDS[part] && f._fp !== fpQ_(q, part, acts)) { conflict = conflictOf_(q); return; }
    let text;

    if (part === 'popis') {
      need_(beforeDecision_(q), 'Popis ① ② lze upravit jen do rozhodnutí ④ (potom jen po odemknutí manažerem).');
      const before = list_(q.notified); // NOTIF
      const changed = popisFrom_(f, q);
      applyProductionSelection_(changed, f.productionSupervisor, q);
      if (q.safety === 'ANO' && changed.safety !== 'ANO') {
        need_(me.manager, 'Označení SAFETY může odebrat jen manažer nebo admin.');
        log_(id, '① Odebráno označení SAFETY');
      }
      if (changed.when !== q.when) {
        need_(!shortagesFor_(id).some(row => row.when.slice(0,16) < changed.when.slice(0,16)), 'Kdy nemůže být po zaznamenané nedodávce.');
        need_(!q.restoredAt || q.restoredAt >= changed.when, 'KDY nemůže být po zaznamenaném čase restartu.');
        need_(!iaActions_(acts).some(a => a.done && a.done < changed.when), 'KDY nemůže být po zaznamenaném čase okamžitého opatření.');
      }
      Object.assign(q, changed);
      addQuality_(q);
      notifyRoles_(q, list_(q.notified).filter(r => before.indexOf(r) < 0)); // NOTIF: roles ticked now in ② are told
      text = '①② Popis upraven';

    } else if (part === 'opatreni') {
      need_(beforeDecision_(q), 'Okamžitá opatření ③ lze měnit jen do rozhodnutí ④.');
      const before = list_(q.notified); // NOTIF
      const s = opatreniFrom_(f, q.when);
      const rows = rowsIn_(f.ia).map(r => {
        need_(r.remove == null || typeof r.remove === 'boolean', 'Neplatná volba odebrání opatření.');
        return r.remove ? {no:r.no, remove:true} : Object.assign({no:r.no}, iaFields_(r, q.when, acts.find(a => a.part === '③' && !a.removed && a.no === Number(r.no))));
      });
      Object.assign(q, s);
      syncIa_(q.id, rows);
      addQuality_(q);
      notifyRoles_(q, list_(q.notified).filter(r => before.indexOf(r) < 0)); // NOTIF: risk = ANO adds "Kvalita" to ② – its people are told
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
      if (d === 'VYŘEŠENO') {
        need_(q.safety !== 'ANO', 'Bezpečnostní problém (SAFETY = ANO) nelze uzavřít bez 5 Proč.');
        need_(note, 'Napište komentář – proč je problém vyřešen.');
      }
      if (d === 'ESKALACE') need_(note, 'Napište komentář – proč eskalujete.');
      const chosen = d === 'VYŘEŠENO' ? [] : pilotsFrom_(f.pilots);
      if (d === 'POKRAČOVAT') need_(chosen.length, 'Vyberte alespoň jednoho pilota pro analýzu 5 Proč.');
      const pilots = d === 'VYŘEŠENO' ? [] : chosen; // ESKALACE: pilots optional (the analysis goes on)
      if (f.shifts !== undefined) q.shifts = onlyFrom_(f.shifts, cfg_().lists.shifts);
      Object.assign(q, { decision: d, decisionNote: note, pilots: pilotsCell_(pilots), decisionBy: me.name, decisionAt: nowIso_() });
      if (d === 'VYŘEŠENO') { q.closedAt = q.decisionAt; q.closedBy = me.name; } // solved without 5 Proč: closed at once
      text = '④ Rozhodnutí podepsáno: ' + DECISIONS[d] + (pilots.length ? ' · piloti: ' + pilots.map(p => p.name).join(', ') : '');
      if (pilots.length) notifyPilots_(q, pilots.map(p => p.email));

    } else if (part === 'piloti') {
      need_(isAnalysis_(q), 'Piloty lze přidat během analýzy.');
      const have = pilotsOf_(q.pilots);
      const added = pilotsFrom_(f.pilots).filter(p => !have.some(x => x.email === p.email));
      need_(added.length, 'Vyberte nového pilota.');
      need_(have.length+added.length<=10,'QRAP může mít nejvýš 10 pilotů.');
      q.pilots = pilotsCell_(have.concat(added));
      notifyPilots_(q, added.map(p => p.email));
      text = '⑤ Přidán pilot: ' + added.map(p => p.name).join(', ');

    } else if (part === 'pricina') {
      need_(canAnalyze_(q), '5 Proč lze vyplnit během analýzy.');
      Object.assign(q, pricinaFrom_(f));
      syncStdAction_(q);
      text = '⑤ Analýza 5 Proč uložena';

    } else { // 'uzavreni'
      need_(canClose_(q), 'QRAP zatím nelze uzavřít – musí být ve stavu „Ověření 5 směn“.');
      if (q.status !== 'SCHVÁLENÍ') {
        const miss = checks_(q, actionsOf_(id), effState_(effectsOf_(id), effFrom_(actionsOf_(id)))).map((ok, i) => (ok ? '' : CHECK_LABELS[i])).filter(String);
        need_(!miss.length, 'QRAP zatím nelze uzavřít. Chybí: ' + miss.join(', ') + '.');
      }
      q.closedAt = nowIso_();
      q.closedBy = me.name;
      text = '⑥ Uzavření QRAP podepsáno';
    }
    if (tx) commitTransition_(tx,q,text,before);
    else finish_(q,text);
  });
  const res = pack_(id);
  if (conflict) res.conflict = conflict;
  return res;
}

/** Fingerprint of one part of a QRAP as it is in the Sheet now (see FP_FIELDS). */
function fpQ_(q, part, acts) {
  const vals = FP_FIELDS[part].map(k => q[k]);
  if (part === 'opatreni') iaActions_(acts).forEach(a => vals.push(a.no, a.text, a.owner, a.ownerEmail, a.done));
  return fp_(vals);
}

/**
 * A short fingerprint of a list of values (FNV-1a). Timestamps count to the second, so a time read back from the Sheet
 * equals the one the page got right after saving. Index.html has the same function (fpOf) – keep them equal.
 */
function fp_(vals) {
  const s = vals.map(v => {
    v = String(v === null || v === undefined ? '' : v);
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) ? v.slice(0, 19) : v;
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
  checkFormSize_(a);
  if (a.no != null && a.no !== '') need_(num_(a.no, 'Číslo akce') > 0, 'Neplatné číslo akce.');
  need_(a.remove == null || typeof a.remove === 'boolean', 'Neplatná volba odebrání akce.');
  me_();
  prewarmHr_([a.owner]);
  let conflict = null;
  lock_(() => {
    const actor = me_();
    const q = find_(id);
    const rights = rights_(q.createdBy, q.pilots, actor);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts, effectsFor_(q));
    need_(isAnalysis_(q), 'Konečné akce lze zadávat a měnit jen během analýzy.');
    if (!a.no) requireRight_(rights.analyze);
    if (!a.no && a.token) {
      const key = operationKey_('action:' + id, a.token), previous = operation_(key);
      if (previous) {
        need_(previous.inputHash === digest_(a), 'Tato akce už byla odeslána s jinými údaji. Obnovte detail.');
        if (previous.state === 'done') {
          need_(acts.some(x => x.no === previous.action.no), 'Uložená akce chybí. Kontaktujte správce.');
          return;
        }
        if (acts.some(x => x.no === previous.action.no && x.created === previous.action.created && x.text === previous.action.text)) {
          const act = previous.action;
          finishOperation_(key, previous, q, '⑥ Nová konečná akce ' + act.no + ': ' + short_(act.text) + ' (' + act.owner + ', plán ' + act.due + ')', false);
          return;
        }
      }
    }
    let text;
    if (a.no) {
      const act = acts.filter(x => x.no === Number(a.no) && x.part === '⑥')[0];
      need_(act && !act.removed, 'Akce nenalezena (možná ji mezitím někdo odebral).');
      const completionOnly = Object.keys(a).every(k => ['no','done','note','evidence','_fp'].includes(k));
      requireRight_(rights.analyze || (completionOnly && actionOwner_(act.ownerEmail, actor)));
      if (a._fp !== fp_(FP_FIELDS.akce.map(k => act[k]))) { conflict = conflictOf_(q); return; }
      if (a.text !== undefined) { // A changed owner is reconciled after the action is saved.
        const fields = defActionFields_(a, q);
        need_((act.kind === 'STD') === (fields.kind === 'STD'), 'Aktualizace standardu se zakládá nebo mění v ⑤.');
        need_(!act.done || a.done === false || ['text','kind','ownerEmail','due'].every(k=>act[k] === fields[k]), 'Nejdříve znovu otevřete dokončenou akci.');
        Object.assign(act, fields);
        if (act.due && !act.dueFirst) act.dueFirst = act.due;
      }
      if (a.remove === true) {
        need_(act.kind !== 'STD' || q.std !== 'ANO', 'Povinnou aktualizaci standardu lze změnit v analýze ⑤.');
        act.removed = 'ANO';
      }
      if (a.evidence !== undefined) act.evidence = url_(a.evidence);
      if (a.note !== undefined) act.note = txt_(a.note, 500);
      if (a.done === true && !act.done) act.done = nowIso_();
      else if (typeof a.done === 'string' && a.done) {
        const completed = day_(a.done);
        need_(completed <= Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'), 'Datum hotovo nemůže být v budoucnosti.');
        need_(!act.created || completed >= Utilities.formatDate(new Date(act.created), tz_(), 'yyyy-MM-dd'), 'Datum hotovo nemůže být před založením akce.');
        act.done = dayIso_(a.done);
      } else if (a.done === false || a.done === '') act.done = '';
      update_(TAB.actions, act);
      text = '⑥ Akce ' + act.no + (act.removed ? ' odebrána' : act.done ? ' hotová' : ' upravena') + ': ' + short_(act.text);
    } else {
      const fields = defActionFields_(a, q);
      need_(fields.kind !== 'STD', 'Aktualizace standardu se zakládá v analýze ⑤.');
      fields.evidence = url_(a.evidence); fields.note = txt_(a.note, 500);
      const key = operationKey_('action:' + id, a.token);
      const hash = digest_(fields);
      let op = operation_(key);
      if (op) {
        need_(op.hash === hash, 'Tato akce už byla odeslána s jinými údaji. Obnovte detail.');
        if (op.state === 'done') return;
      } else {
        const act = Object.assign({qrapId:id, no:nextNo_(acts), part:'⑥', done:'', removed:'', created:nowIso_()}, fields);
        act.dueFirst = act.due;
        op = {hash:hash, inputHash:digest_(a), state:'pending', action:act};
        saveOperation_(key, op);
      }
      const act = op.action;
      const occupied = acts.find(x => x.no === act.no);
      if (occupied && (occupied.created !== act.created || occupied.text !== act.text || occupied.part !== '⑥')) {
        need_(!op.logs, 'Číslo obnovené akce je v konfliktu. Kontaktujte správce.');
        act.no = nextNo_(acts); saveOperation_(key, op);
      }
      if (!acts.some(x => x.no === act.no && x.part === '⑥')) insert_(TAB.actions, Object.assign({}, act));
      text = '⑥ Nová konečná akce ' + act.no + ': ' + short_(act.text) + ' (' + act.owner + ', plán ' + act.due + ')';
      finishOperation_(key, op, q, text, false);
      return;
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
    requireRight_(rights_(q.createdBy, q.pilots, me).effect);
    requireVersion_(q, p.version);
    const rows = effectsOf_(id);
    q.status = statusOf_(q, acts, rows);
    need_(q.status === 'OVĚŘENÍ', 'Efektivita se zapisuje ve stavu „Ověření 5 směn“ (všechny akce hotové).');
    const from = effFrom_(acts);
    const eff = effState_(rows, from);
    const slot = Number(p.slot);
    const date = day_(p.date);
    const shift = txt_(p.shift, 50);
    const result = oneOf_(p.result, EFF_RESULTS, 'Vyberte výsledek.');
    const todayStr = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
    need_(slot >= 1 && slot <= 5 && Math.floor(slot) === slot, 'Neplatný slot.');
    need_(/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= todayStr, 'Datum směny musí být vyplněné a nesmí být v budoucnosti.');
    const lastDone = defActions_(acts).map(a => a.done).filter(String).sort().pop();
    if (lastDone) {
      need_(date >= Utilities.formatDate(new Date(lastDone), tz_(), 'yyyy-MM-dd'),
        'Směna musí být až po dokončení konečných akcí – nejdříve ' + Utilities.formatDate(new Date(lastDone), tz_(), 'd. M. yyyy') + '.');
    }
    need_(cfg_().lists.shifts.indexOf(shift) >= 0, 'Vyberte směnu.');
    const current = eff.slots[slot - 1];
    need_(!current || current.result !== 'EFEKTIVNÍ' || (from && current.date < from), 'Efektivní slot už nelze změnit.');
    need_(result !== 'EFEKTIVNÍ' || !eff.slots.some((s, i) => s && i !== slot - 1 && s.result === 'EFEKTIVNÍ' &&
      s.date === date && s.shift === shift), 'Každý efektivní slot musí být jiná směna (datum + směna).');
    const values = { date: date, shift: shift, result: result, by: me.name, at: nowIso_() };
    if (current) { Object.assign(current, values); update_(TAB.effects, current); }
    else insert_(TAB.effects, Object.assign({ qrapId: id, round: eff.round, slot: slot }, values));
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
    requireRight_(rights_(q.createdBy, q.pilots, me).assess);
    q.status = statusOf_(q, actionsOf_(id), effectsFor_(q));
    need_(canAssess_(q), 'Zrušený QRAP nelze hodnotit.');
    const key = operationKey_('assessment:' + id, f.token);
    const row = { qrapId: id, at: nowIso_(), by: me.name };
    ['c1', 'c2', 'c3', 'c4', 'c5'].forEach(k => { row[k] = oneOf_(f[k], ASSESS_VALUES, 'Ohodnoťte všech 5 bodů (OK / NOK / N/A).'); });
    row.ojtWith = txt_(f.ojtWith, 200);
    row.feedback = txt_(f.feedback);
    row.feedbackType = f.feedbackType ? oneOf_(f.feedbackType, FEEDBACK_TYPES, 'Neplatný typ zpětné vazby.') : '';
    const hash = digest_([row.c1,row.c2,row.c3,row.c4,row.c5,row.ojtWith,row.feedback,row.feedbackType]);
    let op = operation_(key);
    if (op) {
      need_(op.hash === hash, 'Toto hodnocení už bylo odesláno s jinými údaji.');
      if (op.state === 'done') return;
    } else {
      const text = '⑦ Hodnocení QRQC (' + [row.c1,row.c2,row.c3,row.c4,row.c5].join(' / ') + ')';
      op = {state:'pending', hash:hash, row:row, logs:[{qrapId:id, at:row.at, by:me.email, text:text}]};
      saveOperation_(key, op);
    }
    // One append contains both the assessment and the receipt. A lost response can be retried after cache eviction.
    const sh = sheet_(TAB.assess), header = 'Klíč hodnocení';
    const headings = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    let col = headings.indexOf(header) + 1;
    if (!col) {
      col = headings.length + 1;
      if (col > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
      sh.getRange(1,col).setValue(header);
    }
    const prior = rowsBy_(TAB.assess, id);
    const written = prior.some(r => r.at === op.row.at && sh.getRange(r._row,col).getValue() === key);
    if (!written) {
      const data = rowOf_(head_(memo_(TAB.assess)), op.row);
      while (data.length < col) data.push('');
      data[col-1] = "'" + key;
      sh.appendRow(data);
      WROTE_ = true;
      delete MEMO_[TAB.assess];
    }
    operationHistory_(op);
    op.state = 'done';
    saveOperation_(key, op, false); // lock_() flushes before the lock is released
    BUMP_ = true; // an assessment adds history without modifying a signed QRAP
  });
  return pack_(id);
}

/** ① Replace one photo (kind 'WRONG' / 'RIGHT'). The upload runs outside the lock; a refused save removes it again. */
function setPhoto_(id, kind, full, thumb, expected) {
  id = idOf_(id);
  const caller = requireWriter_(true);
  kind = oneOf_(kind, PS_KINDS, 'Neplatný druh fotky.');
  const initial = find_(id);
  requireRight_(rights_(initial.createdBy, initial.pilots, caller).popis);
  rate_('photo', 40, 600);
  checkPhotoSizes_(full, thumb);
  const field = kind === 'RIGHT' ? 'photoRight' : 'photoWrong';
  const key = 'photo:' + me_().email + ':' + id + ':' + digest_([kind, full, thumb]);
  const files = [];
  const previous = operation_(key);
  if (previous && previous.state === 'done' && find_(id)[field] === previous.value) return pack_(id);
  const message = 'Fotku lze změnit jen do rozhodnutí ④ (potom jen po odemknutí manažerem).';
  need_(undecided_(initial), message);
  need_(expected === (initial[field] || '') || (previous && previous.state === 'pending' && initial[field] === previous.value), STALE_);
  try {
    const value = previous && previous.state !== 'done' ? previous.value : savePhotoPair_(full, thumb, files);
    need_(value, 'Chybí fotka.'); cacheThumb_(value, thumb);
    lock_(() => {
      const q = find_(id);
      requireRight_(rights_(q.createdBy, q.pilots, me_()).popis);
      need_(undecided_(q), message);
      let op = operation_(key);
      if (op && op.state === 'done' && q[field] === op.value) return;
      need_(expected === (q[field] || '') || (op && op.state === 'pending' && q[field] === op.value), STALE_);
      if (op && op.state === 'pending') need_(q[field] === op.old || q[field] === op.value, STALE_);
      if (!op || op.state === 'done') {
        op = {state:'pending', value:value, old:q[field]}; saveOperation_(key, op);
      }
      q[field] = op.value;
      finishOperation_(key, op, q, '① Nahrána fotka ' + (kind === 'RIGHT' ? 'požadovaného stavu' : 'skutečného stavu') + (op.old ? ' (předchozí soubory: ' + op.old + ')' : ''), false);
    });
  } catch (e) { trashUnreferenced_(files); throw e; }
  const attached = photoIds_(find_(id)[field]);
  trashUnreferenced_(files.filter(id => attached.indexOf(id) < 0));
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
  const q = find_(id); // AUDIT-M4: the check comes first – a cached preview is served only for this QRAP's own photos
  need_(photoIds_(q.photoWrong).concat(photoIds_(q.photoRight)).indexOf(fileId) >= 0, 'Fotka k tomuto problému nepatří.');
  return CacheService.getScriptCache().get('img:' + fileId) || dataUrl_(fileId);
}

/** Change history of one problem, newest first (reads only that QRAP's history rows). */
function shortageSheet_(create) {
  const ss = SS_ || (SS_ = SpreadsheetApp.getActiveSpreadsheet());
  let sh = ss.getSheetByName(TAB.shortages);
  if (create) {
    if (!sh) sh = ss.insertSheet(TAB.shortages);
    if (!sh.getLastRow()) {
      const labels = COLS[TAB.shortages].map(c => c[1]);
      sh.getRange(1,1,1,labels.length).setValues([labels]);
      delete MEMO_[TAB.shortages];
    }
  }
  return sh;
}
function shortagesFor_(id) {
  const sh = shortageSheet_(false);
  return sh && sh.getLastRow() ? rowsBy_(TAB.shortages,id) : [];
}
function newestShortage_(a,b) {
  const s = v => String(v == null ? '' : v); // an empty or hand-typed cell must never break the sort
  return s(b.when).localeCompare(s(a.when)) || s(b.created).localeCompare(s(a.created)) || (b._row || 0) - (a._row || 0);
}
/** "Zobrazit vše": every shortage of one QRAP, newest first – only this list, not the whole QRAP. */
function shortageList_(id) {
  me_();
  id = idOf_(id);
  rate_('shortage-list', 60, 60);
  find_(id); // an unknown number → "nebyl nalezen"
  return Object.assign({id:id}, shortageView_(shortagesFor_(id)));
}
function shortageView_(rows) {
  return {shortageCount:rows.length, shortages:rows.slice().sort(newestShortage_).map(r => only_(r,['when','partVersion','qty']))};
}

// The monitor only needs a count and the two latest entries. Scan in bounded blocks,
// keeping the limited preview even when an individual QRAP has a long shortage history.
function boardShortages_() {
  const previews = new Map(), sh = shortageSheet_(false);
  if (!sh || sh.getLastRow() < 2) return previews;
  const idx = head_(memo_(TAB.shortages)).idx;
  const columns = ['qrapId','when','partVersion','qty','created'].map(key => idx[key]);
  const left = Math.min(...columns), width = Math.max(...columns) - left + 1;
  const [idAt,timeAt,versionAt,qtyAt,createdAt] = columns.map(i => i-left);
  const last = sh.getLastRow(), batch = Math.max(1,Math.min(5000,Math.floor(60000/width)));
  for (let start=2; start<=last; start+=batch) {
    const values = sh.getRange(start,left+1,Math.min(batch,last-start+1),width).getValues();
    values.forEach((cells,i) => {
      const id = String(cells[idAt] || '');
      if (!id) return;
      if (!previews.has(id)) previews.set(id,{shortageCount:0,shortages:[]});
      const preview = previews.get(id);
      preview.shortageCount++;
      const row = {when:fromCell_('when',cells[timeAt]),created:fromCell_('created',cells[createdAt]),_row:start+i,
        partVersion:fromCell_('partVersion',cells[versionAt]),qty:fromCell_('qty',cells[qtyAt])};
      const recent = preview.shortages;
      if (recent.length < 2 || newestShortage_(row,recent[1]) < 0) {
        recent.push(row);
        recent.sort(newestShortage_);
        if (recent.length > 2) recent.pop();
      }
    });
  }
  for (const preview of previews.values()) preview.shortages = preview.shortages.map(r => only_(r,['when','partVersion','qty']));
  return previews;
}
function appendShortage_(id, input) {
  requireWriter_();
  id = idOf_(id);
  const f = obj_(input);
  checkFormSize_(f);
  const receipt = operationKey_('shortage', f.token);
  const instant = iso_(f.when);
  const when = instant ? instant.slice(0,16) + ':00.000Z' : '';
  const qty = num_(f.qty,'Počet vozíků/palet'), partVersion = txt_(f.partVersion,100);
  need_(when && partVersion && qty > 0, 'Vyplňte čas, verzi a kladný počet vozíků/palet.');
  rate_('shortage', 90, 600);
  lock_(() => {
    const q = find_(id);
    const saved = shortagesFor_(id).find(row => row.receipt === receipt);
    if (saved) {
      need_(saved.qty === qty && saved.when === when && saved.partVersion === partVersion,
        'Tato nedodávka už byla uložena s jinými údaji. Zkontrolujte záznam.');
      return;
    }
    need_(!q.closedAt && !q.cancelReason && isOpen_(q), 'Nedodávku lze přidat pouze k otevřenému QRAP.');
    requireVersion_(q, f.version);
    notFuture_(when, 'Čas nedodávky');
    // The form captures minutes. Kdy can include seconds on records created by older clients.
    need_(Math.floor(Date.parse(when)/60000) >= Math.floor(Date.parse(q.when)/60000), 'Čas nedodávky nemůže být před zjištěním problému.');
    shortageSheet_(true);
    // The event, idempotency receipt and audit identity are committed in the same row.
    insert_(TAB.shortages,{qrapId:id, when, partVersion, qty, created:nowIso_(), by:who_(), receipt});
    BUMP_ = true;
  });
  return pack_(id);
}

function history_(id) {
  me_();
  id = idOf_(id);
  const history = rowsBy_(TAB.log, id).slice().reverse().map(r => ({at:r.at, by:r.by, text:r.text}));
  const entries = shortagesFor_(id).map(r => ({at:r.created, by:r.by, text:'Přidána nedodávka: ' + r.partVersion + ', počet vozíků/palet: ' + r.qty + '.'}));
  return history.concat(entries).sort((a,b) => b.at.localeCompare(a.at));
}

/** Managers / admins, always with a reason: 'cancel' · 'reopen' · 'unlock' ①–④ (cancels the decision). */
function admin_(id, op, reason, version) {
  id = idOf_(id);
  need_(['cancel', 'reopen', 'unlock'].indexOf(op) >= 0, 'Neznámá operace.');
  lock_(() => {
    need_(me_().manager, 'Zrušit, znovu otevřít nebo odemknout QRAP může jen manažer nebo admin.');
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id), effectsFor_(q));
    const why = txt_(reason, 300);
    need_(why, 'Napište důvod.');
    const tx = transition_(q,op,version,why), before = q.status;
    if (tx.op) { commitTransition_(tx,q); return; }
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
    commitTransition_(tx,q,text,before);
  });
  return pack_(id);
}

/** "Zobrazit jako" – an admin sees the app as another role ('' = admin, '-' = user, 'MANAŽER'). */
function viewAs_(role) {
  const me = me_(true);
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
  need_(me_(true).admin, 'Správa je jen pro admina.');
  clearCache_();
  const c = cfg_();
  return {
    people: c.people.map(p => ({ version:digest_(p), row: p.row, name: p.name, email: p.email, role: p.role, area: p.area, active: p.active, mail: p.mail !== false })),
    lists: LISTS.map(l => ({ key: l[0], title: l[0] === 'alert' ? 'Kdo by měl být upozorněn?' : l[1], values: c.lists[l[0]], version:digest_(c.lists[l[0]]) })),
    settings: SETTINGS.map(x => ({ key: x[0], value: c.settings[x[0]], help: x[2] })),
    roles: ROLES,
    notif: notifAdmin_(c), // NOTIF: Správa → Notifikace
    boot: { configVersion:c.revision, people: activePeople_(c), lists: c.lists, cfg: publicSettings_(c.settings) }
  };
}

/** Add a person (no row) or change one (row = row number in Lidé). People are never deleted – set active false. */
function savePerson_(p) {
  p = obj_(p);
  const me = me_();
  need_(me.admin, 'Správa je jen pro admina.');
  lock_(() => {
    requireRight_(me_().admin);
    clearCache_();
    const people = cfg_().people;
    const v = [noComma_(txt_(p.name, 100)), txt_(p.email, 100).toLowerCase(), p.role ? oneOf_(p.role, ROLES, 'Neplatná role.') : '',
      txt_(p.area, 100), p.active === false ? 'NE' : 'ANO', p.mail === false ? 'NE' : 'ANO'];
    need_(typeof p.active === 'boolean' && typeof p.mail === 'boolean', 'Zkontrolujte volbu Aktivní a nastavení upozornění.');
    need_(v[0], 'Vyplňte jméno.');
    need_(EMAIL_RE.test(v[1]) && sameDomain_(v[1]), 'Vyplňte platný firemní e-mail.');
    const row = Number(p.row) || 0;
    need_(!people.some(x => x.email === v[1] && x.row !== row), 'Tento e-mail už v seznamu je.');
    // nobody locks themselves out: your own row keeps ADMIN, active and your e-mail (another admin can change it)
    const self = row && people.filter(x => x.row === row && x.email === me.email)[0];
    need_(!self || (v[2] === 'ADMIN' && v[4] === 'ANO' && v[1] === me.email),
      'Sami sobě nemůžete odebrat roli ADMIN, změnit e-mail ani se deaktivovat – tím byste přišli o Správu. Požádejte jiného admina.');
    if (row) {
      const original = people.find(x => x.row === row);
      need_(original && p.version === digest_(original), ADMIN_STALE_);
      need_(p.was && people.some(x => x.row === row && x.email === String(p.was).trim().toLowerCase()),
        'Seznam lidí se mezitím změnil. Obnovte stránku a upravte osobu znovu.');
    }
    const sh = sheet_(TAB.people);
    // Upgraded workbooks may still reject a newly added role under their old dropdown rule.
    if (['MONITOR','TEAM LEADER','SUPERVIZOR'].includes(v[2])) {
      const target = row || sh.getLastRow()+1;
      if (target > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(),1);
      sh.getRange(target,3).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLES,true).setAllowInvalid(false).build());
    }
    const mc = mailColOf_(sh); // the "E-maily" column (added when missing)
    // Role, Aktivní and E-maily have a dropdown check in the Sheet: written plain; text columns as text.
    const cells = [v[0] ? "'" + v[0] : '', "'" + v[1], v[2], v[3] ? "'" + v[3] : '', v[4]];
    if (row) {
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
  });
  return adminData_(); // AUDIT-H3: outside the lock
}

/** Replace one list of the tab Seznamy (one value per item, empty values and duplicates dropped). */
const ADMIN_STALE_ = 'Nastavení se mezitím změnilo. Znovu otevřete Správu a zkontrolujte aktuální hodnoty.';
function saveList_(key, values, version) {
  need_(me_().admin, 'Správa je jen pro admina.');
  const l = LISTS.filter(x => x[0] === key)[0];
  need_(l, 'Neznámý seznam.');
  const raw = Array.isArray(values) ? values : [];
  need_(raw.length <= LIMIT.ITEMS, 'Seznam je příliš dlouhý (max ' + LIMIT.ITEMS + ' položek).');
  const vals = raw.map(v => noComma_(txt_(v, 100))).filter((v, i, a) => v && a.indexOf(v) === i);
  need_(vals.length, 'Seznam nesmí být prázdný.');
  if (key === 'alert') need_(vals.includes(LOGISTICS_ROLE) && vals.includes(PRODUCTION_ROLE) && !vals.some(v => plain_(v) === 'SUPERVIZOR'),
    'V seznamu ponechte obě role: Supervizor logistiky a Supervizor výroby.');
  if (key === 'alert') need_(vals.every(v => !(v in Object.prototype)), 'Zvolte jiný název role.');
  lock_(() => {
    requireRight_(me_().admin);
    need_(version === digest_(readLists_()[key]), ADMIN_STALE_);
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
  });
  return adminData_(); // AUDIT-H3: outside the lock
}

/** Change settings (only the keys of the tab Nastavení, each checked). */
function saveSettings_(obj, originals) {
  obj = obj_(obj);
  need_(me_().admin, 'Správa je jen pro admina.');
  const numbers = ['LHUTA_OPATRENI_HODIN', 'ZOBRAZIT_UZAVRENE_DNI'];
  const clean = {};
  Object.keys(obj).forEach(k => {
    need_(SETTINGS.some(x => x[0] === k), 'Neznámé nastavení ' + k);
    let v = txt_(obj[k], k === 'LOGO_URL' ? 49000 : 300);
    if (numbers.indexOf(k) >= 0) {
      // upper limits: a typo like 99999 days would make every page load slow (all closed QRAPs on the board)
      const max = k === 'LHUTA_OPATRENI_HODIN' ? LIMIT.DEADLINE_H : LIMIT.CLOSED_DAYS;
      need_(/^\d+$/.test(v) && Number(v) > 0 && Number(v) <= max, k + ': zadejte celé číslo od 1 do ' + max + '.');
      v = Number(v);
    }
    if (k === 'EMAILY') v = oneOf_(v, ['ANO', 'NE'], 'EMAILY: ANO nebo NE.');
    if (k === 'NOTIFIKACE_TABULKA') need_(!v || sheetRef_(v), 'NOTIFIKACE_TABULKA: vložte odkaz na tabulku Google (https://docs.google.com/spreadsheets/d/…).'); // NOTIF
    if (k === 'NOTIFIKACE_APLIKACE') need_(v, 'NOTIFIKACE_APLIKACE nesmí být prázdné.'); // NOTIF
    if (k === 'ODKAZ_APLIKACE') need_(!v || deploymentUrl_(v), 'Vložte adresu nasazené aplikace z Google Apps Script (…/exec).');
    if (k === 'LOGO_URL') need_(!v || logoUrl_(v), 'Logo musí být obrázek HTTPS nebo rastrový obrázek v Base64.');
    if (k === 'NAZEV') need_(v, 'Název nesmí být prázdný.');
    clean[k] = v;
  });
  lock_(() => {
    requireRight_(me_().admin);
    const live = readSettings_();
    need_(originals && Object.keys(clean).every(k => Object.prototype.hasOwnProperty.call(originals,k) && String(originals[k]) === String(live[k])), ADMIN_STALE_);
    const sh = sheet_(TAB.settings);
    const rows = sh.getDataRange().getValues();
    const now = r => String(r[1] === undefined || r[1] === null ? '' : r[1]).trim(); // AUDIT-M2
    const changed = Object.keys(clean).filter(k => { const r = rows.filter(x => String(x[0]).trim() === k)[0]; return !r || now(r) !== String(clean[k]); });
    changed.forEach(k => { // AUDIT-M2: unchanged settings are not written again
      const i = rows.findIndex(r => String(r[0]).trim() === k);
      const val = typeof clean[k] === 'number' ? clean[k] : "'" + clean[k];
      if (i >= 0) sh.getRange(i + 1, 2).setValue(val);
      else sh.appendRow([k, val, (SETTINGS.filter(x => x[0] === k)[0] || [])[2] || '']);
    });
    WROTE_ = true;
    BUMP_ = true; // "uzavřené na tabuli (dní)" changes what the list contains
    log_('SPRÁVA', 'Nastavení: ' + (changed.map(k => k + ' = ' + (k === 'LOGO_URL' ? '(logo, ' + String(clean[k]).length + ' znaků)' : short_(clean[k])))
      .join(', ') || 'beze změny')); // AUDIT-M2: no 5 KB logo in every history line
  });
  return adminData_(); // AUDIT-H3: outside the lock
}

function publicSettings_(settings) {
  const o = {};
  PUBLIC_SETTINGS.forEach(k => { o[k] = settings[k]; });
  o.LOGO_URL = logoUrl_(o.LOGO_URL) ? o.LOGO_URL : '';
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
  if (!q.decision) return s3Missing_(q, iaActions_(acts)).length ? 'OPATŘENÍ' : 'ROZHODNUTÍ';
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
/** The day the last final action was finished: effective shifts count only from that day on. */
function effFrom_(acts) {
  const last = defActions_(acts).map(a => a.done).filter(String).sort().pop();
  return last ? Utilities.formatDate(new Date(last), tz_(), 'yyyy-MM-dd') : '';
}
function effState_(rows, from) {
  const bad = rows.filter(r => r.result === 'NEEFEKTIVNÍ');
  const round = 1 + bad.reduce((m, r) => Math.max(m, r.round), 0);
  const reopenAt = bad.reduce((m, r) => (r.at > m ? r.at : m), '');
  const slots = [1, 2, 3, 4, 5].map(n => rows.filter(r => r.round === round && r.slot === n).pop() || null);
  const ok = slots.filter(s => s && s.result === 'EFEKTIVNÍ' && !(from && s.date < from)).map(s => s.date + '|' + s.shift);
  return { round: round, reopenAt: reopenAt, slots: slots, okCount: ok.length,
    allOk: ok.length === 5 && ok.filter((x, i) => ok.indexOf(x) === i).length === 5 };
}

/** Closure conditions ("Uzavření QRAP schváleno"): one true / false per label in CHECK_LABELS. */
function checks_(q, acts, eff) {
  const defs = defActions_(acts);
  return [q.status === 'OVĚŘENÍ', rootOk_(q), defs.length > 0 && defs.every(a => a.done),
    q.std === 'NE' || (q.std === 'ANO' && !!q.stdRef && defs.some(a => a.kind === 'STD' && a.done)), eff.allOk, !!q.learned];
}

/** Recalculate ③ completeness and the status, save the row and queue the history. lock_() does flush + version. */
function finish_(q, text, isNew) {
  const acts = actionsOf_(q.id);
  const complete = !s3Missing_(q, iaActions_(acts)).length;
  if (complete && !q.s3Done) q.s3Done = nowIso_();
  if (!complete && !q.decision) q.s3Done = '';
  const before = q.status;
  q.status = statusOf_(q, acts, effectsFor_(q));
  q.updated = new Date(Math.max(Date.now(), (Date.parse(q.updated) || 0) + 1)).toISOString();
  q.updatedBy = who_();
  q.revision = Utilities.getUuid();
  ensureQrapColumns_();
  if (isNew) insert_(TAB.qraps, q); else update_(TAB.qraps, q);
  log_(q.id, text);
  if (!isNew && before !== q.status) log_(q.id, 'Stav: ' + q.status);
  BUMP_ = true;
  alertTouch_(q);
}

// =====================================================================================
// 5. PERMISSIONS AND WHAT THE PAGE GETS
//    Writes require the signed-in user's role or record assignment and the correct workflow stage.
// =====================================================================================

function me_(fresh) {
  if (ME_ && !fresh) return ME_;
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  // No e-mail = not signed in with a company account (or the app was opened to "Anyone"): refuse.
  if (!email) throw new AccountAccessError('Přihlaste se firemním účtem Google a otevřete aplikaci znovu.');
  if (!EMAIL_RE.test(email) || !sameDomain_(email)) throw new AccountAccessError('Použijte účet ve firemní doméně aplikace.');
  const people = readPeople_(); // cached once per execution; rights never come from the shared settings cache
  ME_AT_ = Date.now();
  const matches = people.filter(x => x.email === email);
  if (matches.length > 1 || matches.some(x => !x.active)) throw new AccountAccessError('Přístup účtu je pozastaven. Obraťte se na správce aplikace.');
  const p = matches[0];
  let role = p ? p.role : '';
  // Only explicit active roles grant privileges; recovery belongs to the trusted Sheet maintainers.
  const realAdmin = role === 'ADMIN';
  let viewAs = '';
  if (realAdmin) {
    viewAs = String(PropertiesService.getScriptProperties().getProperty('VIEW_AS:' + email) || '');
    if (viewAs) role = ROLES.includes(viewAs) ? viewAs : '';
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

function requireWriter_(fresh) {
  const actor = me_(fresh);
  need_(actor.role !== 'MONITOR', 'Tento účet slouží pouze k zobrazení tabule. Pro zápis použijte svůj firemní účet.');
  return actor;
}

// Notification recipients and the typed finder name never grant edit permission.
function rights_(creator, pilots, actor) {
  const write = actor.role !== 'MONITOR';
  const supervisor = actor.manager || actor.role === 'SUPERVIZOR';
  const lead = supervisor || actor.role === 'TEAM LEADER';
  const reporter = write && actor.email === String(creator || '').trim().toLowerCase();
  const analysis = supervisor || (write && pilotsOf_(pilots).some(p => p.email === actor.email));
  return {popis: reporter || supervisor, opatreni: reporter || lead, shifts: supervisor,
    decide: supervisor, analyze: analysis, pilots: supervisor, effect: analysis || lead,
    close: supervisor, assess: supervisor};
}
function rightsMask_(rights) { return bits_(CAN_KEYS.map(k => rights[k])); }
function requireRight_(allowed) {
  need_(allowed, 'K této změně nemáte oprávnění. Ověřte svůj účet a přidělení v QRAP.');
}
function actionOwner_(email, actor) {
  return actor.role !== 'MONITOR' && actor.email === String(email || '').trim().toLowerCase();
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
function pubQ_(q, acts, effs, rights) {
  const o = only_(q, Q_PUB);
  o.revision = recordRevision_(q);
  const eff = effState_(effs, effs.length ? effFrom_(acts) : '');
  const early = beforeDecision_(q);
  const can = [early, early, early, canDecide_(q), canAnalyze_(q), isAnalysis_(q), canEffect_(q), canClose_(q), canAssess_(q)];
  o.s3Missing = s3Missing_(q, iaActions_(acts));
  o.eff = [eff.round, eff.okCount, eff.allOk ? 1 : 0];
  o.ck = bits_(checks_(q, acts, eff));
  o.can = rights ? bits_(can) & rightsMask_(rights) : bits_(can);
  return o;
}

function bits_(flags) { return flags.reduce((m, on, i) => m | (on ? 1 << i : 0), 0); }

function pubA_(a, q, rights, actor) {
  const o = only_(a, A_PUB);
  const open = a.part === '⑥' && !a.removed && isAnalysis_(q);
  o.canEdit = open && (!rights || rights.analyze);
  o.canProgress = open && (!rights || rights.analyze || actionOwner_(a.ownerEmail, actor));
  o.canDone = o.canProgress && !a.done;
  return o;
}

function only_(row, keys) {
  const o = {};
  keys.forEach(k => { o[k] = row[k] === undefined ? '' : row[k]; });
  return o;
}

/** One problem with its actions (removed ones are left out), 5-shift checks and assessments. */
function pack_(id) {
  const actor = me_();
  const q = find_(id);
  const rights = rights_(q.createdBy, q.pilots, actor);
  const acts = actionsOf_(id);
  const effs = effectsOf_(id);
  q.status = statusOf_(q, acts, effs);
  return {
    qrap: Object.assign(pubQ_(q, acts, effs, rights), shortageView_(shortagesFor_(id))),
    actions: acts.filter(a => !a.removed).map(a => pubA_(a, q, rights, actor)),
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
  const shortages = boardShortages_();
  const out = { qraps: { k: QK, r: [] }, actions: { k: AK, r: [] }, effects: { k: E_PUB, r: [] }, assess: { k: S_PUB, r: [] }, all: !!all };
  table_(TAB.qraps).all.forEach(q => {
    const a = (acts.get(q.id) || []).sort((x, y) => x.no - y.no);
    const e = effs.get(q.id) || [];
    q.status = statusOf_(q, a, e);
    if (!all && !isOpen_(q) && new Date(q.closedAt || q.updated || q.created).getTime() < since) return;
    const p = Object.assign(pubQ_(q, a, e), shortages.get(q.id) || {shortageCount:0,shortages:[]});
    out.qraps.r.push(QK.map(k => p[k]).concat(q.createdBy)); // extra server-only value for per-viewer permissions
    a.forEach(x => { if (!x.removed) { const o = pubA_(x, q); out.actions.r.push(AK.map(k => o[k])); } });
    e.forEach(x => out.effects.r.push(E_PUB.map(k => x[k])));
    (assess.get(q.id) || []).forEach(x => out.assess.r.push(S_PUB.map(k => x[k])));
  });
  return out;
}

/** The list for one data version: from the cache if somebody already built it, else built once and cached. */
function listCached_(all, ver) {
  const key = (all ? 'listall:provoz1:' : 'list:provoz1:') + ver;
  const hit = cacheGetBig_(key);
  if (hit) return hit;
  
  // Prevents a cache stampede if multiple clients request data exactly when the TTL expires
  const lock = LockService.getScriptLock();
  if (lock.tryLock(2000)) { // AUDIT-M9: a page load waits at most 2 s behind a save, then builds the list itself
    try {
      const secondHit = cacheGetBig_(key);
      if (secondHit) return secondHit; // Another thread built it while we waited
      
      const data = listData_(all);
      cachePutBig_(key, data, 3600); // AUDIT-M6: an old list copy stays 1 h, not 6 h
      return data;
    } finally {
      lock.releaseLock();
    }
  } else {
    const late = cacheGetBig_(key); // Fallback if lock times out // CHANGED: the list built here is cached too –
    if (late) return late; // CHANGED: before, every call that timed out read all tabs again and threw the result away
    const data = listData_(all); // CHANGED
    cachePutBig_(key, data, 3600); // CHANGED // AUDIT-M6
    return data; // CHANGED
  }
}

// Share the expensive data read, then calculate controls for the actual viewer on a fresh copy.
function boardFor_(all, ver, actor, data = listCached_(all, ver)) {
  const rightsById = new Map();
  const id = QK.indexOf('id'), pilots = QK.indexOf('pilots'), can = QK.indexOf('can');
  const qraps = data.qraps.r.map(row => {
    const rights = rights_(row[QK.length], row[pilots], actor);
    rightsById.set(row[id], rights);
    const out = row.slice(0, QK.length);
    out[can] &= rightsMask_(rights);
    return out;
  });
  const qid = AK.indexOf('qrapId'), owner = AK.indexOf('ownerEmail'), edit = AK.indexOf('canEdit'), done = AK.indexOf('canDone');
  const actions = data.actions.r.map(row => {
    const out = row.slice(), rights = rightsById.get(row[qid]);
    out[edit] = !!(rights && row[edit] && rights.analyze);
    const progress = !!(rights && (rights.analyze || actionOwner_(row[owner], actor)));
    out[AK.indexOf('canProgress')] = !!(row[AK.indexOf('canProgress')] && progress);
    out[done] = !!(row[done] && progress);
    return out;
  });
  return Object.assign({}, data, {qraps:{k:QK,r:qraps}, actions:{k:AK,r:actions}});
}

// Page the full QRAP board on demand. Never send unrelated actions or the rest of the archive-sized dataset.
function allBoardPage_(input) {
  const actor = me_(), f = obj_(input), ver = dataVersion_();
  rate_('board-page',120,60);
  const size = num_(f.size, 'Počet řádků'), page = num_(f.page, 'Stránka'), days = num_(f.days || 0, 'Období');
  need_([10,25,50,100].includes(size) && page !== '' && [0,1,7,30].includes(days), 'Neplatné stránkování.');
  const zone = txt_(f.zone,100), query = plain_(txt_(f.query,200));
  const data = listCached_(true,ver);
  const index = Object.fromEntries(QK.map((key,i) => [key,i]));
  const searchable = ['id','what','whatOther','how','howOther','descWrong','descRight','zone','location','partVersion','materialNo','huNo','supplier','finder'].map(key => index[key]);
  const since = days ? Date.now() - days*86400000 : 0;
  const ordered = data.qraps.r.filter(row => row[index.status] !== 'ZRUŠENO' && (!zone || row[index.zone] === zone) &&
    (!days || Date.parse(row[index.when] || row[index.created]) >= since) &&
    (!query || plain_(searchable.map(i => row[i]).join(' ')).includes(query)));
  ordered.sort((a,b) => Number(a[index.status] === 'UZAVŘENO') - Number(b[index.status] === 'UZAVŘENO') ||
    String(b[index.created]).localeCompare(String(a[index.created])) || String(a[index.id]).localeCompare(String(b[index.id])));
  const actual = Math.min(page, Math.max(0,Math.ceil(ordered.length / size)-1));
  const rows = ordered.slice(actual*size,(actual+1)*size), ids = new Set(rows.map(row => row[index.id]));
  const subset = table => {
    const key = table.k.indexOf('qrapId');
    return {k:table.k, r:table.r.filter(row => ids.has(row[key]))};
  };
  const result = boardFor_(true,ver,actor,{qraps:{k:QK,r:rows}, actions:subset(data.actions), assess:subset(data.assess)});
  return Object.assign(result,{page:actual, total:ordered.length, ver:viewerVersion_(ver,actor), build:APP_BUILD});
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
    const t = { name: name, sh: null, idx: null, first: 0, last: 0, lastRow: null, range: null, all: null, by: Object.create(null), keys: null, objs: {} };
    t.sheet = () => t.sh || (t.sh = sheet_(name));
    MEMO_[name] = t;
  }
  return MEMO_[name];
}

// Accept original sheet headers when reading existing QRAPs or restoring an archive.
const QRAP_HEADER_ALIASES = {
  '② Vybraný supervizor výroby': '② Vybraní supervizoři výroby',
  '② Manažer APU': '② APU Manager',
  '② Supervizor SPU': '② APU Manager', // the column keeps its data after the rename
  '① Popis – ŠPATNÝ díl': '① Skutečný stav',
  '① Popis – DOBRÝ díl': '① Požadovaný stav',
  '① Foto ŠPATNĚ': '① Foto skutečného stavu',
  '① Foto SPRÁVNĚ': '① Foto požadovaného stavu',
};
function qrapHeader_(value) {
  const name = String(value).trim();
  return Object.prototype.hasOwnProperty.call(QRAP_HEADER_ALIASES, name) ? QRAP_HEADER_ALIASES[name] : name;
}

function setHead_(t, head) {
  const names = head.map(v => String(v).trim());
  const idx = {};
  COLS[t.name].forEach(c => {
    idx[c[0]] = names.indexOf(c[1]);
    if (idx[c[0]] < 0 && t.name === TAB.qraps) idx[c[0]] = names.findIndex(name => qrapHeader_(name) === c[1]);
    if (t.name === TAB.qraps && QRAP_EXTENSIONS.includes(c[0]) && idx[c[0]] < 0) return;
    need_(idx[c[0]] >= 0, 'V listu „' + t.name + '“ chybí sloupec „' + c[1] + '“. Spusťte menu eQRAP → Nastavit tabulku.');
  });
  const cols = COLS[t.name].map(c => idx[c[0]]).filter(i => i >= 0);
  t.idx = idx;
  t.first = Math.min.apply(null, cols);
  t.last = Math.max.apply(null, cols);
}

const QRAP_EXTENSIONS = ['revision', 'partVersion', 'productionSupervisor', 'apuManager', 'alertTestMode', 'alertTestRecipient'];
function ensureQrapColumns_() {
  const t = head_(memo_(TAB.qraps));
  const missing = QRAP_EXTENSIONS.filter(key => t.idx[key] < 0);
  if (!missing.length) return;
  const sh = t.sheet();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const labels = missing.map(key => COLS[TAB.qraps].find(col => col[0] === key)[1]).filter(label => !headers.includes(label));
  if (labels.length) {
    const extra = headers.length + labels.length - sh.getMaxColumns();
    if (extra > 0) sh.insertColumnsAfter(sh.getMaxColumns(), extra);
    sh.getRange(1, headers.length + 1, 1, labels.length).setValues([labels]);
  }
  setHead_(t, headers.concat(labels));
}
function head_(t) {
  if (!t.idx) setHead_(t, t.sheet().getRange('1:1').getValues()[0]);
  return t;
}

function lastRow_(t) {
  if (t.lastRow === null) { t.range = t.sheet().getDataRange(); t.lastRow = t.range.getLastRow(); }
  return t.lastRow;
}

const small_ = t => t.name !== OPS_TAB && lastRow_(t) * COLS[t.name].length <= PERF.FULL_READ_CELLS;

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
  cols.forEach(c => { o[c[0]] = t.idx[c[0]] >= 0 ? fromCell_(c[0], r[t.idx[c[0]]]) : ''; });
  t.objs[rowNum] = o;
  return o;
}

function fromCell_(key, v) {
  if (v == null) return '';
  if (key === 'notified') return [...new Set(list_(v).map(alertRole_))].join(', ');
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
    if (t.idx[c[0]] >= 0) row[t.idx[c[0]]] = toCell_(c[0], o[c[0]]);
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
  const columns = COLS[name].map(([key]) => ({i:t.idx[key], value:toCell_(key,o[key])})).filter(col => col.i >= 0).sort((a,b) => a.i-b.i);
  for (let start = 0; start < columns.length;) {
    let end = start + 1;
    while (end < columns.length && columns[end].i === columns[end-1].i + 1) end++;
    const values = columns.slice(start, end).map(c => c.value);
    t.sheet().getRange(o._row, columns[start].i + 1, 1, values.length).setValues([values]);
    WROTE_ = true;
    start = end;
  }
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

/** A new QRAP: remember that it has no rows in the other tabs yet, so nothing is read for it.
 *  SPEED: Historie and Nedodávky too – before, every new QRAP read the whole history tab just to find none. */
function seedNew_(id) {
  [TAB.actions, TAB.effects, TAB.assess, TAB.log, TAB.shortages].forEach(name => { const t = memo_(name); if (!t.all) t.by[id] = []; });
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
  // a number is never used twice, also when the newest QRAP left the tab (archive, deleted row)
  const props = PropertiesService.getScriptProperties();
  const next = Math.max(max, Number(props.getProperty('SEQ:' + prefix)) || 0) + 1;
  props.setProperty('SEQ:' + prefix, String(next));
  return prefix + ('00' + next).slice(-Math.max(3, String(next).length));
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
  Object.assign(t, { lastRow: null, range: null, all: null, by: Object.create(null), keys: null, objs: {} }); // read fresh if needed later
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
  ALERT_STORE_ = null;
  LOG_ = [];
  WROTE_ = false;
  BUMP_ = false;
  IN_LOCK_ = true;
  let ok = false;
  let result;
  let flushErr = null;
  try {
    // roles may have changed while this operation waited for the lock – re-read unless they were read just now
    requireWriter_(!ME_ || Date.now() - ME_AT_ > 3000);
    result = fn();
    flushLog_();
    // The business record remains the recovery source if a local journal write fails.
    // SPEED: a save from the page leaves the alert snapshot to the page's background call (apiMail → syncAlerts_),
    // which runs right after it; the 5-minute check and the refresh sweep catch it if the page was closed.
    // Runs without a page (menu, triggers) still snapshot here.
    try { if (!DEFER_MAIL_) Object.keys(ALERT_DIRTY_).forEach(id => captureAlerts_(find_(id))); }
    catch (e) { ALERT_WARNING_ = 'QRAP je uložený. Upozornění čekají na další kontrolu.'; console.warn('Alert capture: ' + e.message); }
    ok = true;
  } finally {
    IN_LOCK_ = false;
    if (!ok) { OUTBOX_ = []; LOG_ = []; } // the save failed → no e-mails, no history line
    try { if (WROTE_) SpreadsheetApp.flush(); } catch (e) { flushErr = e; console.error('flush: ' + ((e && e.stack) || e)); }
    // CHANGED: the list is no longer rebuilt here. That read all four data tabs in full on EVERY save while every other
    // CHANGED: save waited for the lock (and listCached_ took the same lock again). The next refresh builds it once.
    try { if (BUMP_ || WROTE_) bumpVersion_(); } catch (e) { console.error('version: ' + e); } // also a half-done save // CHANGED
    lock.releaseLock();
  }
  if (ok && flushErr) { OUTBOX_ = []; throw flushErr; } // the page must not show "Uloženo" for a save that was not written
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

function bumpVersion_() {
  const newVer = Utilities.getUuid();
  CacheService.getScriptCache().put('ver', newVer, PERF.CACHE_TTL);
  return newVer;
}

/** Stores a big value: JSON → gzip → base64, split into entries under the 100 KB CacheService limit. */
function cachePutBig_(key, value, ttl) { // AUDIT-H2: + ttl
  try {
    const zipped = Utilities.gzip(Utilities.newBlob(JSON.stringify(value), 'application/json'));
    const b64 = Utilities.base64Encode(zipped.getBytes());
    const n = Math.ceil(b64.length / PERF.CHUNK);
    if (n > PERF.MAX_CHUNKS) return;
    const entries = {};
    for (let i = 0; i < n; i++) entries[key + ':' + i] = b64.slice(i * PERF.CHUNK, (i + 1) * PERF.CHUNK);
    entries[key] = String(n);
    CacheService.getScriptCache().putAll(entries, ttl || PERF.CACHE_TTL);
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
  const key = 'rate:' + bucket + ':' + me_().email + ':' + Math.floor(Date.now() / (seconds * 1000)); // a fixed window
  const lock = LockService.getUserLock();
  need_(lock.tryLock(1500), 'Probíhá jiný požadavek. Zkuste to prosím za chvíli.');
  try {
    const n = Number(cache.get(key)) || 0;
    need_(n < max, 'Příliš mnoho požadavků za krátkou dobu. Zkuste to prosím za chvíli.');
    cache.put(key, String(n + 1), seconds);
  } finally { lock.releaseLock(); }
}

/**
 * Settings, lists and people – read from the Sheet, remembered for 30 minutes. A change in Správa, a hand edit in the
 * Sheet (onEdit) or the menu "Použít změny v nastavení hned" clears it at once.
 */
function cfg_() {
  if (CFG_) return CFG_;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CFG_KEY);
  if (hit) {
    CFG_ = hit === 'chunked' ? cacheGetBig_(CFG_KEY + ':large') : JSON.parse(hit);
    if (CFG_) return CFG_;
  }
  CFG_ = { revision: Utilities.getUuid(), settings: readSettings_(), lists: readLists_(), people: readPeople_(), notif: readNotif_() }; // NOTIF: + notif
  try { cache.put(CFG_KEY, JSON.stringify(CFG_), 1800); } catch (e) {
    cachePutBig_(CFG_KEY + ':large', CFG_, 1800);
    cache.put(CFG_KEY, 'chunked', 1800);
  }
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
  out.alert = [...new Set(out.alert.map(alertRole_))];
  if (!out.alert.includes(LOGISTICS_ROLE)) out.alert.push(LOGISTICS_ROLE);
  if (!out.alert.includes(PRODUCTION_ROLE)) out.alert.splice(out.alert.indexOf(LOGISTICS_ROLE) + 1, 0, PRODUCTION_ROLE);
  return out;
}

function readPeople_() {
  const values = sheet_(TAB.people).getDataRange().getValues();
  const mi = mailCol_(values[0]) - 1; // no "E-maily" column (-1): everybody gets e-mails, as before
  return values.slice(1)
    .map((r, i) => ({
      row: i + 2,
      name: noComma_(String(r[0]).trim()),
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
  if (['MANAZER', 'MANAGER', 'VEDOUCI'].includes(r)) return 'MANAŽER';
  if (['SUPERVIZOR', 'SUPERVISOR', 'MISTR'].includes(r)) return 'SUPERVIZOR';
  if (['TEAM LEADER', 'TEAM LEAD', 'LEADER', 'LEAD', 'TL'].includes(r)) return 'TEAM LEADER';
  if (r === 'MONITOR') return 'MONITOR';
  if (['ADMIN', 'SPRAVCE'].indexOf(r) >= 0) return 'ADMIN';
  return '';
}

// ---- small value helpers
/** List items must not contain a comma (chosen values are stored comma-separated): a comma becomes " / ". */
function noComma_(v) { return String(v || '').replace(/\s*,\s*/g, ' / ').trim(); }
function plain_(v) { return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase(); }
function need_(ok, msg) { if (!ok) throw new UserError(msg); }
function txt_(v, max) {
  if (v == null) return '';
  need_(typeof v === 'string' || typeof v === 'number', 'Pole musí obsahovat text nebo číslo.');
  const text = String(v).trim();
  need_(text.length <= (max || 2000), 'Zadaná hodnota je příliš dlouhá (max. ' + (max || 2000) + ' znaků).');
  need_(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), 'Text obsahuje nepovolené řídicí znaky.');
  return text;
}
function short_(s) { s = String(s || ''); return s.length > 70 ? s.slice(0, 67) + '…' : s; }
function list_(s) { return String(s || '').split(',').map(x => x.trim()).filter(String); }
function multi_(v) {
  const values = Array.isArray(v) ? v : list_(txt_(v, 20000));
  need_(values.length <= LIMIT.ITEMS, 'Příliš mnoho položek.');
  return [...new Set(values.map(x => txt_(x, 100)).filter(Boolean))].join(', ');
}
function onlyFrom_(v, allowed) { return pickMany_(v, allowed, '', 'Informované směny'); }
function isOther_(v) { return plain_(v) === 'JINE'; }
function yn_(v) { v = plain_(v); return v === 'ANO' || v === 'NE' ? v : ''; }
function nowIso_() { return new Date().toISOString(); }
function tz_() { return Session.getScriptTimeZone() || 'Europe/Prague'; }
/** Anything that is not a plain object becomes {} – the browser can send any JSON value. */
function obj_(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
/** A list of rows from the form, at most LIMIT.ROWS of them. */
function rowsIn_(v) {
  need_(v == null || Array.isArray(v), 'Neplatný seznam řádků.');
  const a = v || [];
  need_(a.length <= LIMIT.ROWS, 'Příliš mnoho řádků (max ' + LIMIT.ROWS + ').');
  need_(a.every(r => r && typeof r === 'object' && !Array.isArray(r)), 'Neplatný řádek formuláře.');
  return a;
}
const STALE_ = 'QRAP se mezitím změnil nebo máte otevřenou starší verzi. Obnovte stránku, zkontrolujte údaje a zkuste to znovu.';
function recordRevision_(q) { return q.revision || q.updated || ''; }
function requireVersion_(q, version) { need_(typeof version === 'string' && version === recordRevision_(q), STALE_); }
function idOf_(v) {
  const id = txt_(v, 41);
  need_(/^Q-[A-Za-z0-9][A-Za-z0-9_-]{0,37}$/.test(id), 'Neplatné číslo QRAP.');
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
  need_((typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))), (label || 'Počet') + ' musí být celé nezáporné číslo.');
  const n = Number(v);
  need_(isFinite(n) && n >= 0 && n <= 1e7 && Math.round(n) === n, (label || 'Počet') + ' musí být celé číslo od 0 do 10 000 000.');
  return n;
}

function iso_(v) {
  if (v == null || v === '') return '';
  need_(typeof v === 'string' && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v), 'Neplatné datum nebo čas.');
  day_(v.slice(0, 10));
  const d = new Date(v);
  need_(!isNaN(d.getTime()), 'Neplatné datum nebo čas.');
  return d.toISOString();
}

function day_(v) {
  v = txt_(v, 10);
  need_(/^\d{4}-\d{2}-\d{2}$/.test(v), 'Vyplňte platné datum.');
  const parts = v.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  need_(parts[0] >= 1000 && d.getUTCFullYear() === parts[0] && d.getUTCMonth() === parts[1] - 1 && d.getUTCDate() === parts[2], 'Vyplňte platné kalendářní datum.');
  return v;
}

/** A day "2026-10-05" stored as a time at noon, so it shows the same day in every time zone. */
function dayIso_(v) { const p = day_(v).split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12).toISOString(); }

function url_(v) {
  v = txt_(v, 500);
  if (!v) return '';
  const match = /^https?:\/\/([^/?#\s\\]+)(?:[/?#][^\s\\<>"]*)?$/i.exec(v);
  const host = match && /^(\[[\da-f:.]+\]|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(match[1]);
  need_(host && (!host[2] || (Number(host[2]) > 0 && Number(host[2]) <= 65535)), 'Odkaz na důkaz musí mít platnou adresu http:// nebo https:// bez přihlašovacích údajů.');
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

/** The picker submits an HR email; keep historical names/older clients readable. */
function finderName_(value, previous) {
  const raw = txt_(value, 254);
  if (!raw || (previous && raw === previous)) return raw;
  need_(raw.includes('@'), 'JMÉNO: vyberte osobu z nabízených výsledků HR.');
  const email = raw.toLowerCase();
  need_(EMAIL_RE.test(email), 'JMÉNO: vyberte jednu osobu z HR.');
  const person = verifiedHrPerson_(email);
  need_(person, 'JMÉNO: tato osoba není v HR. Vyberte ji znovu ze seznamu.');
  return person.n;
}

/**
 * ① ② from the form, checked like the paper form and against the lists in the Sheet.
 * cur = the QRAP as it is now ({} for a new one). Old QRAPs keep their KDE – lokace, Kde vzniklo, NOK situace,
 * photo exception and extra e-mails (no longer asked).
 */
function applyProductionSelection_(q, value, previous) {
  q.productionSupervisor = q.apuManager = '';
  if (!list_(q.notified).includes(PRODUCTION_ROLE)) return;
  const supervisors = emailList_(value);
  need_(supervisors.length > 0 && supervisors.length <= 10 &&
    supervisors.every(email => EMAIL_RE.test(email) && sameDomain_(email)),
    'Vyberte ze seznamu HR jednoho až deset supervizorů výroby.');
  const existing = emailList_(previous.productionSupervisor);
  const added = supervisors.filter(email => !existing.includes(email));
  // Resolve the one shared SPU recipient under the write lock. Form data cannot override it.
  const configured = readNotif_().spuSupervisor;
  const unchanged = supervisors.length === existing.length && !added.length;
  const spu = configured || (unchanged ? previous.apuManager : '');
  need_(spu, 'Správce musí v části Správa → Notifikace vybrat supervizora SPU.');
  requirePushRecipients_(added.concat(spu !== previous.apuManager ? [spu] : []));
  q.productionSupervisor = supervisors.join(', ');
  // This column previously held the APU recipient. Keep the stored representation compatible.
  q.apuManager = spu;
}
function popisFrom_(f, cur) {
  const L = cfg_().lists;
  const q = {
    safety: yn_(f.safety),
    how: pick_(f.how, L.how, cur.how, 'JAK byl objeven?'), howOther: txt_(f.howOther, 200),
    what: pick_(f.what, L.problems, cur.what, 'CO je za problém?'), whatOther: txt_(f.whatOther, 200),
    when: iso_(f.when), zone: pick_(f.zone, L.zones, cur.zone, 'KDE?'),
    nokSituation: f.qtyNA === 'ANO' || f.qtyNA === true ? 'ANO' : '',
    qty: num_(f.qty, 'Kolik špatných/nedokončených dílů'), unit: pick_(f.unit, L.units, cur.unit, 'Jednotka'),
    repeat7: yn_(f.repeat7), finder: finderName_(f.finder, cur.finder),
    descWrong: txt_(f.descWrong, 1000), descRight: txt_(f.descRight, 1000),
    partVersion: txt_(f.partVersion, 100),
    notified: pickMany_(alertRoles_(f.notified), L.alert, cur.notified, '② Kdo by měl být upozorněn?'), notifiedOther: ''
  };
  if (q.nokSituation) { q.qty = ''; q.unit = ''; } // KOLIK = N/A
  if (!isOther_(q.how)) q.howOther = '';
  if (!isOther_(q.what)) q.whatOther = '';
  if (!list_(q.notified).some(isOther_)) q.notifiedOther = '';
  else q.notifiedOther = pilotsCell_(pilotsFrom_(f.notifiedOther));
  const miss = [];
  if (!q.safety) miss.push('SAFETY');
  if (!q.what) miss.push('CO je za problém?'); else if (isOther_(q.what) && !q.whatOther) miss.push('CO – jiné');
  if (!q.how) miss.push('JAK byl objeven?'); else if (isOther_(q.how) && !q.howOther) miss.push('JAK – jiné');
  if (!q.when) miss.push('KDY?');
  if (!q.zone) miss.push('KDE?');
  if (q.qty === '' && !q.nokSituation) miss.push('Kolik špatných/nedokončených dílů? (nebo N/A)');
  if (!q.repeat7) miss.push('Stejný problém v posledních 7 dnech?');
  if (!q.finder) miss.push('JMÉNO (kdo vyplňuje formulář)');
  if (!q.descWrong) miss.push('Co je špatně?');
  if (!q.notified) miss.push('② Kdo by měl být upozorněn?');
  else if (list_(q.notified).some(isOther_) && !q.notifiedOther) miss.push('② Jiné – kdo');
  need_(!miss.length, 'Vyplňte prosím: ' + miss.join(', ') + '.');
  notFuture_(q.when, 'KDY');
  need_(!(q.qty > 0) || q.unit, 'Vyberte jednotku (Kolik špatných/nedokončených dílů).');
  return q;
}

/** CO je za problém (the "jiné" text when chosen). */
function what_(q) { return isOther_(q.what) && q.whatOther ? q.whatOther : q.what; }

/** A short title for lists, e-mails and the history: CO + the description of the wrong part. */
function title_(q) { return what_(q) + (q.descWrong ? ' – ' + q.descWrong : ''); }

/** ③ answers from the form (the actions are checked by iaFields_). Only the risk answer is required. */
function opatreniFrom_(f, when) {
  const s = {
    risk: yn_(f.risk), checked: num_(f.checked, 'Přetříděno'), wrong: num_(f.wrong, 'Špatné kusy'),
    checkRunning: '', restoredAt: iso_(f.restoredAt)
  };
  need_(s.risk, 'Odpovězte: Hrozí riziko u již naskladněného nebo expedovaného zboží a je nutné třídění (sorting)?');
  if (s.risk !== 'ANO') Object.assign(s, { checked: '', wrong: '' });
  need_(s.wrong === '' || s.checked === '' || s.wrong <= s.checked, '„Špatné kusy“ nemůže být víc než „Přetříděno“.');
  notFuture_(s.restoredAt, 'Čas restartu');
  need_(!s.restoredAt || s.restoredAt >= when, 'Čas restartu nemůže být před KDY.');
  return s;
}

/** One ③ immediate action as on the paper: Okamžitá opatření (what), Kdo, Čas (empty = still running). */
function iaFields_(r, when, original) {
  const value = txt_(r.owner, 254);
  const a = {kind: txt_(r.kind, 100), text: txt_(r.text, 500), done: iso_(r.done)};
  need_(a.text && value, 'Vyplňte okamžité opatření a vyberte osobu v poli Kdo.');
  if (original && value === (original.ownerEmail || original.owner)) {
    a.owner = original.owner;
    a.ownerEmail = original.ownerEmail || '';
  } else {
    const person = verifiedHrPerson_(value);
    need_(person, 'Kdo: vyberte osobu ze seznamu HR.');
    a.owner = person.n;
    a.ownerEmail = person.e;
  }
  notFuture_(a.done, 'Čas opatření');
  need_(!a.done || a.done >= when, 'Čas opatření nemůže být před KDY.');
  return a;
}

/** Saves the ③ action rows: new ones are added, changed ones updated, removed ones marked (never deleted). */
function syncIa_(id, rows) {
  const currentRows = iaActions_(actionsOf_(id));
  const existing = new Map(currentRows.map(a => [a.no, a]));
  const seen = new Set();
  rows.forEach(r => {
    if (!r.no) { need_(!r.remove, 'Vyberte existující opatření.'); return; }
    const n = num_(r.no, 'Číslo opatření');
    need_(existing.has(n) && !seen.has(n), 'Opatření se mezitím změnilo. Obnovte formulář.');
    seen.add(n);
  });
  const removing = new Set(rows.filter(r => r.remove).map(r => Number(r.no)));
  need_(currentRows.some(r => !removing.has(r.no)) || rows.some(r => !r.no && !r.remove),
    'Alespoň jedno okamžité opatření musí zůstat vyplněné.');
  const added = [];
  let no = nextNo_(actionsOf_(id));
  rows.forEach(r => {
    const cur = r.no ? existing.get(Number(r.no)) : null;
    if (cur) {
      if (r.remove) cur.removed = 'ANO'; else Object.assign(cur, { kind: r.kind, text: r.text, owner: r.owner, ownerEmail: r.ownerEmail, done: r.done });
      update_(TAB.actions, cur);
    } else if (!r.remove) {
      added.push({ qrapId: id, no: no++, part: '③', kind: r.kind, text: r.text, owner: r.owner, ownerEmail: r.ownerEmail, done: r.done, created: nowIso_() });
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
      // SPEED: each candidate is checked on its own (verifiedHrPerson_) – before, the whole HR directory was read
      // again from the other file inside the save lock. Same rule as orgPeople_: in HR, with OSČ, not switched off.
      const off = disabledRecipients_();
      const eligible = email => { const p = verifiedHrPerson_(email); return !!(p && p.o !== '' && !off.has(email)); };
      const first = pilotsOf_(q.pilots).find(p => eligible(p.email));
      const pilot = first ? first.email : me_().email;
      need_(eligible(pilot), 'Pro aktualizaci standardu nejdřív vyberte dostupného pilota z HR.');
      const p = cfg_().people.filter(x => x.email === pilot)[0];
      const due = Utilities.formatDate(new Date(Date.now() + 14 * 864e5), tz_(), 'yyyy-MM-dd');
      insert_(TAB.actions, { qrapId: q.id, no: nextNo_(acts), part: '⑥', kind: 'STD', text: text,
        owner: p ? p.name : (first && first.name) || pilot, ownerEmail: pilot, due: due, dueFirst: due, created: nowIso_() });
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
  if (!a.no && f.due) need_(f.due >= Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'), 'Plán nové akce nesmí být v minulosti.');
  need_(f.text && f.kind && f.owner && f.due, 'Vyplňte konečnou akci, krok 5 Proč, pilota a plán.');
  const m = /^([ON])([1-5])$/.exec(f.kind);
  need_(f.kind === 'STD' || (m && q[m[1].toLowerCase() + m[2]]), 'Akce musí odstraňovat vyplněný krok 5 Proč.');
  const selected = pilotsFrom_(a.owner);
  need_(selected.length === 1, 'Vyberte jednoho vlastníka akce z HR.');
  f.owner = selected[0].name;
  f.ownerEmail = selected[0].email;
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
  let bytes;
  try { bytes = Utilities.base64Decode(m[2]); } catch (e) { throw new UserError('Fotku se nepodařilo přečíst. Vyberte obrázek znovu.'); }
  need_(bytes.length <= LIMIT.PHOTO_BYTES, 'Fotka je příliš velká (max 5 MB).');
  need_(imageType_(bytes) === m[1], 'Soubor není obrázek nebo neodpovídá svému typu.');
  const size = imageSize_(bytes,m[1]);
  need_(size && size.every(n => n > 0 && n <= 8192) && size[0]*size[1] <= 16000000, 'Fotka má neplatné nebo příliš velké rozměry. Zkuste ji v aplikaci vybrat znovu.');
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

function imageSize_(bytes, type) {
  const u = i => bytes[i] & 255;
  const be = i => u(i)*256 + u(i+1), le = i => u(i)+256*u(i+1);
  const tag = (start,word) => [...word].every((c,i) => u(start+i) === c.charCodeAt(0));
  if (type === 'png' && bytes.length >= 33 && tag(12,'IHDR') && be(4) === 0x0d0a && be(6) === 0x1a0a) {
    return [be(16)*65536+be(18),be(20)*65536+be(22)];
  }
  if (type === 'gif' && bytes.length >= 13 && (tag(0,'GIF87a') || tag(0,'GIF89a'))) return [le(6),le(8)];
  if (type === 'webp' && bytes.length >= 30) {
    if (tag(12,'VP8X')) return [1+le(24)+u(26)*65536,1+le(27)+u(29)*65536];
    if (tag(12,'VP8 ') && be(23) === 0x9d01 && u(25) === 0x2a) return [le(26)&16383,le(28)&16383];
    if (tag(12,'VP8L') && u(20) === 0x2f) return [1+(le(21)&16383),1+((u(22)>>6)+(u(23)<<2)+((u(24)&15)<<10))];
  }
  if (type === 'jpeg') {
    let i = 2;
    while (i+4 < bytes.length && u(i) === 255) {
      while (i<bytes.length && u(i) === 255) i++;
      const marker = u(i++), length = be(i);
      if (marker === 0xda || marker === 0xd9 || length < 2 || i+length > bytes.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        return length>=8 ? [be(i+5),be(i+3)] : null;
      }
      i+=length;
    }
  }
  return null;
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
  const start = Date.now();
  const MAX_MS = 25000; // Ochrana proti vypršení času (timeoutu) skriptu
  for (let i = 0; i < ids.length; i++) {
    if (Date.now() - start > MAX_MS) {
      console.warn('trash_ překročil časový limit. Přeskočeno ' + (ids.length - i) + ' souborů.');
      break; // Raději necháme soubory opuštěné (orphaned), než abychom shodili běh aplikace uživateli
    }
    try { DriveApp.getFileById(ids[i]).setTrashed(true); } catch (e) { console.warn('trash ' + ids[i] + ': ' + e.message); }
  }
}

// =====================================================================================
// 7. NOTIFICATIONS – rows in the notification sheet ("Můj plán"), no e-mails // NOTIF: this whole section is new
// =====================================================================================

/**
 * Creation/role recipients are configured in Správa. HR selections in Jiné, pilots and action owners
 * also receive an alert. One row per QRAP/person: PUSH for 5 hours after a new responsibility,
 * then aktivni until the QRAP closes/cancels. Normal and SAFETY rows live in separate tabs.
 * Alerty_stav preserves recipient snapshots and expiry times. The five-minute worker reconciles
 * committed QRAPs, so retries survive cache loss and never dequeue messages before remote writes.
 */
const NOTIF = {
  TAB: 'Notifikace', CREATE: 'Po vytvoření QRAP', ROLE: 'Kdo byl upozorněn: ',
  STATUS: 'aktivni', TYPE: 'QRAP alert', TRIES: 30, OSC_KEY: 'osc:v2', ORG_KEY: 'org:search3',
  // the tabs of the notification file: normal rows, rows of a QRAP with SAFETY = ANO, and people (E-mail → osč)
  TABS: { normal: 'Alerts_eQRAP Log', safety: 'Alerts_eQRAP Log_Safety' }, OSC_TAB: 'HR_AllApps_OrgChart',
  HEAD: { osc: 'OSC', app: 'Aplikace', text: 'Text Alertu', due: 'Termín', url: 'URL', ctx: 'Kontext', status: 'Status',
    type: 'Typ Akce', why: 'Důvod odeslání' }
};
let NOTIF_T_ = null; // per request: the opened notification sheet
let NOTIF_SS_ = null; // per request: the notification file itself (also holds the HR org chart)

/** The lists of the tab Notifikace (empty lists when the tab does not exist yet: nobody is notified). */
function readNotif_() {
  const out = {create: [], roles: Object.create(null), spuSupervisor:'', spuNeedsSelection:false, testMode:'NORMAL', testRecipient:''};
  const sh = (SS_ || (SS_ = SpreadsheetApp.getActiveSpreadsheet())).getSheetByName(NOTIF.TAB);
  if (!sh) return out;
  const priorManagers = new Set(), spuValues = new Set();
  let explicit = false;
  sh.getDataRange().getValues().slice(1).forEach(r => {
    const k = String(r[0]).trim(), v = emailList_(r[1]);
    if (k === 'Testovací režim') out.testMode = ['NORMAL','PAUSED','ONE'].includes(String(r[1])) ? String(r[1]) : 'PAUSED';
    else if (k === 'Testovací příjemce') out.testRecipient = v.length === 1 ? v[0] : '';
    else if (k === NOTIF.CREATE) out.create = v;
    else if (k === SPU_RECIPIENT || k === SPU_RECIPIENT_OLD) {
      explicit = true;
      v.forEach(email => spuValues.add(email));
    } else if (k.startsWith(ROUTE_PREFIX)) {
      if (v.length === 1) priorManagers.add(v[0]);
    } else if (k.startsWith(NOTIF.ROLE)) {
      const role = alertRole_(k.slice(NOTIF.ROLE.length).trim());
      if (!(role in Object.prototype) && role !== PRODUCTION_ROLE) out.roles[role] = [...new Set((out.roles[role] || []).concat(v))];
    }
  });
  // One shared value from the previous pair settings can seed the single field.
  // Several different values require an explicit admin selection.
  const values = [...(explicit ? spuValues : priorManagers)];
  out.spuSupervisor = values.length === 1 && EMAIL_RE.test(values[0]) ? values[0] : '';
  out.spuNeedsSelection = values.length > 1 || (values.length === 1 && !out.spuSupervisor);
  return out;
}

/** E-mails from a cell or a text area (one per line, or separated by commas / spaces), lower case, no duplicates. */
function emailList_(v) {
  if (Array.isArray(v)) need_(v.length <= 500, 'Příliš mnoho adres (max 500).');
  return (Array.isArray(v) ? v.map(e=>txt_(e,254)).join('\n') : txt_(v,50000)).split(/[\s,;]+/).map(x => x.trim().toLowerCase())
    .filter((x, i, a) => x && a.indexOf(x) === i);
}

// ---- pilots: chosen from the HR org chart (tab HR_AllApps_OrgChart of the notification file)

/** Assignment recipients need OSČ and notifications enabled; the form filler uses all HR identities. */
let ORG_FRESH_ = false, HR_INDEX_ = null, HR_SHEET_ = null, HR_BY_EMAIL_ = null;
// SPEED: the HR directory and the OSČ list are kept 6 h in the cache (was 5 min – about every form session and every
// 5-minute check read them again from the other file). ORG_AT_ / OSC_AT_ = when the copy in use was read from HR.
const HR_CACHE_S = 21600, HR_TRUST_MS = 600000;
let ORG_AT_ = 0, OSC_AT_ = 0;
const HR_VERIFIED_ = new Map();

function disabledRecipients_() {
  return new Set(cfg_().people.filter(p => p.email && !wantsMail_(p)).map(p => p.email));
}

function orgPeople_(fresh, forFinder) {
  const list = orgChart_(fresh && !ORG_FRESH_);
  const off = disabledRecipients_();
  return {people:list.filter(p => forFinder || (p.o !== '' && !off.has(p.e))).map(p => ({n:p.n, e:p.e, p:p.p})), error:''};
}

function hrSheet_() {
  if (HR_SHEET_) return HR_SHEET_;
  const ss = notifFile_();
  const sh = ss.getSheets().find(x => String(x.getName()).trim().toLowerCase() === NOTIF.OSC_TAB.toLowerCase());
  need_(sh && sh.getLastColumn(), 'Chybí list HR org chart nebo jeho záhlaví.');
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(x => plain_(x).replace(/[^A-Z]/g,''));
  const indices = [head.indexOf('JMENO'), head.findIndex(x => x === 'EMAIL' || x === 'MAIL'), head.indexOf('POZICE'), head.indexOf('OSC')];
  need_(indices[0] >= 0 && indices[1] >= 0 && indices[3] >= 0, 'HR org chart musí mít sloupce Jméno, E-mail a OSČ.');
  // Some HR exports place the four identity columns far apart. Read small adjacent
  // bands so one distant column cannot make every lookup read the intervening data.
  const bands = [];
  for (const col of [...new Set(indices.filter(i => i >= 0))].sort((a,b) => a-b)) {
    const prev = bands[bands.length-1];
    if (prev && col-prev.last <= 3) prev.last = col;
    else bands.push({first:col,last:col});
  }
  let width = 0;
  for (const band of bands) {
    band.offset = width;
    band.width = band.last - band.first + 1;
    width += band.width;
  }
  const compact = indices.map(i => {
    const band = bands.find(b => i >= b.first && i <= b.last);
    return band ? band.offset + i - band.first : -1;
  });
  HR_SHEET_ = {sh,bands,width,indices:compact};
  return HR_SHEET_;
}

function readHrRows_(source,start,count) {
  let rows;
  for (const band of source.bands) {
    const block = source.sh.getRange(start,band.first+1,count,band.width).getValues();
    if (!rows) rows = block;
    else block.forEach((extra,i) => rows[i].push(...extra));
  }
  return rows;
}

function personFromHrRow_(cells, row, indices) {
  const [name, email, position, osc] = indices;
  const n = noComma_(String(cells[name] || '').replace(/[<>]/g,'')).slice(0,100);
  const e = String(cells[email] || '').trim().toLowerCase();
  if (!n || !EMAIL_RE.test(e)) return null;
  const normal = plain_(n).toLowerCase();
  return {n, e, p:String(cells[position] || '').trim().slice(0,100), o:cells[osc] == null ? '' : cells[osc],
    row, normal, search:normal + ' ' + e};
}

function orgChart_(fresh) {
  if (HR_INDEX_ && !fresh) return HR_INDEX_;
  const ref = sheetRef_(setting_('NOTIFIKACE_TABULKA'));
  const hit = !fresh && cacheGetBig_(NOTIF.ORG_KEY);
  if (hit && ref && hit.id === ref.id) { ORG_AT_ = Number(hit.at) || 0; return HR_INDEX_ = hit.list; }
  const source = hrSheet_(), {sh,width,indices} = source;
  const count = Math.max(0, sh.getLastRow() - 1), seen = new Set(), list = [];
  // Bound both the row count and number of cells in each directory read.
  const batch = Math.max(1, Math.min(5000, Math.floor(60000 / width)));
  for (let start = 0; start < count; start += batch) {
    const rows = readHrRows_(source,start+2,Math.min(batch,count-start));
    rows.forEach((row,i) => {
      const person = personFromHrRow_(row, start+i+2, indices);
      if (person && !seen.has(person.e)) { seen.add(person.e); list.push(person); }
    });
  }
  list.sort((a,b) => a.n.localeCompare(b.n,'cs') || a.e.localeCompare(b.e));
  HR_INDEX_ = list;
  HR_BY_EMAIL_ = null;
  ORG_FRESH_ = true;
  ORG_AT_ = Date.now();
  cachePutBig_(NOTIF.ORG_KEY, {id:ref.id, list, at:ORG_AT_}, HR_CACHE_S);
  return list;
}

// Verify only the selected live row. If a person moved or was added, refresh the index once.
function verifiedHrPerson_(value) {
  const email = txt_(value,254).toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  if (HR_VERIFIED_.has(email)) return HR_VERIFIED_.get(email);
  function indexed() {
    if (!HR_BY_EMAIL_) HR_BY_EMAIL_ = new Map(orgChart_().map(p => [p.e,p]));
    return HR_BY_EMAIL_.get(email);
  }
  let person = indexed();
  // the live row is checked unless the directory was read from HR in the last 10 minutes (saves 1–2 s per save)
  if (!ORG_FRESH_ && !(person && Date.now() - ORG_AT_ < HR_TRUST_MS)) {
    const source = hrSheet_();
    person = person && person.row <= source.sh.getLastRow()
      ? personFromHrRow_(readHrRows_(source,person.row,1)[0],person.row,source.indices) : null;
    if (!person || person.e !== email) { orgChart_(true); person = indexed(); }
  }
  HR_VERIFIED_.set(email, person || null);
  return person || null;
}

/**
 * SPEED: checks the people chosen in a form against HR BEFORE the save takes the lock – the check may have to open the
 * HR file (1–2 s). Inside the lock the same checks are then answered from memory (HR_VERIFIED_), so nobody else's save
 * waits for HR. Nothing is decided here: every rule is still checked inside the lock exactly as before.
 */
function prewarmHr_(values) {
  const emails = new Set();
  const walk = v => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v == null || typeof v === 'object') return;
    String(v).slice(0, 4000).split(/[\s,;<>]+/).forEach(x => { x = x.trim().toLowerCase(); if (EMAIL_RE.test(x)) emails.add(x); });
  };
  walk(values);
  if (!emails.size || emails.size > 30) return; // not a normal form – the checks inside the lock run as before
  emails.forEach(email => { try { verifiedHrPerson_(email); } catch (e) { /* reported by the check inside the lock */ } });
}

function requirePushRecipients_(emails) {
  const off = new Set(readPeople_().filter(p => !wantsMail_(p)).map(p => p.email));
  for (const email of new Set(emails)) {
    const p = verifiedHrPerson_(email);
    need_(sameDomain_(email) && p && p.o !== '' && !off.has(email),
      'Pro PUSH musí být oba příjemci dostupní v HR s OSČ a mít povolená upozornění.');
  }
}

/** Pilots sent by the page (e-mails, or "Jméno <e-mail>") → [{ name, email }], each one checked against orgPeople_. */
function pilotsFrom_(v) {
  const values = Array.isArray(v) ? v : list_(txt_(v, 4000));
  need_(values.length <= 10, 'Vyberte nejvýš 10 pilotů.');
  const want = values.map(x => txt_(x, 360)).filter(Boolean);
  if (!want.length) return [];
  const off = disabledRecipients_();
  const out = [];
  want.forEach(x => {
    const m = /<([^<>]+)>\s*$/.exec(x);
    const e = (m ? m[1] : x).trim().toLowerCase();
    const p = verifiedHrPerson_(e);
    need_(p && p.o !== '' && !off.has(e), 'Osoba „' + x + '“ není dostupná v HR pro upozornění (chybí HR/OSČ nebo je vypnutá v Lidé).' + ' Vyberte osobu ze seznamu.');
    if (!out.some(y => y.email === p.e)) out.push({ name: p.n, email: p.e });
  });
  return out;
}

/** The ④ Piloti cell → [{ name, email }]. Reads "Jméno <e-mail>" and the bare e-mails of older QRAPs. */
function pilotsOf_(cell) {
  return list_(cell).map(x => {
    const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(x);
    return m ? { name: m[1] || m[2], email: m[2].trim().toLowerCase() } : { name: '', email: x.toLowerCase() };
  });
}
function pilotsCell_(list) { return list.map(p => (p.name ? p.name + ' <' + p.email + '>' : p.email)).join(', '); }

/** Správa → Notifikace: replaces the lists (admins only). o = { create, roles: { role: emails } }. */
function saveNotif_(o) {
  o = obj_(o);
  need_(me_().admin, 'Správa je jen pro admina.');
  const currentTest = cfg_().notif;
  need_(o.testMode !== undefined || currentTest.testMode === 'NORMAL', ADMIN_STALE_);
  const testMode = oneOf_(o.testMode || 'NORMAL',['NORMAL','PAUSED','ONE'],'Neplatný testovací režim.');
  const testRecipients = emailList_(o.testRecipient || '');
  need_(testRecipients.length <= 1,'Vyberte pouze jednoho testovacího příjemce.');
  const testRecipient = testMode === 'ONE' ? testRecipients[0] || '' : '';
  need_(testMode !== 'ONE' || testRecipient,'Vyberte testovacího příjemce z HR.');
  const roles = obj_(o.roles);
  const lists = { create: emailList_(o.create), roles: {} };
  const alert = cfg_().lists.alert || [];
  need_(Object.prototype.hasOwnProperty.call(o,'spuSupervisor'), ADMIN_STALE_);
  const spuValues = emailList_(o.spuSupervisor);
  need_(spuValues.length <= 1, 'Vyberte pouze jednoho supervizora SPU.');
  const spuSupervisor = spuValues[0] || '';
  need_(!spuSupervisor || (EMAIL_RE.test(spuSupervisor) && sameDomain_(spuSupervisor)),
    'Vyberte supervizora SPU z firemního HR.');
  alert.filter(r => r !== PRODUCTION_ROLE).forEach(r => { lists.roles[r] = emailList_(roles[r]); });
  need_(!emailList_(roles[PRODUCTION_ROLE]).length, 'Supervizory výroby vybírá uživatel přímo ve formuláři QRAP.');
  need_(o.version === digest_([cfg_().notif,alert]), ADMIN_STALE_);
  const was = cfg_().notif.roles; // AUDIT-M1: a role that left the list keeps its row (shown in Správa), nothing is lost silently
  const orphans = Object.keys(was).filter(r => alert.indexOf(r) < 0 && was[r].length);
  const all = lists.create.concat(...Object.values(lists.roles), spuValues);
  const bad = all.filter((x, i, a) => !EMAIL_RE.test(x) && a.indexOf(x) === i);
  need_(!bad.length, 'Toto není e-mail: ' + bad.join(', ') + '.');
  need_(all.length <= 500, 'Příliš mnoho adres (max 500).');
  const added = lists.create.filter(email => !cfg_().notif.create.includes(email));
  Object.keys(lists.roles).forEach(role => {
    const existing = was[role] || [];
    added.push(...lists.roles[role].filter(email => !existing.includes(email)));
  });
  if (added.length) {
    const directory = new Set(orgPeople_(true, true).people.map(person => person.e));
    const unavailable = [...new Set(added.filter(email => !sameDomain_(email) || !directory.has(email)))];
    need_(!unavailable.length, 'Tyto e-maily nebyly nalezeny v HR: ' + unavailable.join(', '));
  }
  lock_(() => {
    requireRight_(me_().admin);
    need_(o.version === digest_([readNotif_(),readLists_().alert]), ADMIN_STALE_);
    if (testRecipient) requirePushRecipients_([testRecipient]);
    if (spuSupervisor && spuSupervisor !== readNotif_().spuSupervisor) requirePushRecipients_([spuSupervisor]);
    const rows = [['Kategorie', 'E-maily'], ["'" + NOTIF.CREATE, lists.create.join(', ')]]
      .concat(Object.keys(lists.roles).map(r => ["'" + NOTIF.ROLE + r, lists.roles[r].join(', ')]),
        [["'" + SPU_RECIPIENT,spuSupervisor], ["'Testovací režim",testMode], ["'Testovací příjemce",testRecipient]],
        orphans.map(r => ["'" + NOTIF.ROLE + r, was[r].join(', ')])); // AUDIT-M1 (the old row "Piloti" is not written back)
    const ss = SS_ || (SS_ = SpreadsheetApp.getActiveSpreadsheet());
    const sh = ss.getSheetByName(NOTIF.TAB) || ss.insertSheet(NOTIF.TAB);
    const last = sh.getLastRow();
    if (sh.getMaxRows() < rows.length) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows());
    // Replace both the active configuration and any trailing retired pairs in one write.
    while (rows.length < last) rows.push(['','']);
    sh.getRange(1,1,rows.length,2).setValues(rows);
    WROTE_ = true;
    log_('SPRÁVA', 'Notifikace: po vytvoření ' + lists.create.length + ', role ' +
      Object.keys(lists.roles).map(r => r + ' ' + lists.roles[r].length).join(', ') + ', APU Manager ' + (spuSupervisor || 'nevybrán'));
    CacheService.getScriptCache().remove('alerts:recent-sweep');
    clearCache_();
  });
  return adminData_(); // AUDIT-H3: outside the lock
}

/** What Správa shows: the lists, where the rows go, and listed people who would get nothing (no OSC, switched off). */
function notifAdmin_(c) {
  const n = c.notif;
  const out = { version:digest_([n,c.lists.alert]), create: n.create, spuSupervisor:n.spuSupervisor, spuNeedsSelection:n.spuNeedsSelection, testMode:n.testMode, testRecipient:n.testRecipient,
    roles: (c.lists.alert || []).filter(r => r !== PRODUCTION_ROLE).map(r => ({ role: r, emails: n.roles[r] || [] })),
    ok: false, status: '', noOsc: [], off: [],
    orphans: Object.keys(n.roles).filter(r => (c.lists.alert || []).indexOf(r) < 0 && n.roles[r].length) }; // AUDIT-M1
  const all = n.create.concat(...out.roles.map(r => r.emails), n.spuSupervisor ? [n.spuSupervisor] : []).filter((x, i, a) => a.indexOf(x) === i);
  out.off = all.filter(e => c.people.some(p => p.email === e && !wantsMail_(p)));
  const props=PropertiesService.getScriptProperties();
  out.workerWarning=props.getProperty('ALERTS_TRIGGER')?'':'Automatika není zapnutá. V menu tabulky eQRAP spusťte „Zapnout / obnovit automatiku upozornění (5 minut)“. ';
  try{out.syncError=JSON.parse(props.getProperty('ALERTS_LAST_RUN')||'{}').error||'';}catch(e){out.syncError='Stav kontroly není dostupný.';}
  if (plain_(c.settings.EMAILY) !== 'ANO') out.status = 'Upozornění jsou vypnutá (Nastavení → Posílat upozornění = NE). ';
  try {
    const t = notifTarget_();
    let osc = oscMap_(t);
    if (all.some(e => !hasOsc_(osc, e)) && Date.now() - OSC_AT_ > 600000) osc = oscMap_(t, true); // just added in HR?
    out.noOsc = all.filter(e => !hasOsc_(osc, e));
    out.ok = true;
    out.status += 'Zapisuje se do: ' + t.name + '.';
  } catch (e) {
    out.status += publicError_('notifAdmin', e);
  }
  return out;
}

/** Nastavení → NOTIFIKACE_TABULKA as { id }: a link to the file or the bare file ID (the tabs are found by name). */
function sheetRef_(v) {
  v = String(v || '').trim();
  const m = /\/d\/([\w-]{20,})/.exec(v) || /^([\w-]{20,})$/.exec(v);
  if (!m) return null;
  const g = /[#&?]gid=(\d+)/.exec(v);
  return { id: m[1], gid: g ? Number(g[1]) : null };
}

/**
 * The notification file, opened once per request, with its two tabs (NOTIF.TABS) and their header rows – the columns
 * are found by their names, so their order does not matter.
 */
/** The notification file (Nastavení → NOTIFIKACE_TABULKA), opened once per request. */
function notifFile_() {
  if (NOTIF_SS_) return NOTIF_SS_;
  const ref = sheetRef_(setting_('NOTIFIKACE_TABULKA'));
  need_(ref, 'Tabulka pro upozornění není nastavená (Správa → Nastavení → Tabulka upozornění) – nikdo nic nedostane.');
  try { NOTIF_SS_ = SpreadsheetApp.openById(ref.id); } catch (e) {
    throw new UserError('Tabulku pro upozornění nelze otevřít. Účet, pod kterým aplikace běží (' + runAsEmail_() +
      '), v ní musí mít právo upravovat.');
  }
  return NOTIF_SS_;
}

function notifTarget_() {
  if (NOTIF_T_) return NOTIF_T_;
  const ss = notifFile_();
  const tabs = ss.getSheets();
  const norm = x => String(x).trim().toLowerCase();
  const tab = name => {
    const sh = tabs.filter(x => norm(x.getName()) === norm(name))[0];
    need_(sh, 'V tabulce pro upozornění chybí list „' + name + '“.');
    const head = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim()) : [];
    need_(head.indexOf(NOTIF.HEAD.osc) >= 0 && head.indexOf(NOTIF.HEAD.text) >= 0, 'List „' + name + '“ nemá sloupce „OSC“ a „Text Alertu“.');
    return { sh: sh, head: head };
  };
  NOTIF_T_ = { ss: ss, normal: tab(NOTIF.TABS.normal), safety: tab(NOTIF.TABS.safety),
    name: ss.getName() + ' → ' + NOTIF.TABS.normal + ' (SAFETY: ' + NOTIF.TABS.safety + ')' };
  return NOTIF_T_;
}

/**
 * e-mail → osč from the tab HR_AllApps_OrgChart (columns "E-mail" and "osč", any order). Only those two columns are read,
 * and the list is cached 5 min in chunks (an org chart of thousands of people is far over one 100 KB cache entry).
 */
function oscMap_(t, fresh) { // AUDIT-H2
  const hit = !fresh && cacheGetBig_(NOTIF.OSC_KEY);
  if (hit && hit.id === t.ss.getId()) { OSC_AT_ = Number(hit.at) || 0; return hit.map; }
  const sh = t.ss.getSheets().filter(x => String(x.getName()).trim().toLowerCase() === NOTIF.OSC_TAB.toLowerCase())[0];
  need_(sh, 'V tabulce pro upozornění chybí list „' + NOTIF.OSC_TAB + '“ (e-mail → osč).');
  const rows = sh.getLastRow() - 1, cols = sh.getLastColumn();
  const head = cols ? sh.getRange(1, 1, 1, cols).getValues()[0].map(x => plain_(x).replace(/[^A-Z]/g, '')) : []; // "osč" → OSC
  const o = head.indexOf('OSC'), m = head.findIndex(x => x === 'EMAIL' || x === 'MAIL');
  need_(o >= 0 && m >= 0, 'List „' + NOTIF.OSC_TAB + '“ nemá sloupce „E-mail“ a „osč“.');
  const map = {};
  if (rows > 0) {
    const osc = sh.getRange(2, o + 1, rows, 1).getValues(), mail = sh.getRange(2, m + 1, rows, 1).getValues();
    for (let i = 0; i < rows; i++) {
      const e = String(mail[i][0]).trim().toLowerCase(), v = osc[i][0];
      if (e && v !== '' && v !== null && map[e] === undefined) map[e] = v;
    }
  }
  OSC_AT_ = Date.now();
  cachePutBig_(NOTIF.OSC_KEY, { id: t.ss.getId(), map: map, at: OSC_AT_ }, HR_CACHE_S);
  return map;
}
/** AUDIT-M5: an e-mail for the log: "ja***@valeo.com". */
function mask_(e) { e = String(e || ''); const i = e.indexOf('@'); return i > 2 ? e.slice(0, 2) + '***' + e.slice(i) : '***'; }
function hasOsc_(osc, email) { return osc[email] !== undefined && osc[email] !== ''; }

/** Termín of a new QRAP: KDY + the ③ deadline (LHUTA_OPATRENI_HODIN), as on the QRAP page. */
function deadline_(q) {
  const from = new Date(q.when || q.created || Date.now()).getTime();
  return new Date(from + (Number(setting_('LHUTA_OPATRENI_HODIN')) || 24) * 3600e3).toISOString();
}

/** Notification state is durable in the QRQC workbook. The QRAP is the source of truth;
 * the five-minute worker repairs missed writes and never removes work before delivery.
 * One recipient row per QRAP; source keys distinguish creation, roles, Jiné, pilots and actions.
 */
const ALERTS = { TAB: 'Alerty_stav', PUSH_MS: 5 * 3600000, PREFIX: 'eqrap:', HANDLER: 'notificationTick', SCHEMA: 1 };
let ALERT_DIRTY_ = {};
let ALERT_STORE_ = null;
let ALERT_WARNING_ = '';

function alertStore_() {
  if (ALERT_STORE_) return ALERT_STORE_;
  const ss = SS_ || (SS_ = SpreadsheetApp.getActiveSpreadsheet());
  const sh = ss.getSheetByName(ALERTS.TAB) || ss.insertSheet(ALERTS.TAB);
  if (!sh.getLastRow()) sh.getRange(1, 1, 1, 2).setValues([['Klíč', 'Data']]);
  const rows = sh.getDataRange().getValues(), entries = {};
  need_(rows[0][0] === 'Klíč' && rows[0][1] === 'Data', 'List Alerty_stav má jiné sloupce. Kontaktujte správce.');
  rows.slice(1).forEach((r, i) => {
    if (!r[0]) return;
    let json = String(r[1]);
    if (json.indexOf('gz:') === 0) json = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(json.slice(3)))).getDataAsString('UTF-8');
    // A damaged journal must stop reconciliation, never be interpreted as an empty journal.
    entries[String(r[0])] = { row: i + 2, value: JSON.parse(json), json: json };
  });
  const recipients = new Map();
  Object.keys(entries).forEach(key => {
    const id = entries[key].value.qid;
    if (!id) return;
    if (!recipients.has(id)) recipients.set(id, []);
    recipients.get(id).push(key);
  });
  ALERT_STORE_ = {sh:sh, entries:entries, recipients:recipients};
  return ALERT_STORE_;
}
function alertGet_(key) { const r = alertStore_().entries[key]; return r ? r.value : null; }
function alertPut_(key, value) {
  const db = alertStore_(), json = JSON.stringify(value), old = db.entries[key];
  if (old && old.json === json) return;
  const data = json.length < 40000 ? json : 'gz:' + Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json)).getBytes());
  need_(data.length <= 45000, 'Záznam upozornění je příliš velký. Kontaktujte správce.');
  const row = old ? old.row : db.sh.getLastRow() + 1;
  if (row > db.sh.getMaxRows()) db.sh.insertRowsAfter(db.sh.getMaxRows(), row - db.sh.getMaxRows());
  db.sh.getRange(row, 1, 1, 2).setValues([[key, data]]);
  db.entries[key] = {row:row, value:value, json:json};
  if (!old && value.qid) {
    if (!db.recipients.has(value.qid)) db.recipients.set(value.qid, []);
    db.recipients.get(value.qid).push(key);
  }
}
let ALERT_PREFIX_ = '';
function alertPrefix_() { return ALERT_PREFIX_ || (ALERT_PREFIX_ = ALERTS.PREFIX + digest_((SS_ || SpreadsheetApp.getActiveSpreadsheet()).getId()).slice(0, 12) + ':'); }
function alertId_(id, email) { return alertPrefix_() + id + ':' + digest_(email).slice(0, 20); }
function alertTouch_(q) { ALERT_DIRTY_[q.id] = true; }
function alertPeople_(cell) { return pilotsOf_(cell).filter(p => EMAIL_RE.test(p.email)); }

/** Snapshot configured creation/role recipients when the QRAP/role is first seen.
 * Subsequent settings edits do not assign old QRAPs to newly configured people.
 * State is written under the same script lock as the QRAP save, before any remote delivery.
 */
function captureAlerts_(q, actions) {
  if (NO_MAIL_) return;
  const now = Date.now(), oldMeta = alertGet_('q:' + q.id);
  const meta = oldMeta ? JSON.parse(JSON.stringify(oldMeta)) : {id:q.id, create:cfg_().notif.create.slice(), roles:{}, closed:false, testMode:q.alertTestMode || 'NORMAL', testRecipient:q.alertTestRecipient || ''};
  const closed = !!(q.closedAt || q.cancelReason), reopened = !!(oldMeta && oldMeta.closed && !closed);
  if (Object.prototype.hasOwnProperty.call(meta.roles,'Supervizor')) {
    meta.roles[LOGISTICS_ROLE] = meta.roles[LOGISTICS_ROLE] || meta.roles.Supervizor;
    delete meta.roles.Supervizor;
  }
  const selectedRoles = list_(q.notified).map(alertRole_);
  const roles = selectedRoles.filter(role => role !== PRODUCTION_ROLE), addedRoles = roles.filter(role => !Object.prototype.hasOwnProperty.call(meta.roles, role));
  roles.forEach(role => { if (!Object.prototype.hasOwnProperty.call(meta.roles, role)) meta.roles[role] = (cfg_().notif.roles[role] || []).slice(); });
  Object.keys(meta.roles).forEach(role => { if (roles.indexOf(role) < 0) delete meta.roles[role]; });
  const desired = {}, created = new Date(q.created).getTime() || now;
  const add = (emails, source, label, at, due) => emails.forEach(email => {
    email = String(email || '').trim().toLowerCase(); if (!EMAIL_RE.test(email)) return;
    const d = desired[email] || (desired[email] = {sources:[], labels:[], times:[], dues:[]});
    if (d.sources.indexOf(source) >= 0) return;
    const prior = alertGet_(alertId_(q.id,email));
    const eventAt = reopened ? now : (prior && prior.active && prior.eventAt && prior.eventAt[source]) ||
      Math.max(Number(meta.releasedAt) || 0, Math.min(now, at || created)); // releasedAt: see releaseTestAlerts_
    d.sources.push(source); d.labels.push(label); d.times.push(eventAt);
    if (due) d.dues.push(due);
    else if(source==='pilot') d.dues.push(new Date(eventAt).toISOString()); // pilot task is due from assignment, as before

  });
  add(meta.create, 'create', 'nový QRAP', created, deadline_(q));
  roles.forEach(role => add(meta.roles[role], 'role:' + (role === LOGISTICS_ROLE ? 'Supervizor' : role), 'role: ' + role,
    oldMeta && addedRoles.indexOf(role) >= 0 ? now : created, deadline_(q)));
  if (selectedRoles.includes(PRODUCTION_ROLE)) {
    const at = oldMeta ? Date.parse(q.updated) : created;
    add(emailList_(q.productionSupervisor), 'production', PRODUCTION_ROLE, at, deadline_(q));
    add([q.apuManager], 'apu', 'APU Manager', at, deadline_(q));
  }
  if (roles.some(isOther_)) add(alertPeople_(q.notifiedOther).map(p=>p.email), 'other', 'Jiné', oldMeta ? new Date(q.updated).getTime() : created, deadline_(q));
  add(alertPeople_(q.pilots).map(p=>p.email), 'pilot', 'pilot QRAP', oldMeta ? new Date(q.updated).getTime() : new Date(q.decisionAt).getTime(), '');
  (actions || actionsOf_(q.id)).filter(a=>a.part==='⑥' && !a.removed && a.ownerEmail).forEach(a =>
    add([a.ownerEmail], 'action:' + a.no, 'akce ' + a.no + (a.done ? ' (hotová)' : ''),
      oldMeta ? new Date(q.updated).getTime() : new Date(a.created).getTime(), a.done ? '' : a.due));
  const keys = alertStore_().recipients.get(q.id) || [];
  if (meta.testMode && meta.testMode !== 'NORMAL') {
    Object.keys(desired).forEach(email => delete desired[email]);
    if (meta.testMode === 'ONE' && meta.testRecipient) {
      add([meta.testRecipient],'test','TEST – testovací příjemce',created,deadline_(q));
    }
  }
  Object.keys(desired).forEach(email => {
    const id = alertId_(q.id, email), prev = alertGet_(id), d = desired[email];
    const fresh = d.sources.map((s,i)=>!prev || !prev.active || reopened || prev.sources.indexOf(s)<0 ? (reopened ? now : d.times[i]) : 0).filter(Boolean);
    // Older records stored a 23-hour deadline without recording the window length.
    const previousWindow = prev && prev.pushWindowMs || 23 * 3600000;
    const previousUntil = prev && prev.active && prev.pushUntil
      ? prev.pushUntil - previousWindow + ALERTS.PUSH_MS : 0;
    const until = fresh.length
      ? Math.max(previousUntil, Math.max(...fresh) + ALERTS.PUSH_MS)
      : previousUntil;
    const labels = d.labels.slice(), pilot = d.sources.indexOf('pilot') >= 0;
    const action = d.sources.some(s=>s.indexOf('action:')===0);
    const text = (meta.testMode === 'ONE' ? 'TEST – ' : '') + (q.safety==='ANO' ? 'SAFETY! ' : '') + q.id + ' – ' +
      (pilot ? 'jste pilot QRAP' : action ? 'máte přiřazenou akci' : 'upozornění') + ': ' + short_(title_(q));
    const value = {id:id, qid:q.id, email:email, sources:d.sources, eventAt:Object.fromEntries(d.sources.map((source,i)=>[source,d.times[i]])), active:!closed, pushUntil:until, pushWindowMs:ALERTS.PUSH_MS,
      safety:q.safety==='ANO', text:inert_(text,500), due:d.dues.sort()[0] || '', url:link_(q.id), ctx:inert_(what_(q),200), why:inert_(labels.join('; '),500)};
    alertPut_(id, value);
  });
  keys.forEach(k => { const old = alertGet_(k); if (!desired[old.email] && old.active) alertPut_(k, Object.assign({}, old, {active:false})); });
  meta.closed = closed;
  alertPut_('q:' + q.id, meta); // commit snapshot last: retrying recipient writes is idempotent
}

// Kept as internal hooks for older call sites. Recipients come from committed QRAP state.
function notifyNew_(q) { alertTouch_(q); }
function notifyRoles_(q) { alertTouch_(q); }
function notifyPilots_(q) { alertTouch_(q); }
function inert_(v, max) { return String(v == null ? '' : v).replace(/</g,'‹').replace(/>/g,'›').replace(/[\u0000-\u001f\u007f]+/g,' ').trim().slice(0,max); }
function mailAfterSave_() {
  MAIL_KEYS_ = Object.keys(ALERT_DIRTY_).map(id=>'ALERT:' + id);
  OUTBOX_ = [];
  if (!DEFER_MAIL_ && MAIL_KEYS_.length) syncAlerts_(MAIL_KEYS_.map(k=>k.slice(6)));
}
function mailOut_(keys) {
  me_(); rate_('mail',60,600);
  need_(Array.isArray(keys) && keys.length > 0 && keys.length <= 50 && keys.every(k =>
    typeof k === 'string' && /^ALERT:Q-[A-Za-z0-9][A-Za-z0-9_-]{0,37}$/.test(k)), 'Neplatná žádost o kontrolu upozornění.');
  return syncAlerts_(keys.map(k => k.slice(6)));
}
function sendParked_() { return syncAlerts_(null); }
function sweepMail_() {
  if (CacheService.getScriptCache().get('alerts:recent-sweep')) return {ok:true, skipped:true};
  return syncAlerts_(null, true);
}

/** Both tables keep their original nine columns. Append only the two new headers when missing. */
function alertTargets_() {
  const t = notifTarget_();
  [t.normal,t.safety].forEach(tab => {
    Object.keys(NOTIF.HEAD).forEach(k=>need_(tab.head.indexOf(NOTIF.HEAD[k])>=0, 'V listu '+tab.sh.getName()+' chybí sloupec '+NOTIF.HEAD[k]+'.'));
    ['uuid','PUSH_do'].forEach(name=>{
      if (tab.head.indexOf(name)>=0) return;
      const c=tab.head.length+1;
      if(c>tab.sh.getMaxColumns()) tab.sh.insertColumnsAfter(tab.sh.getMaxColumns(),c-tab.sh.getMaxColumns());
      tab.sh.getRange(1,c).setValue(name);tab.head.push(name);
    });
    tab.rows=tab.sh.getLastRow()>1 ? tab.sh.getRange(2,1,tab.sh.getLastRow()-1,tab.head.length).getValues() : [];
  });
  return t;
}
function alertUrlId_(url) { const m=/[?&]id=(Q-[\w-]+)(?:&|$)/.exec(String(url||''));return m ? m[1] : ''; }
function alertCellEq_(a,b) { return a instanceof Date || b instanceof Date ? new Date(a).getTime()===new Date(b).getTime() : String(a==null?'':a)===String(b==null?'':b); }

/**
 * Reconcile in two steps, so that a save never waits for the remote notification sheet:
 *   1. under the script lock – local sheets only, short: the recipients of the committed QRAPs are snapshotted in
 *      Alerty_stav (captureAlerts_). Saves use the same lock, so the snapshot never races a save.
 *   2. under its own lease (alertLease_), WITHOUT the script lock: rows are written to / removed from the notification
 *      sheet. An uncertain append is found by UUID on retry; every update and delete re-checks the live row first.
 * State is never dequeued before writing. Closed QRAPs are checked again at delivery, preventing resurrection.
 * SPEED: before, step 2 (opening the other file, reading its tabs and the HR OSČ list) ran under the script lock too –
 * after every save, on every 5-minute check – and every save in the meantime had to wait for it.
 */
function syncAlerts_(ids, quiet) {
  const errors=[];let written=0, removed=0;
  let testSettings=null, states=[];
  const qmap={}, pending=new Set();
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(quiet ? 1 : 20000)) return {ok:false, retry:true};
  try {
    if (!ids) {
      const cache = CacheService.getScriptCache();
      if (quiet && cache.get('alerts:recent-sweep')) return {ok:true, skipped:true};
      // A healthy five-minute worker keeps the display out of reconciliation.
      // If a run fails, the trigger and the browser fallback can still retry.
      cache.put('alerts:recent-sweep', '1', quiet ? 300 : 600);
    }
    MEMO_={}; ALERT_STORE_=null;
    testSettings = readNotif_();
    const selected = ids
      ? Array.from(new Set(ids)).map(id => rowsBy_(TAB.qraps,id)[0]).filter(Boolean)
      : table_(TAB.qraps).all;
    // Protect unfinished recovery operations: the worker does not treat a half-restored QRAP as a completed save.
    const opSheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OPS_TAB);
    if (opSheet && opSheet.getLastRow() > 1) {
      const ops = table_(OPS_TAB).all;
      ops.forEach(r => {
        if (r.key.startsWith('upload:')) return;
        const op = JSON.parse(r.json);
        if (op.state === 'done') return;
        if (op.q) pending.add(op.q.id);
        if (op.action) pending.add(op.action.qrapId);
        // Transitions always reconcile from the live QRAP, including closure after a lost reply.
        if (r.key.startsWith('restore:')) pending.add(r.key.slice(8));
      });
      if (!ids) pruneOperations_(ops); // the full check keeps the journal small
    }
    const groupedActions = !ids ? groupBy_(table_(TAB.actions).all) : null;
    selected.forEach(q => {
      if (pending.has(q.id)) return;
      qmap[q.id] = q;
      // A committed closed snapshot already retired its recipients. Still remove remote rows below.
      const meta = alertGet_('q:' + q.id);
      if ((q.closedAt || q.cancelReason) && meta && meta.closed) return;
      const actions = groupedActions ? (groupedActions.get(q.id) || []).sort((a,b)=>a.no-b.no) : null;
      captureAlerts_(q, actions);
    });
    if(!ids){
      const archived=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.qraps+' - Archiv');
      if(archived && archived.getLastRow()>1){
        const head = archived.getRange(1,1,1,archived.getLastColumn()).getValues()[0].map(String);
        const cols = ['id','closedAt','cancelReason'].map(k=>head.indexOf(COLS[TAB.qraps].find(c=>c[0]===k)[1]));
        if (cols.every(i=>i>=0)) {
          const n = archived.getLastRow()-1;
          const [ids,closed,cancelled] = cols.map(i=>archived.getRange(2,i+1,n,1).getValues());
          ids.forEach(([id],i)=>{
            if (id && !qmap[id] && !pending.has(id) && (closed[i][0] || cancelled[i][0])) {
              qmap[id] = {id:id,closedAt:closed[i][0],cancelReason:cancelled[i][0]};
            }
          });
        }
      }
    }
    if (Object.keys(qmap).length) states=Object.values(alertStore_().entries).map(r=>r.value).filter(s=>s.qid && qmap[s.qid]);
    SpreadsheetApp.flush(); // the snapshot is committed before the lock is released
  }catch(e){errors.push(e.message||String(e));}
  finally{lock.releaseLock();}
  if (!errors.length && !Object.keys(qmap).length) return {ok:true,written:0,removed:0};

  // Step 2 – the notification sheet, outside the script lock.
  const lease = errors.length ? '' : alertLease_(quiet ? 1 : 20000);
  if (!errors.length && !lease) return {ok:false, retry:true}; // another check is writing right now – the next one does it
  if (lease) {
    try {
      const t=alertTargets_(), app=String(setting_('NOTIFIKACE_APLIKACE')||'eQRAP');
      let osc={};
      try {
        osc=oscMap_(t);
        // somebody new in HR: the cached OSČ list (kept 6 h) is read again – at most every 10 minutes
        if (states.some(s=>s.active && !hasOsc_(osc,s.email)) && Date.now()-OSC_AT_ > 600000) osc=oscMap_(t,true);
      } catch(e){errors.push(e.message);}
      const disabled=new Set(cfg_().people.filter(p=>p.email&&!wantsMail_(p)).map(p=>p.email));
      const enabled=plain_(setting_('EMAILY'))==='ANO';
      const tabs=[t.normal,t.safety], dels=tabs.map(()=>new Set());
      const prefix=alertPrefix_(), baseUrl=link_('').split('?')[0];
      const owned = (tab,row) => {
        const uuid = String(row[tab.head.indexOf('uuid')] || '');
        if (uuid) return uuid.startsWith(prefix);
        return !!baseUrl && String(row[tab.head.indexOf('Aplikace')]) === app &&
          String(row[tab.head.indexOf('URL')] || '').split('?')[0] === baseUrl;
      };
      const byUuid=Object.create(null), legacy=Object.create(null);
      tabs.forEach((tab,ti)=>tab.rows.forEach((row,ri)=>{
        const m={ti:ti,ri:ri,row:row},uid=String(row[tab.head.indexOf('uuid')]||'');
        if(uid){(byUuid[uid]||(byUuid[uid]=[])).push(m);}
        else if(owned(tab,row)) {const key=alertUrlId_(row[tab.head.indexOf('URL')])+'|'+String(row[tab.head.indexOf('OSC')]);(legacy[key]||(legacy[key]=[])).push(m);}
      }));
      states.forEach(s=>{
        const matches=(byUuid[s.id]||[]).concat(hasOsc_(osc,s.email)?legacy[s.qid+'|'+String(osc[s.email])]||[]:[]);
        if(!s.active || qmap[s.qid].closedAt || qmap[s.qid].cancelReason || disabled.has(s.email)) {matches.forEach(m=>dels[m.ti].add(m.ri));return;}
        if(testSettings.testMode === 'PAUSED') return;
        if(testSettings.testMode === 'ONE') {
          const snapshot = alertGet_('q:' + s.qid);
          if (!snapshot || snapshot.testMode !== 'ONE' || s.email !== testSettings.testRecipient) return;
        }
        if(!hasOsc_(osc,s.email)){errors.push('Chybí OSČ: '+mask_(s.email)+' ('+s.qid+')');return;}
        // Global switch stops new notifications, but still allows closure cleanup and PUSH expiry of existing rows.
        if(!enabled && !matches.length) return;
        const ti=s.safety?1:0,tab=tabs[ti],keep=matches.find(m=>m.ti===ti);
        const value={OSC:osc[s.email],Aplikace:app,'Text Alertu':s.text,'Termín':s.due?new Date(s.due):'',URL:s.url,Kontext:s.ctx,
          Status:enabled && Date.now()<s.pushUntil?'PUSH':'aktivni','Typ Akce':NOTIF.TYPE,'Důvod odeslání':s.why,uuid:s.id,PUSH_do:new Date(s.pushUntil)};
        const cell=v=>typeof v==='string'&&v ? "'"+v : v;
        try {
          const obsolete = matches.filter(m=>m!==keep);
          const changed = keep ? Object.keys(value).filter(k=>!alertCellEq_(keep.row[tab.head.indexOf(k)],value[k])) : [];
          if (keep && !changed.length && !obsolete.length) return;
          if(keep){
            const live = tab.sh.getRange(keep.ri+2,1,1,tab.head.length).getValues()[0];
            need_(owned(tab,live) && ['uuid','OSC','URL','Aplikace'].every(k => {
              const i=tab.head.indexOf(k); return alertCellEq_(keep.row[i],live[i]);
            }), 'Řádek upozornění se změnil. Kontrola bude zopakována.');
            changed.forEach(k=>tab.sh.getRange(keep.ri+2,tab.head.indexOf(k)+1).setValue(cell(value[k])));
          } else {const row=tab.head.map(k=>Object.prototype.hasOwnProperty.call(value,k)?cell(value[k]):'');tab.sh.appendRow(row);}
          if (obsolete.length) SpreadsheetApp.flush(); // confirm the surviving row before deletion
          obsolete.forEach(m=>dels[m.ti].add(m.ri));
          if (!keep || changed.length) written++;
        }catch(e){errors.push(s.qid+': '+e.message);}
      });
      // Also delete legacy rows after closure, including people no longer present in current settings/HR.
      tabs.forEach((tab,ti)=>tab.rows.forEach((row,ri)=>{
        if(!owned(tab,row))return;
        const id=alertUrlId_(row[tab.head.indexOf('URL')]),q=qmap[id];
        if(q && (q.closedAt||q.cancelReason)) dels[ti].add(ri);
      }));
      tabs.forEach((tab,ti) => Array.from(dels[ti]).sort((a,b) => b-a).forEach(ri => {
        try {
          const live = tab.sh.getRange(ri+2,1,1,tab.head.length).getValues()[0];
          need_(owned(tab,live) && ['uuid','OSC','URL','Aplikace'].every(k => {
            const col = tab.head.indexOf(k); return alertCellEq_(live[col],tab.rows[ri][col]);
          }), 'Řádek upozornění se mezitím změnil. Kontrola bude zopakována.');
          tab.sh.deleteRow(ri+2); removed++;
        } catch(e) { errors.push('Odstranění: ' + e.message); }
      }));
      SpreadsheetApp.flush();
      // Successful reconciliation supersedes old property queues. Never delete them on an incomplete run.
      if(!ids && !errors.length && !pending.size){const props=PropertiesService.getScriptProperties();Object.keys(props.getProperties()).filter(k=>k.indexOf(MAIL.PREFIX)===0).forEach(k=>props.deleteProperty(k));}
    }catch(e){errors.push(e.message||String(e));}
    finally{alertLeaseEnd_(lease);}
  }
  const status={at:nowIso_(),ok:!errors.length,error:errors.slice(0,8).join(' · ')};
  try{PropertiesService.getScriptProperties().setProperty('ALERTS_LAST_RUN',JSON.stringify(status));}catch(e){console.warn(e.message);}
  if(errors.length)console.warn('Upozornění čekají na opakování: '+status.error);
  return {ok:!errors.length,retry:!!errors.length,written:written,removed:removed};
}

/**
 * The mutex of step 2 of syncAlerts_: a lease in the cache, separate from the script lock that saves use. The script
 * lock is held only for the check-and-set (milliseconds). A crashed run frees the lease after 5 minutes. If the cache
 * ever loses it and two runs overlap, nothing breaks: rows are matched by UUID and the next run removes a duplicate.
 */
const ALERT_LEASE = 'alerts:lease';
function alertLease_(waitMs) {
  const cache = CacheService.getScriptCache(), id = Utilities.getUuid(), end = Date.now() + waitMs;
  for (;;) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(Math.max(1, Math.min(3000, end - Date.now())))) {
      try { if (!cache.get(ALERT_LEASE)) { cache.put(ALERT_LEASE, id, 300); return id; } }
      finally { lock.releaseLock(); }
    }
    if (Date.now() + 700 >= end) return '';
    Utilities.sleep(700);
  }
}
function alertLeaseEnd_(id) {
  try { const cache = CacheService.getScriptCache(); if (cache.get(ALERT_LEASE) === id) cache.remove(ALERT_LEASE); }
  catch (e) { console.warn('alert lease: ' + e.message); }
}

/**
 * The recovery journal (Operace) is read by every notification check, so it must not grow forever. A finished
 * operation is kept 3 days (a retry comes within seconds, a draft lives 24 h), a phone-upload binding 2 days (it is
 * accepted for 24 h); unfinished operations are always kept. Called by the full check, under the script lock.
 */
function pruneOperations_(rows) {
  const now = Date.now(), keep = [];
  let changed = false;
  rows.forEach(r => {
    let op;
    try { op = JSON.parse(r.json); } catch (e) { keep.push({key:r.key, json:r.json}); return; }
    const upload = String(r.key).indexOf('upload:') === 0;
    const at = Date.parse(upload ? op.at : op.savedAt);
    if (upload ? now - at > 2 * 864e5 : op.state === 'done' && now - at > 3 * 864e5) { changed = true; return; }
    if (!upload && op.state === 'done' && !op.savedAt) { // finished before this version: its 3 days start now
      op.savedAt = new Date(now).toISOString();
      changed = true;
    }
    keep.push({key:r.key, json:JSON.stringify(op)});
  });
  if (!changed) return;
  const t = head_(memo_(OPS_TAB)), sh = t.sheet(), width = t.last + 1, n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, width).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, width).setValues(keep.map(o => rowOf_(t, o)));
  delete MEMO_[OPS_TAB];
  WROTE_ = true;
}

/**
 * Menu: a QRAP reported while the test mode was on keeps that mode (its alerts go to nobody / only the test recipient),
 * so switching to normal operation never suddenly notifies people about old tests. For real QRAPs reported during the
 * test, this releases them: the recipients are taken as in normal operation (Po vytvoření, roles in ②, pilots, action
 * owners) and get the alert now – PUSH for 5 hours – while the test recipient's row is removed.
 */
function releaseTestAlerts() {
  menuOnly_();
  const ui = SpreadsheetApp.getUi();
  need_(readNotif_().testMode === 'NORMAL', 'Nejdřív ve Správa → Notifikace přepněte Testovací režim na „Vypnuto – běžný provoz“.');
  const inTest = testQraps_();
  if (!inTest.length) { ui.alert('Žádný otevřený QRAP není v testovacím režimu.'); return; }
  const answer = ui.prompt('Uvolnit upozornění z testu',
    'Otevřené QRAP z testovacího režimu: ' + inTest.join(', ') + '\n\nZadejte čísla oddělená čárkou, nebo nechte prázdné = všechny.',
    ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const typed = list_(String(answer.getResponseText()).toUpperCase().replace(/\s+/g, ','));
  const ids = typed.length ? typed : inTest;
  const unknown = ids.filter(id => inTest.indexOf(id) < 0);
  need_(!unknown.length, 'Tyto QRAP nejsou otevřené v testovacím režimu: ' + unknown.join(', '));
  const res = releaseTestAlerts_(ids);
  ui.alert('Uvolněno: ' + ids.join(', ') + '.\n' + (res.ok ? 'Upozornění zapsána (' + res.written + ').'
    : 'Upozornění se zapíší při další kontrole (do 5 minut).'));
}
/** Open QRAPs whose alerts are still in a test mode (the QRAP column or its snapshot in Alerty_stav). */
function testQraps_() {
  MEMO_ = {}; ALERT_STORE_ = null;
  return table_(TAB.qraps).all.filter(q => {
    if (q.closedAt || q.cancelReason) return false;
    const meta = alertGet_('q:' + q.id);
    return (meta ? meta.testMode : q.alertTestMode) && (meta ? meta.testMode : q.alertTestMode) !== 'NORMAL';
  }).map(q => q.id);
}
function releaseTestAlerts_(ids) {
  lock_(() => {
    ids.forEach(id => {
      const q = find_(id);
      need_(!q.closedAt && !q.cancelReason, 'QRAP ' + id + ' je uzavřený nebo zrušený.');
      ensureQrapColumns_();
      q.alertTestMode = 'NORMAL'; q.alertTestRecipient = '';
      update_(TAB.qraps, q);
      const at = Date.now(), old = alertGet_('q:' + id);
      const meta = old ? JSON.parse(JSON.stringify(old))
        : {id:id, create:cfg_().notif.create.slice(), roles:{}, closed:false};
      Object.assign(meta, {testMode:'NORMAL', testRecipient:'', releasedAt:at});
      alertPut_('q:' + id, meta);
      log_(id, 'Upozornění uvolněna z testovacího režimu – příjemci podle běžného provozu');
    });
    BUMP_ = true;
  });
  return syncAlerts_(ids);
}

/**
 * Menu: every QRAP keeps the APU Manager who was set when it was reported. After the APU Manager changes in
 * Správa → Notifikace, this moves the OPEN QRAPs with "Supervizor výroby" to the current one: the new APU Manager
 * gets the PUSH now, the previous one's notification row is removed. Closed QRAPs keep their history as it was.
 */
function refreshApuManager() {
  menuOnly_();
  const ui = SpreadsheetApp.getUi();
  const spu = readNotif_().spuSupervisor;
  need_(spu, 'Nejdřív ve Správa → Notifikace vyberte APU Managera a uložte.');
  MEMO_ = {};
  const ids = table_(TAB.qraps).all.filter(q => !q.closedAt && !q.cancelReason &&
    list_(q.notified).includes(PRODUCTION_ROLE) && String(q.apuManager || '').toLowerCase() !== spu).map(q => q.id);
  if (!ids.length) { ui.alert('Všechny otevřené QRAP už mají aktuálního APU Managera (' + spu + ').'); return; }
  if (ui.alert('Použít aktuálního APU Managera?', 'APU Manager ' + spu + ' bude nastaven u: ' + ids.join(', ') +
    '.\nDostane upozornění (PUSH na 5 hodin), předchozímu APU Managerovi se upozornění u těchto QRAP odstraní.',
    ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const res = refreshApuManager_(ids, spu);
  ui.alert('Hotovo: ' + ids.join(', ') + '.\n' + (res.ok ? 'Upozornění zapsána (' + res.written + '), odstraněna (' + res.removed + ').'
    : 'Upozornění se zapíší při další kontrole (do 5 minut).'));
}
function refreshApuManager_(ids, spu) {
  lock_(() => {
    requirePushRecipients_([spu]);
    ids.forEach(id => {
      const q = find_(id);
      if (q.closedAt || q.cancelReason || !list_(q.notified).includes(PRODUCTION_ROLE)) return;
      const old = q.apuManager;
      if (String(old || '').toLowerCase() === spu) return;
      ensureQrapColumns_();
      q.apuManager = spu;
      update_(TAB.qraps, q);
      // the new APU Manager's alert starts now (PUSH for 5 h), as for a released QRAP
      const meta = alertGet_('q:' + id);
      if (meta) alertPut_('q:' + id, Object.assign({}, meta, {releasedAt: Date.now()}));
      log_(id, 'APU Manager změněn: ' + (old || '–') + ' → ' + spu);
    });
    BUMP_ = true;
  });
  return syncAlerts_(ids);
}

/** Install once as deployer from the spreadsheet menu (not through google.script.run). */
function installNotificationWorker() {
  menuOnly_();
  const fresh=ScriptApp.newTrigger(ALERTS.HANDLER).timeBased().everyMinutes(5).create();
  ScriptApp.getProjectTriggers().filter(t=>[ALERTS.HANDLER,'dailyReminder'].indexOf(t.getHandlerFunction())>=0 && t.getUniqueId()!==fresh.getUniqueId()).forEach(t=>ScriptApp.deleteTrigger(t));
  PropertiesService.getScriptProperties().setProperty('ALERTS_TRIGGER',fresh.getUniqueId());
  const result=syncAlerts_(null);
  toast_(result.ok?'Upozornění zapnuta: kontrola každých 5 minut.':'Kontrola zapnuta; tabulku upozornění se zatím nepodařilo synchronizovat. Podrobnosti ve Správa → Notifikace.');
  return result;
}
function notificationTick(e) {
  const id=PropertiesService.getScriptProperties().getProperty('ALERTS_TRIGGER');
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  need_((!active || active === runAsEmail_()) && e && e.authMode === ScriptApp.AuthMode.FULL && e.triggerUid && String(e.triggerUid)===id,'Tuto funkci spouští časovač upozornění.');
  return syncAlerts_(null);
}
function dailyReminder(e) { // compatibility for the old trigger during deployment
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  need_((!active || active === runAsEmail_()) && e && e.authMode === ScriptApp.AuthMode.FULL && e.triggerUid && ScriptApp.getProjectTriggers().some(t =>
    t.getHandlerFunction() === 'dailyReminder' && t.getUniqueId() === String(e.triggerUid)), 'Tuto funkci spouští časovač upozornění.');
  return syncAlerts_(null);
}

function deploymentUrl_(value) {
  return /^https:\/\/script\.google\.com\/(?:a(?:\/macros)?\/[A-Za-z0-9.-]+\/(?:macros\/)?|macros\/)s\/[\w-]+\/exec\/?$/.test(String(value || ''));
}
function logoUrl_(value) {
  return /^https:\/\/[^@\s/\\?#]+(?:\/[^\s\\]*)?$/i.test(String(value || '')) ||
    /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(String(value || ''));
}
function link_(id) {
  let url = String(setting_('ODKAZ_APLIKACE') || '');
  if (!deploymentUrl_(url)) { try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; } }
  return url + (id ? '?id=' + encodeURIComponent(id) : '');
}

/** The app's address for the page itself ("Obnovit stránku"); never throws – also used when the start failed. */
function appUrl_() {
  try { return link_(''); } catch (e) { /* settings not readable */ }
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
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
  need_(active && active === runAsEmail_() && sameDomain_(active), 'Tuto funkci spusťte z menu eQRAP v tabulce.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(TAB.people)) {
    const people = readPeople_();
    const self = people.filter(p => p.email === active);
    if (self.length === 1 && self[0].active && self[0].role === 'ADMIN') return;
    // Initial bootstrap or recovery in a personal Drive file is limited to its owner.
    need_(!people.some(p => p.active && p.role === 'ADMIN') && !self.some(p => !p.active), 'Údržbu tabulky může spustit pouze aktivní admin.');
    const owner = ss.getOwner();
    need_(owner && owner.getEmail().toLowerCase() === active, 'Správce musí obnovit oprávnění v listu Lidé.');
  }
}

/** Adds the "eQRAP" menu to the Sheet, so the admin never needs to open the code. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('eQRAP')
    .addItem('Nastavit tabulku (setup)', 'setup')
    .addItem('Aktualizovat formulář a odstranit sloupec Reference', 'upgradeQrapForm')
    .addItem('Použít změny v nastavení hned', 'clearCache')
    .addSeparator()
    .addItem('Zapnout denní dopsání čekajících upozornění', 'installReminder') // NOTIF: no reminders any more
    .addItem('Vypnout denní dopsání upozornění', 'removeReminder') // NOTIF
    .addSeparator()
    .addItem('Zapnout / obnovit automatiku upozornění (5 minut)', 'installNotificationWorker')
    .addItem('Obnovit QRAP z archivu', 'restoreArchivedQrap')
    .addItem('Uvolnit upozornění QRAP z testu', 'releaseTestAlerts')
    .addItem('Použít aktuálního APU Managera v otevřených QRAP', 'refreshApuManager')
    .addSeparator()
    .addItem('Vložit ukázková data', 'exampleData')
    .addToUi();
}

/** Hand edits in the Sheet: settings apply at once, open pages reload at their next refresh. */
function onEdit(e) {
  // A real edit event carries Range objects; a call from a browser (google.script.run) can only send plain JSON.
  if (!e || !e.range || typeof e.range.getSheet !== 'function') return;
  if ([TAB.people, TAB.lists, TAB.settings, NOTIF.TAB].indexOf(e.range.getSheet().getName()) >= 0) clearCache_(); // AUDIT-H6
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
  CacheService.getScriptCache().removeAll(['cfg', 'cfg:v2', CFG_KEY, NOTIF.OSC_KEY, NOTIF.ORG_KEY]); // + OSC list, org chart
  CFG_ = null;
  NOTIF_T_ = null; // NOTIF
  NOTIF_SS_ = null;
  ME_ = null;
  MAILOK_ = null;
  ORG_FRESH_ = false; HR_INDEX_ = HR_SHEET_ = HR_BY_EMAIL_ = null; HR_VERIFIED_.clear();
}

/** Creates (or repairs) all tabs. Safe to run again – it never deletes data. */
function setup() {
  menuOnly_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(tz_());

  [TAB.qraps, TAB.actions, TAB.effects, TAB.assess, TAB.log, TAB.shortages].forEach(name => {
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
    .setHelpText('ANO nebo prázdné = může dostávat upozornění (Správa → Notifikace). NE = nedostane žádné, ani když je v seznamech.').build()); // NOTIF
  // The Role dropdown always offers the current roles (older values still work, see roleOf_).
  people.getRange(2, 3, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(ROLES, true).setAllowInvalid(false)
    .setHelpText('MONITOR jen čte. Uživatel upravuje vlastní hlášení a přidělenou práci. TEAM LEADER doplní opatření a ověření. SUPERVIZOR podepisuje. MANAŽER také ruší a odemyká. ADMIN spravuje aplikaci.').build()); // NOTIF

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

  // NOTIF: tab Notifikace – one row per list (empty = nobody is notified); edited in Správa → Notifikace
  const nt = makeTab_(ss, NOTIF.TAB, ['Kategorie', 'E-maily']);
  const nHave = nt.getDataRange().getValues().map(r => String(r[0]).trim());
  const nAdd = [NOTIF.CREATE].concat((cfg_().lists.alert || []).filter(r => r !== PRODUCTION_ROLE).map(r => NOTIF.ROLE + r))
    .filter(k => nHave.indexOf(k) < 0).map(k => ["'" + k, '']);
  if (nAdd.length) nt.getRange(nt.getLastRow() + 1, 1, nAdd.length, 2).setValues(nAdd);
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

// An existing workbook may still have this retired column. Only this explicit admin menu command deletes it.
const RETIRED_FIELD = '① Reference';
function upgradeQrapForm() {
  menuOnly_();
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert('Aktualizovat formulář?', 'Odstranit sloupec „① Reference“ včetně jeho hodnot z listů Problémy a Problémy - Archiv? Ostatní sloupce budou zachovány.', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  lock_(() => {
    requireRight_(me_().admin);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    for (const name of [TAB.qraps, TAB.qraps + ' - Archiv']) {
      const sheet = ss.getSheetByName(name);
      if (!sheet || !sheet.getLastColumn()) continue;
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      for (let i = headers.length - 1; i >= 0; i--) {
        if (String(headers[i]).trim() === RETIRED_FIELD) sheet.deleteColumn(i + 1);
      }
    }
    ensureQrapColumns_();
    shortageSheet_(true);
    clearCache_();
    WROTE_ = BUMP_ = true;
  });
  toast_('Formulář je aktualizovaný.');
}

function makeTab_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const have = sh.getLastRow() ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(v => String(v).trim()) : [];
  if (name === TAB.qraps) {
    have.forEach((old, i) => {
      const label = qrapHeader_(old);
      if (label === old || have.includes(label)) return;
      sh.getRange(1, i + 1).setValue(label);
      have[i] = label;
    });
  }
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

function installReminder() { return installNotificationWorker(); }

function removeReminder() {
  menuOnly_();
  removeReminder_();
  toast_('Vypnuto.'); // NOTIF
}

function removeReminder_() {
  ScriptApp.getProjectTriggers().filter(t => ['dailyReminder', ALERTS.HANDLER].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  PropertiesService.getScriptProperties().deleteProperty('ALERTS_TRIGGER');
}

/**
 * Vrací konkrétní QRAP z archivu zpět do hlavních listů.
 * Zahrnuje i zobrazení promptu pro zadání ID, pokud je spuštěno z menu.
 */
function restoreArchivedQrap(qrapId) {
  menuOnly_();
  if (!qrapId || typeof qrapId !== 'string') {
    const ui = SpreadsheetApp.getUi();
    const resp = ui.prompt('Obnovit z archivu', 'Zadejte přesné ID QRAPu (např. Q-2026-001):', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    qrapId = String(resp.getResponseText()).trim();
  }
  if (!qrapId) return;
  restoreArchived_(qrapId, false); // CHANGED: the work is shared with Správa → Archiv (apiRestoreArchivedQrap)
  toast_('QRAP ' + qrapId + ' byl úspěšně obnoven z archivu.');
}

/** // CHANGED
 * CHANGED (was the body of restoreArchivedQrap): moves one QRAP's rows from the tabs "<tab> - Archiv" back to the data
 * tabs. viaWeb = from Správa (admins only); from the Sheet menu, as before, whoever can open the menu. // CHANGED
 * Fixed on the way: // CHANGED
 *   - nothing moves unless the QRAP row itself is in the archive and the QRAP is not active already (before, the other // CHANGED
 *     tabs' rows were moved even when the QRAP was not found, and a second restore made duplicates) // CHANGED
 *   - the data tab grows when it is full (a tab filled by appendRow has no empty row: setValues below the last row failed) // CHANGED
 *   - text stays text, as everywhere in the app ("'"): "00123" kept its zeros, "=…" typed by a user no longer runs // CHANGED
 *   - columns are matched by their header; an archive column with data and no place in the data tab stops the restore // CHANGED
 *   - open pages reload (new data version) // CHANGED
 */ // CHANGED
function restoreArchived_(qrapId, viaWeb) {
  if (viaWeb) need_(me_(true).admin, 'Obnovit QRAP z archivu může jen admin.');
  qrapId = idOf_(qrapId);
  lock_(() => {
    requireRight_(me_().admin);
    ensureQrapColumns_();
    const key = 'restore:' + qrapId, ss = SpreadsheetApp.getActiveSpreadsheet();
    let op = operation_(key);
    const active = rowsBy_(TAB.qraps, qrapId).length;
    need_(!(active && (!op || op.state === 'done')), 'QRAP ' + qrapId + ' je už mezi aktivními – není co obnovit.');
    // Preflight all tables before writing. Keep archive copies until every destination is verified.
    const found = [];
    [TAB.qraps, TAB.actions, TAB.effects, TAB.assess, TAB.log, TAB.shortages].forEach(name => {
      const arch = ss.getSheetByName(name + ' - Archiv'); if (!arch) return;
      const data = arch.getDataRange().getValues(), ah = data[0].map(String);
      const keyHeader = COLS[name].find(c => c[0] === KEY_FIELD[name])[1], k = ah.indexOf(keyHeader);
      need_(k >= 0, 'V archivu chybí sloupec ' + keyHeader + '.');
      const source = data.slice(1).filter(r => String(r[k]) === qrapId);
      if (name === TAB.shortages) shortageSheet_(true);
      const sh = sheet_(name);
      const h = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(String);
      if (name === TAB.assess && source.length && ah.includes('Klíč hodnocení') && !h.includes('Klíč hodnocení')) {
        if (h.length === sh.getMaxColumns()) sh.insertColumnsAfter(h.length,1);
        h.push('Klíč hodnocení'); sh.getRange(1,h.length).setValue('Klíč hodnocení');
      }
      const from = h.map(x => {
        const exact = ah.indexOf(x);
        if (exact >= 0 || name !== TAB.qraps) return exact;
        return ah.findIndex(header => qrapHeader_(header) === qrapHeader_(x));
      });
      const lost = ah.filter((x,i) => from.indexOf(i)<0 && !(name === TAB.qraps && x === RETIRED_FIELD) && source.some(r => r[i] !== '' && r[i] !== null));
      need_(!lost.length, 'List „' + name + '“ nemá sloupce: ' + lost.join(', '));
      const rows = source.map(r => from.map(i => i < 0 ? '' : r[i]));
      found.push({name, arch, sh, k, rows, head:h, from:from});
    });
    if (!op || op.state === 'done') {
      need_(found.some(t => t.name === TAB.qraps && t.rows.length), 'QRAP nebyl v archivu nalezen.');
      op = {state:'copy', logs:[{at:nowIso_(), by:who_(), qrapId:qrapId, text:'Systém obnovil QRAP z archivu na žádost administrátora.'}]};
      saveOperation_(key, op);
    }
    const rowKey = row => digest_(row.map(v => v instanceof Date ? v.toISOString() : String(v === null ? '' : v)));
    if (op.state === 'copy') {
      found.forEach(t => {
        const counts = {};
        t.sh.getDataRange().getValues().slice(1).forEach(r => { const h=rowKey(r); counts[h]=(counts[h]||0)+1; });
        const required = {};
        t.rows.forEach(row => {
          const h=rowKey(row), n=required[h]=(required[h]||0)+1;
          if ((counts[h]||0) >= n) return;
          const fields = t.name === TAB.qraps ? ['id'] : t.name === TAB.actions ? ['qrapId','no'] : t.name === TAB.effects ? ['qrapId','round','slot'] : t.name === TAB.assess ? ['qrapId','at','by'] : [];
          const cols = fields.map(f => t.head.indexOf(COLS[t.name].find(c=>c[0]===f)[1]));
          const existing = t.sh.getDataRange().getValues().slice(1);
          need_(!cols.length || !existing.some(r=>cols.every(i=>String(r[i])===String(row[i]))), 'Řádek v listu ' + t.name + ' byl během obnovy změněn. Archiv zůstal zachován; kontaktujte správce.');
          const start=t.sh.getLastRow()+1;
          if (start>t.sh.getMaxRows()) t.sh.insertRowsAfter(t.sh.getMaxRows(),1);
          t.sh.getRange(start,1,1,row.length).setValues([row.map(v=>typeof v==='string'&&v!==''?"'"+v:v)]);
          WROTE_=true; BUMP_=true; counts[h]=(counts[h]||0)+1;
        });
        // Read back before any archived data is deleted.
        const verified={};
        t.sh.getDataRange().getValues().slice(1).forEach(r=>{const h=rowKey(r);verified[h]=(verified[h]||0)+1;});
        need_(Object.keys(required).every(h=>(verified[h]||0)>=required[h]), 'Obnova nebyla ověřena. Archiv zůstal zachován; zkuste znovu.');
      });
      op.state='cleanup'; saveOperation_(key,op);
    }
    for (const t of found) {
      const live = t.sh.getDataRange().getValues().slice(1), counts = new Map();
      live.forEach(r => { const key = rowKey(r); counts.set(key, (counts.get(key) || 0) + 1); });
      const archived = t.arch.getDataRange().getValues();
      const toRemove = [];
      for (let i=1; i<archived.length; i++) {
        if (String(archived[i][t.k]) !== qrapId) continue;
        const key = rowKey(t.from.map(j => j < 0 ? '' : archived[i][j]));
        need_(counts.get(key) > 0, 'Archiv nebo obnovená data se změnily. Zbývající řádky zůstaly v archivu.');
        counts.set(key, counts.get(key)-1);
        toRemove.push(i+1);
      }
      t.cleanupRows = toRemove;
    }
    for (const t of found) {
      for (const row of t.cleanupRows.reverse()) {
        if (t.arch.getMaxRows()-1 <= t.arch.getFrozenRows()) t.arch.insertRowsAfter(t.arch.getMaxRows(),1);
        t.arch.deleteRows(row,1); WROTE_=true; BUMP_=true;
      }
    }
    MEMO_ = {};
    operationHistory_(op); op.state='done'; saveOperation_(key,op);
  });
  return {ok:true};
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
    const lead = orgPeople_(true).people[0];
    need_(lead, 'Pro ukázková data je nutná alespoň jedna osoba dostupná v HR.');
    const base = { safety: 'NE', repeat7: 'NE', finder: lead.e, notified: pick(L.alert, 'Team Leader') };
    create_(Object.assign({}, base, { token:Utilities.getUuid(),
      how: pick(L.how, 'skladování'), what: pick(L.problems, 'poškozené zboží / obal'), when: hoursAgo(2),
      zone: pick(L.zones, 'Sklad'), qty: 2, unit: pick(L.units, 'krabice'),
      descWrong: 'Promáčknutý obal na paletě B-12-03, 2 krabice poškozené', descRight: 'Obal celý, krabice bez poškození',
      s3: { risk: 'NE', ia: [{text:'Paleta označena', owner:lead.e}] }
    }));
    b = create_(Object.assign({}, base, { token:Utilities.getUuid(),
      how: pick(L.how, 'kontrola expedice'), what: pick(L.problems, 'chybí / špatná etiketa'), when: hoursAgo(5),
      zone: pick(L.zones, 'Expedice'), qty: 4, unit: pick(L.units, 'krabice'),
      descWrong: 'Rampa 3: na 4 boxech chybí etiketa zákazníka', descRight: 'Každý box má etiketu zákazníka na čelní straně',
      notified: [pick(L.alert, 'Team Leader'), pick(L.alert, LOGISTICS_ROLE)].join(', '),
      s3: { risk: 'ANO', checked: 40, wrong: 4,
        ia: [{ text: 'Etikety doplněny na všech 4 boxech', owner: lead.e, done: hoursAgo(4) }] }
    })).qrap.id;
    c = create_(Object.assign({}, base, { token:Utilities.getUuid(),
      how: pick(L.how, 'reklamace zákazníka'), what: pick(L.problems, 'špatné množství'), when: hoursAgo(50),
      zone: pick(L.zones, 'Nakládka'), qty: 1, unit: pick(L.units, 'palety'),
      descWrong: 'Zákazník obdržel o 1 paletu méně, než je na dodacím listu', descRight: 'Počet palet = počet na dodacím listu',
      notified: [pick(L.alert, LOGISTICS_ROLE), pick(L.alert, 'Logistika / nákup')].join(', '),
      s3: { risk: 'NE', ia: [{ text: 'Chybějící paleta odeslána expresem', owner: lead.e, done: hoursAgo(48) }] }
    })).qrap.id;
    save_(c, 'rozhodnuti', { decision: 'POKRAČOVAT', decisionNote: 'Opakuje se podruhé tento měsíc', pilots: lead.e, version:recordRevision_(find_(c)),
      shifts: L.shifts.join(', ') });
    save_(c, 'pricina', { _fp:fpQ_(find_(c),'pricina',actionsOf_(c)), o1: 'Paleta nebyla naložena', o2: 'Nebyla na nakládacím seznamu',
      o3: 'Seznam se tiskl před posledním vychystáním', rootO: 3, n1: 'Počet palet se při nakládce nekontroluje', rootN: 1,
      learned: 'Nakládací seznam až po potvrzení vychystání', std: 'NE' });
    const due = Utilities.formatDate(new Date(Date.now() + 7 * 864e5), tz_(), 'yyyy-MM-dd');
    saveAction_(c, { text: 'Tisknout nakládací seznam až po potvrzení vychystání ve WMS', kind: 'O3', token:Utilities.getUuid(), owner:lead.e, due:due });
    const r = saveAction_(c, { text: 'Kontrola počtu palet při nakládce (podpis řidiče)', kind: 'N1', token:Utilities.getUuid(), owner:lead.e, due:due });
    const last = r.actions.filter(a => a.part === '⑥').pop();
    saveAction_(c, {no:last.no, done:true, _fp:fp_(FP_FIELDS.akce.map(k => last[k]))});
  } finally {
    NO_MAIL_ = false;
  }
  toast_('Ukázková data vložena (' + b + ', ' + c + ' a jeden nový).');
}

function toast_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'eQRAP', 10); } catch (e) { /* not in the Sheet */ }
  console.log(msg);
}