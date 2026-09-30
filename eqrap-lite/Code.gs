/**
 * eQRAP Expedice (Lite) – server part. Everything the server does is in this one file.
 *
 * The questions and rules follow the firm's QRAP V3.0 form (logistics version), sections ① to ⑦.
 * Left out on purpose because they only apply to production / APU: APU and plant-level copies of a QRAP.
 *
 * HOW IT FITS TOGETHER
 *   Google Sheet = database + all settings
 *                  data tabs:     Problémy, Akce, Ověření, Hodnocení, Historie
 *                  settings tabs: Lidé, Seznamy, Nastavení   (the admin edits only these)
 *   Code.gs      = reads/writes the Sheet, checks who may do what, sends e-mails
 *   Index.html   = the whole screen; it receives all data when the page opens, so clicking around is instant
 *
 * ROLES (tab Lidé, column Role)
 *   (empty)   operators and anyone: report ①②, the ③ risk question, finish ③, 5-shift check, own action done
 *   VEDOUCÍ   TL / leaders: ③, sign ④, choose pilots, ⑤ ⑥, ⑦
 *   MANAŽER   any number of people, all with the same rights: like VEDOUCÍ + close QRAPs, cancel / reopen /
 *             unlock, escalations, dashboard
 *   ADMIN     like MANAŽER + the page "Správa" (people, lists, settings). The owner of the script is always ADMIN.
 *   KIOSK     the shared kiosk account. On the kiosk a person types their name at every signature;
 *             the app then acts with that person's role (never with admin rights).
 *
 * SECTIONS
 *   1. Tabs, columns, defaults     5. Permissions (who may do what)
 *   2. Web app entry (doGet)       6. Sheet helpers and form checks
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

// [name used in the code, column header in the Sheet]. Do not rename these headers in the Sheet.
const COLS = {
  'Problémy': [
    ['id', 'ID'], ['status', 'Stav'], ['created', 'Nahlášeno'], ['createdBy', 'Účet'],
    // ① POPIS PROBLÉMU
    ['safety', '① SAFETY'], ['what', '① CO je za problém?'], ['how', '① JAK byl objeven?'], ['howOther', '① JAK – jiné'],
    ['when', '① KDY?'], ['zone', '① KDE? – zóna'], ['location', '① KDE? – lokace'], ['originZone', '① Kde vzniklo?'],
    ['qty', '① KOLIK?'], ['unit', '① Jednotka'], ['nokSituation', '① NOK situace bez kusů'],
    ['repeat7', '① Stejný problém v posledních 7 dnech?'], ['repeatRef', '① Opakovaný QRAP'],
    ['finder', '① JMÉNO'],
    ['materialNo', '① Číslo materiálu'], ['huNo', '① Číslo HU / dodacího listu'], ['supplier', '① Dodavatel'],
    ['photoWrong', '① Foto ŠPATNĚ'], ['photoRight', '① Foto SPRÁVNĚ'], ['photoException', '① Výjimka – proč nejsou fotky'],
    // ② KDO BYL UPOZORNĚN?
    ['notified', '② Upozorněni'], ['notifiedOther', '② Jiné – kdo'], ['notifyPeople', '② Informovat e-mailem'],
    // ③ OKAMŽITÁ OPATŘENÍ <24h (the actions themselves are rows in the tab Akce, part ③)
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

// Tab "Nastavení": [key, default value, explanation shown next to it]
const SETTINGS = [
  ['NAZEV', 'eQRAP Expedice', 'Název aplikace – nahoře na stránce a v e-mailech.'],
  ['EMAILY', 'ANO', 'ANO = posílat e-maily, NE = neposílat (např. při zkoušení).'],
  ['EMAIL_KVALITA', '', 'E-mail Kvality – dostane zprávu, když je riziko u zboží na skladě / expedovaného (③ = ANO).'],
  ['EMAIL_BOZP', '', 'E-mail BOZP / EHS – dostane zprávu o každém problému se SAFETY = ANO.'],
  ['LHUTA_OPATRENI_HODIN', 24, 'Do kolika hodin od KDY mají být hotová ③ okamžitá opatření.'],
  ['ZOBRAZIT_UZAVRENE_DNI', 60, 'Kolik dní zpět se na přehledu ukazují uzavřené problémy.'],
  ['KIOSK_NAVRAT_SEKUND', 120, 'Kiosk: po kolika sekundách bez dotyku se obrazovka vrátí na přehled.'],
  ['ODKAZ_APLIKACE', '', 'Adresa aplikace do e-mailů. Prázdné = zjistí se automaticky.'],
  ['FOTKY_SLOZKA_ID', '', 'ID složky na Disku Google pro fotky. Vyplní se samo při setupu.']
];

// Tab "Seznamy": [name in code, column header, default values]. The admin edits the values in the Sheet.
const LISTS = [
  ['zones', 'Zóny', ['Příjem', 'Sklad', 'Vychystávání', 'Balení', 'Expedice', 'Nakládka']],
  ['how', 'JAK byl objeven', ['příjem zboží', 'skladování', 'vychystávání', 'balení', 'kontrola expedice', 'inventura',
    'reklamace zákazníka', 'dodávka dodavatele', 'jiné']],
  ['units', 'Jednotky', ['ks', 'krabice', 'palety', 'manipulační jednotky']],
  ['alert', 'Kdo byl upozorněn', ['Team Leader', 'Supervizor', 'Kvalita', 'Vedoucí logistiky', 'Nákup / dodavatel',
    'Údržba (VZV, zařízení)', 'jiné']],
  ['iaTypes', 'Typy okamžitých opatření', ['blokace / karanténa zásob', 'přeetiketování', 'přebalení', 'pozdržení expedice',
    'informovat zákazníka / dodavatele', 'jiné']],
  ['shifts', 'Směny', ['Ranní', 'Odpolední', 'Noční']]
];

// Example people written by setup. The admin replaces them with real colleagues.
const EXAMPLE_PEOPLE = [
  ['Jana Nováková', 'jana.novakova@example.com', 'VEDOUCÍ', 'Expedice', 'ANO'],
  ['Petr Svoboda', 'petr.svoboda@example.com', 'VEDOUCÍ', 'Sklad', 'ANO'],
  ['Eva Dvořáková', 'eva.dvorakova@example.com', 'MANAŽER', '', 'ANO'],
  ['Tomáš Černý', 'tomas.cerny@example.com', '', 'Expedice', 'ANO'],
  ['Kiosk Expedice', 'kiosk.expedice@example.com', 'KIOSK', 'Expedice', 'ANO']
];

const DECISIONS = {
  'POKRAČOVAT': 'Pokračovat s analýzou a 5 Proč',
  'VYŘEŠENO': 'Problém vyřešen: ŽÁDNÉ 5 Proč',
  'ESKALACE': 'Eskalace na vyšší úroveň (manažer)'
};
const EFF_RESULTS = ['EFEKTIVNÍ', 'NEOVĚŘENO', 'NEEFEKTIVNÍ'];
const ROLES = ['VEDOUCÍ', 'MANAŽER', 'ADMIN', 'KIOSK'];
const ASSESS_VALUES = ['OK', 'NOK', 'N/A'];
const FEEDBACK_TYPES = ['pochvala', 'silná stránka', 'ke zlepšení'];
const NEXT_STEP = {
  'OPATŘENÍ': '③ okamžitá opatření', 'ROZHODNUTÍ': '④ rozhodnutí', 'ANALÝZA': '⑤ 5 Proč a ⑥ konečné akce',
  'AKCE': '⑥ konečné akce', 'OVĚŘENÍ': '⑥ efektivita 5 směn a uzavření manažerem', 'SCHVÁLENÍ': 'uzavření manažerem'
};

// Per-request memory (each server call starts with empty values).
let MEMO_ = {};
let CFG_ = null;
let ME_ = null;
let REAL_ = null; // the Google account of this request, when ME_ is a person signing on the kiosk
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
  return Object.assign(listData_(false), {
    me: me_(),
    cfg: publicSettings_(c.settings),
    lists: c.lists,
    people: c.people.filter(p => p.active && p.role !== 'KIOSK').map(p => ({ name: p.name, email: p.email, role: p.role })),
    params: { id: String(params.id || ''), view: String(params.view || ''), kiosk: String(params.kiosk || '') }
  });
}

// =====================================================================================
// 3. API – functions the page calls with google.script.run
//    Each one checks permissions itself, saves, and returns the fresh problem.
// =====================================================================================

/** Reload the list (auto-refresh and the ⟳ button). all = include old closed problems. */
function apiRefresh(all) {
  return listData_(!!all);
}

/** One problem with everything that belongs to it (the page calls this when a problem is opened). */
function apiGet(id) {
  return pack_(id);
}

/** ① ② ③ – report a new problem. Anyone in the company may do this. ③ needs only the risk answer now. */
function apiCreate(f) {
  f = f || {};
  const s3in = f.s3 || {};
  const q = popisFrom_(f);
  Object.assign(q, opatreniFrom_(s3in, q.when));
  const ia = (s3in.ia || []).filter(r => !r.remove).map(r => iaFields_(r, q.when));
  need_((f.photoWrong && f.photoRight) || q.photoException.length >= 3,
    'Chybí Foto ŠPATNĚ a Foto SPRÁVNĚ (nebo výjimka s důvodem).');
  if (f.photoWrong && f.photoRight) q.photoException = '';
  const pw = f.photoWrong ? savePhoto_(f.photoWrong) : '';
  const pr = f.photoRight ? savePhoto_(f.photoRight) : '';
  return lock_(() => {
    q.id = nextId_(table_(TAB.qraps).rows);
    checkRepeat_(q);
    q.created = nowIso_();
    q.createdBy = me_().email;
    q.photoWrong = pw;
    q.photoRight = pr;
    addQuality_(q);
    ia.forEach((r, i) => insert_(TAB.actions, Object.assign({ qrapId: q.id, no: i + 1, part: '③', created: nowIso_() }, r)));
    finish_(q, 'Nahlášeno: ' + short_(q.what), true);
    mailNew_(q);
    return pack_(q.id);
  });
}

/**
 * Save one part of the form.
 *   'popis' ① ② · 'opatreni' ③ · 'smeny' ④ shifts informed · 'rozhodnuti' ④ decision (signature)
 *   'piloti' add pilots · 'pricina' ⑤ · 'uzavreni' ⑥ closure signature
 */
function apiSave(id, part, f) {
  f = f || {};
  return lock_(() => {
    const me = signAs_(f.signer);
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id), effectsOf_(id));
    let text;

    if (part === 'popis') {
      need_(canPopis_(me, q), 'Popis ① ② může upravit ten, kdo problém nahlásil, nebo vedoucí – jen do rozhodnutí ④.');
      const before = q.safety;
      Object.assign(q, popisFrom_(f));
      need_((q.photoWrong && q.photoRight) || q.photoException.length >= 3, 'Chybí Foto ŠPATNĚ a Foto SPRÁVNĚ (nebo výjimka s důvodem).');
      if (q.photoWrong && q.photoRight) q.photoException = '';
      checkRepeat_(q);
      addQuality_(q);
      if (q.safety === 'ANO' && before !== 'ANO') mailSafety_(q);
      text = '①② Popis upraven';

    } else if (part === 'opatreni') {
      need_(canOpatreni_(me, q), 'Okamžitá opatření ③ lze měnit jen do rozhodnutí ④.');
      const before = q.risk;
      const s = opatreniFrom_(f, q.when);
      const rows = (f.ia || []).map(r => (r.remove ? r : Object.assign({ no: r.no }, iaFields_(r, q.when))));
      Object.assign(q, s);
      syncIa_(q.id, rows);
      addQuality_(q);
      if (q.risk === 'ANO' && before !== 'ANO') mailQuality_(q);
      text = '③ Okamžitá opatření uložena';

    } else if (part === 'smeny') {
      need_(canShifts_(me, q), 'Směny označuje vedoucí – jen do rozhodnutí ④.');
      q.shifts = onlyFrom_(f.shifts, cfg_().lists.shifts);
      text = '④ Informované směny: ' + (q.shifts || '–');

    } else if (part === 'rozhodnuti') {
      need_(me.lead, 'Rozhodnutí ④ podepisuje vedoucí nebo manažer.');
      need_(!q.decision, 'Rozhodnutí už je podepsané. Změnit ho může manažer (Správa → Odemknout).');
      need_(canDecide_(me, q), 'Rozhodnutí je možné, až jsou okamžitá opatření ③ kompletní.');
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
      if (d === 'VYŘEŠENO' && me.manager) { q.closedAt = q.decisionAt; q.closedBy = me.name; } // else: waits for a manager
      text = '④ Rozhodnutí podepsáno: ' + DECISIONS[d] + (pilots.length ? ' · piloti: ' + pilots.join(', ') : '');
      if (pilots.length) mailPilots_(q, pilots);
      if (d === 'ESKALACE') mailEscalated_(q);

    } else if (part === 'piloti') {
      need_(me.lead && isAnalysis_(q), 'Piloty přidává vedoucí během analýzy.');
      const have = list_(q.pilots);
      const added = emailsOf_(f.pilots).filter(e => have.indexOf(e) < 0);
      need_(added.length, 'Vyberte nového pilota.');
      q.pilots = have.concat(added).join(',');
      mailPilots_(q, added);
      text = '⑤ Přidán pilot: ' + added.join(', ');

    } else if (part === 'pricina') {
      need_(canAnalyze_(me, q), '5 Proč vyplňují piloti a vedoucí během analýzy.');
      Object.assign(q, pricinaFrom_(f));
      syncStdAction_(q);
      text = '⑤ Analýza 5 Proč uložena';

    } else if (part === 'uzavreni') {
      need_(me.manager, 'QRAP uzavírá manažer.');
      if (q.status !== 'SCHVÁLENÍ') {
        const miss = checklist_(q, actionsOf_(id), effState_(effectsOf_(id))).filter(c => !c.ok).map(c => c.label);
        need_(!miss.length, 'QRAP zatím nelze uzavřít. Chybí: ' + miss.join(', ') + '.');
      }
      q.closedAt = nowIso_();
      q.closedBy = me.name;
      text = '⑥ Uzavření QRAP podepsáno';

    } else {
      throw new Error('Neznámá část formuláře: ' + part);
    }
    finish_(q, text);
    return pack_(id);
  });
}

/**
 * ⑥ Add or change a definitive action.
 *   new:    {text, kind, owner, due, evidence, note}          – pilots and leaders
 *   change: {no, text, kind, owner, due, done, evidence, note, remove} – pilots and leaders
 *   own:    {no, done, evidence, note}                          – the pilot of this one action
 */
function apiSaveAction(id, a) {
  a = a || {};
  return lock_(() => {
    const me = signAs_(a.signer);
    const q = find_(id);
    const acts = actionsOf_(id);
    q.status = statusOf_(q, acts, effectsOf_(id));
    const analyst = canAnalyze_(me, q);
    let text;
    if (a.no) {
      const act = acts.filter(x => x.no === Number(a.no) && x.part === '⑥')[0];
      need_(act && !act.removed, 'Akce nenalezena.');
      need_(isAnalysis_(q) && (analyst || (!!me.email && act.ownerEmail === me.email)),
        'Akci může měnit její pilot, piloti QRAP nebo vedoucí.');
      if (analyst && a.text !== undefined) {
        const before = act.ownerEmail;
        Object.assign(act, defActionFields_(a, q));
        if (act.due && !act.dueFirst) act.dueFirst = act.due;
        if (act.ownerEmail && act.ownerEmail !== before) mailAction_(q, act);
      }
      if (analyst && a.remove === true) act.removed = 'ANO';
      if (a.evidence !== undefined) act.evidence = url_(a.evidence);
      if (a.note !== undefined) act.note = txt_(a.note, 500);
      if (a.done === true && !act.done) act.done = nowIso_();
      else if (typeof a.done === 'string' && a.done) {
        need_(day_(a.done) <= Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'), 'Datum hotovo nemůže být v budoucnosti.');
        act.done = dayIso_(a.done);
      }
      else if ((a.done === false || a.done === '') && analyst) act.done = '';
      update_(TAB.actions, act);
      text = '⑥ Akce ' + act.no + (act.removed ? ' odebrána' : act.done ? ' hotová' : ' upravena') + ': ' + short_(act.text);
    } else {
      need_(analyst, 'Konečné akce zadávají piloti a vedoucí během analýzy.');
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
    return pack_(id);
  });
}

/** ⑥ Efektivita – 5 směn: one slot {slot, date, shift, result, by}. "NEEFEKTIVNÍ" sends the QRAP back to analysis. */
function apiSaveEffect(id, p) {
  p = p || {};
  return lock_(() => {
    const me = me_();
    const q = find_(id);
    const rows = effectsOf_(id);
    q.status = statusOf_(q, actionsOf_(id), rows);
    need_(q.status === 'OVĚŘENÍ', 'Efektivita se zapisuje ve stavu „Ověření 5 směn“ (všechny akce hotové).');
    const eff = effState_(rows);
    const slot = Number(p.slot);
    const date = txt_(p.date, 10);
    const shift = txt_(p.shift, 50);
    const result = oneOf_(p.result, EFF_RESULTS, 'Vyberte výsledek.');
    const by = txt_(p.by, 100) || me.name;
    need_(slot >= 1 && slot <= 5, 'Neplatný slot.');
    need_(/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'),
      'Datum směny musí být vyplněné a nesmí být v budoucnosti.');
    need_(cfg_().lists.shifts.indexOf(shift) >= 0, 'Vyberte směnu.');
    need_(by, 'Kdo zkontroloval?');
    const current = eff.slots[slot - 1];
    need_(!current || current.result !== 'EFEKTIVNÍ', 'Efektivní slot už nelze změnit.');
    need_(result !== 'EFEKTIVNÍ' || !eff.slots.some((s, i) => s && i !== slot - 1 && s.result === 'EFEKTIVNÍ' &&
      s.date === date && s.shift === shift), 'Každý efektivní slot musí být jiná směna (datum + směna).');
    const values = { date: date, shift: shift, result: result, by: by, at: nowIso_() };
    if (current) { Object.assign(current, values); update_(TAB.effects, current); }
    else insert_(TAB.effects, Object.assign({ qrapId: id, round: eff.round, slot: slot }, values));
    if (result === 'NEEFEKTIVNÍ') mailNotEffective_(q);
    finish_(q, '⑥ Efektivita – kolo ' + eff.round + ', slot ' + slot + ': ' + result + ' (' + date + ', ' + shift + ')');
    return pack_(id);
  });
}

/** ⑦ Hodnocení QRQC – one more assessment (a QRAP can be assessed many times). */
function apiAssess(id, f) {
  f = f || {};
  return lock_(() => {
    const me = signAs_(f.signer);
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id), effectsOf_(id));
    need_(canAssess_(me, q), 'Hodnotí vedoucí nebo manažer.');
    const row = { qrapId: id, at: nowIso_(), by: me.name };
    ['c1', 'c2', 'c3', 'c4', 'c5'].forEach(k => { row[k] = oneOf_(f[k], ASSESS_VALUES, 'Ohodnoťte všech 5 bodů (OK / NOK / N/A).'); });
    row.ojtWith = txt_(f.ojtWith, 200);
    row.feedback = txt_(f.feedback);
    row.feedbackType = f.feedbackType ? oneOf_(f.feedbackType, FEEDBACK_TYPES, 'Neplatný typ zpětné vazby.') : '';
    insert_(TAB.assess, row);
    finish_(q, '⑦ Hodnocení QRQC (' + ['c1', 'c2', 'c3', 'c4', 'c5'].map(k => row[k]).join(' / ') + ')');
    return pack_(id);
  });
}

/** ① Replace one photo. kind = 'WRONG' (Foto ŠPATNĚ) or 'RIGHT' (Foto SPRÁVNĚ). */
function apiSetPhoto(id, kind, dataUrl) {
  return lock_(() => {
    const me = me_();
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id), effectsOf_(id));
    need_(canPopis_(me, q), 'Fotku může změnit ten, kdo problém nahlásil, nebo vedoucí – jen do rozhodnutí ④.');
    const key = kind === 'RIGHT' ? 'photoRight' : 'photoWrong';
    q[key] = savePhoto_(dataUrl);
    if (q.photoWrong && q.photoRight) q.photoException = '';
    finish_(q, '① Nahrána fotka ' + (kind === 'RIGHT' ? 'SPRÁVNĚ' : 'ŠPATNĚ'));
    return pack_(id);
  });
}

/** Returns one photo as a data URL. Only the two photos of this problem can be read. */
function apiPhoto(id, fileId) {
  const q = find_(id);
  need_(!!fileId && (fileId === q.photoWrong || fileId === q.photoRight), 'Fotka k tomuto problému nepatří.');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/** Change history of one problem, newest first. */
function apiHistory(id) {
  return table_(TAB.log).rows.filter(r => r.qrapId === id).reverse()
    .map(r => ({ at: r.at, by: r.by, text: r.text }));
}

/**
 * Manager only (reason always required):
 *   'cancel' an open problem · 'reopen' a closed / cancelled one · 'unlock' ①–④ (cancels the decision)
 */
function apiAdmin(id, op, reason, signer) {
  return lock_(() => {
    const me = signAs_(signer);
    need_(me.manager, 'Tuto akci může provést jen manažer.');
    const q = find_(id);
    q.status = statusOf_(q, actionsOf_(id), effectsOf_(id));
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
    } else if (op === 'unlock') {
      need_(q.decision && isOpen_(q), 'Odemknout lze jen otevřený QRAP s podepsaným rozhodnutím.');
      clearDecision_(q);
      text = 'Odemčeno ①–④ (rozhodnutí zrušeno): ' + why;
    } else {
      throw new Error('Neznámá operace.');
    }
    finish_(q, text);
    return pack_(id);
  });
}

// ---- Správa (ADMIN only): people, lists and settings from the web page instead of the Sheet

/** Everything the page "Správa" shows. */
function apiAdminData() {
  need_(me_().admin, 'Správa je jen pro admina.');
  clearCache();
  const c = cfg_();
  return {
    people: c.people.map(p => ({ row: p.row, name: p.name, email: p.email, role: p.role, area: p.area, active: p.active })),
    lists: LISTS.map(l => ({ key: l[0], title: l[1], values: c.lists[l[0]] })),
    settings: SETTINGS.filter(x => x[0] !== 'FOTKY_SLOZKA_ID').map(x => ({ key: x[0], value: c.settings[x[0]], help: x[2] })),
    roles: ROLES,
    boot: { people: c.people.filter(p => p.active).map(p => ({ name: p.name, email: p.email, role: p.role })), lists: c.lists,
      cfg: publicSettings_(c.settings) }
  };
}

/** Add a person (no row) or change one (row = the row number in Lidé). People are never deleted – set active false. */
function apiSavePerson(p) {
  p = p || {};
  need_(me_().admin, 'Správa je jen pro admina.');
  return lock_(() => {
    clearCache();
    const people = cfg_().people;
    const v = [txt_(p.name, 100), txt_(p.email, 100).toLowerCase(), p.role ? oneOf_(p.role, ROLES, 'Neplatná role.') : '',
      txt_(p.area, 100), p.active === false ? 'NE' : 'ANO'];
    need_(v[0], 'Vyplňte jméno.');
    need_(/^[^@\s]+@[^@\s]+$/.test(v[1]), 'Vyplňte platný e-mail.');
    const row = Number(p.row) || 0;
    need_(!people.some(x => x.email === v[1] && x.row !== row), 'Tento e-mail už v seznamu je.');
    const sh = sheet_(TAB.people);
    if (row) {
      need_(people.some(x => x.row === row), 'Osoba nenalezena.');
      sh.getRange(row, 1, 1, 5).setValues([v.map(x => "'" + x)]);
    } else {
      sh.appendRow(v.map(x => "'" + x));
    }
    log_('SPRÁVA', 'Lidé: ' + v[0] + ' <' + v[1] + '> ' + (v[2] || 'bez role') + (v[4] === 'NE' ? ' (neaktivní)' : ''));
    clearCache();
    return apiAdminData();
  });
}

/** Replace one list of the tab Seznamy (one value per item, empty values dropped). */
function apiSaveList(key, values) {
  need_(me_().admin, 'Správa je jen pro admina.');
  const l = LISTS.filter(x => x[0] === key)[0];
  need_(l, 'Neznámý seznam.');
  const vals = (Array.isArray(values) ? values : []).map(v => txt_(v, 100)).filter((v, i, a) => v && a.indexOf(v) === i);
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
    log_('SPRÁVA', 'Seznam „' + l[1] + '“: ' + vals.join(', '));
    clearCache();
    return apiAdminData();
  });
}

/** Change settings (only the keys of the tab Nastavení, checked). */
function apiSaveSettings(obj) {
  obj = obj || {};
  need_(me_().admin, 'Správa je jen pro admina.');
  const numbers = ['LHUTA_OPATRENI_HODIN', 'ZOBRAZIT_UZAVRENE_DNI', 'KIOSK_NAVRAT_SEKUND'];
  const clean = {};
  Object.keys(obj).forEach(k => {
    need_(SETTINGS.some(x => x[0] === k) && k !== 'FOTKY_SLOZKA_ID', 'Neznámé nastavení ' + k);
    let v = txt_(obj[k], 300);
    if (numbers.indexOf(k) >= 0) { need_(/^\d+$/.test(v) && Number(v) > 0, k + ': zadejte kladné číslo.'); v = Number(v); }
    if (k === 'EMAILY') v = oneOf_(v, ['ANO', 'NE'], 'EMAILY: ANO nebo NE.');
    if (k === 'EMAIL_KVALITA' || k === 'EMAIL_BOZP') need_(!v || /^[^@\s]+@[^@\s]+$/.test(v), k + ': neplatný e-mail.');
    if (k === 'ODKAZ_APLIKACE') need_(!v || /^https:\/\//.test(v), 'Odkaz aplikace musí začínat https://');
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
    log_('SPRÁVA', 'Nastavení: ' + Object.keys(clean).map(k => k + ' = ' + clean[k]).join(', '));
    clearCache();
    return apiAdminData();
  });
}

function publicSettings_(settings) {
  const o = Object.assign({}, settings);
  delete o.FOTKY_SLOZKA_ID;
  return o;
}

function clearDecision_(q) {
  Object.assign(q, { decision: '', decisionNote: '', decisionBy: '', decisionAt: '', closedAt: '', closedBy: '' });
}

// =====================================================================================
// 4. STATUS RULES – the status is always calculated from what is filled in
// =====================================================================================

/**
 * OPATŘENÍ → ROZHODNUTÍ → (VYŘEŠENO → SCHVÁLENÍ) | ANALÝZA → AKCE → OVĚŘENÍ → UZAVŘENO (only a manager closes)
 * ANALÝZA: root cause not marked or no action yet (after "neefektivní" a NEW action is needed).
 */
function statusOf_(q, acts, effs) {
  if (q.cancelReason) return 'ZRUŠENO';
  if (q.closedAt) return 'UZAVŘENO';
  if (!q.s3Done) return 'OPATŘENÍ';
  if (!q.decision) return 'ROZHODNUTÍ';
  if (q.decision === 'VYŘEŠENO') return 'SCHVÁLENÍ'; // signed by a leader: a manager approves the closure
  const defs = defActions_(acts);
  const eff = effState_(effs);
  const thisRound = eff.reopenAt ? defs.filter(a => a.created > eff.reopenAt) : defs;
  if (!rootOk_(q) || !defs.length || !thisRound.length) return 'ANALÝZA';
  if (defs.some(a => !a.done)) return 'AKCE';
  return 'OVĚŘENÍ';
}

function isOpen_(q) { return q.status !== 'UZAVŘENO' && q.status !== 'ZRUŠENO'; }
function isAnalysis_(q) { return ['ANALÝZA', 'AKCE', 'OVĚŘENÍ'].indexOf(q.status) >= 0; }
function defActions_(acts) { return acts.filter(a => a.part === '⑥' && !a.removed); }
function iaActions_(acts) { return acts.filter(a => a.part === '③' && !a.removed); }
function rootOk_(q) { return !!((q.rootO && q['o' + q.rootO]) || (q.rootN && q['n' + q.rootN])); }

/** Which ③ rules are not met yet (empty list = ③ complete). */
function s3Missing_(q, ia) {
  const m = [];
  if (!q.risk) m.push('odpověď na riziko');
  if (q.risk === 'ANO') {
    if (q.checkRunning) m.push('kontrola ještě probíhá');
    else if (q.checked === '' || q.wrong === '') m.push('data kontroly');
  }
  if (!ia.length) m.push('alespoň jedno opatření');
  else if (ia.some(a => !a.done)) m.push('všechna opatření hotová');
  if (!q.processStopped) m.push('odpověď „Proces zastaven?“');
  else if (q.processStopped === 'ANO' && !q.restoredAt) m.push('čas obnovení procesu');
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

/** Closure conditions ("Uzavření QRAP schváleno"). */
function checklist_(q, acts, eff) {
  const defs = defActions_(acts);
  return [
    { label: 'QRAP je ve stavu Ověření 5 směn', ok: q.status === 'OVĚŘENÍ' },
    { label: 'kořenová příčina označena (⑤)', ok: rootOk_(q) },
    { label: 'všechny konečné akce hotové', ok: defs.length > 0 && defs.every(a => a.done) },
    { label: 'otázka na aktualizaci standardu zodpovězena', ok: q.std === 'NE' || (q.std === 'ANO' && !!q.stdRef) },
    { label: 'efektivní na 5 různých směnách', ok: eff.allOk },
    { label: '„Co jsme se naučili z QR?“ vyplněno', ok: !!q.learned }
  ];
}

/** Recalculate ③ completeness and the status, save the row and write one line to the history. */
function finish_(q, text, isNew) {
  const acts = actionsOf_(q.id);
  const complete = !s3Missing_(q, iaActions_(acts)).length;
  if (complete && !q.s3Done) q.s3Done = nowIso_();
  if (!complete && !q.decision) q.s3Done = '';
  const before = q.status;
  q.status = statusOf_(q, acts, effectsOf_(q.id));
  q.updated = nowIso_();
  q.updatedBy = who_();
  if (isNew) insert_(TAB.qraps, q); else update_(TAB.qraps, q);
  log_(q.id, text);
  if (!isNew && before !== q.status) log_(q.id, 'Stav: ' + q.status);
}

// =====================================================================================
// 5. PERMISSIONS
//    Anyone in the company: report ①②③, edit ③ until ④, record a 5-shift check, mark own action done.
//    Pilots (chosen in ④):  ⑤ 5 Proč and ⑥ actions.
//    VEDOUCÍ:               ③, sign ④, ⑤ ⑥, ⑦.
//    MANAŽER:               like a leader + close QRAPs, cancel / reopen / unlock, dashboard.
//    ADMIN:                 like a manager + page Správa. The owner of the script is always ADMIN.
//    KIOSK account:         acts as the person whose name is typed at a signature (see signAs_).
// =====================================================================================

function me_() {
  if (ME_) return ME_;
  let email = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { email = ''; }
  const p = cfg_().people.filter(x => x.active && x.email && x.email === email)[0];
  let role = p ? p.role : '';
  if (email && email === ownerEmail_()) role = 'ADMIN';
  ME_ = person_(email, p ? p.name : (email ? email.split('@')[0] : ''), role, p ? p.area : '');
  return ME_;
}

function person_(email, name, role, area) {
  return {
    email: email, name: name, role: role, area: area,
    lead: role === 'VEDOUCÍ' || role === 'MANAŽER' || role === 'ADMIN',
    manager: role === 'MANAŽER' || role === 'ADMIN',
    admin: role === 'ADMIN'
  };
}

/**
 * On the kiosk account the person types their name at a signature. The name must be an active person
 * in Lidé; from then on this request acts with that person's role (a manager at most, never admin).
 * On a personal account the typed name is ignored – the Google account decides.
 */
function signAs_(signer) {
  const real = me_();
  const name = txt_(signer, 100);
  if (real.role !== 'KIOSK' || !name) return real;
  const key = plain_(name);
  const p = cfg_().people.filter(x => x.active && x.email && x.role !== 'KIOSK' &&
    (plain_(x.name) === key || x.email === name.toLowerCase()))[0];
  need_(p, 'Jméno „' + name + '“ není v seznamu Lidé. Vyberte své jméno ze seznamu.');
  REAL_ = real;
  ME_ = person_(p.email, p.name, p.role === 'ADMIN' ? 'MANAŽER' : p.role, p.area);
  ME_.viaKiosk = true;
  return ME_;
}

/** What the kiosk may offer on screen: every step, because the name is checked at saving. */
function screenMe_(me) {
  return me.role === 'KIOSK' ? Object.assign({}, me, { lead: true, manager: true, admin: false }) : me;
}

function ownerEmail_() {
  return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

function isPilot_(me, q) { return !!me.email && list_(q.pilots).indexOf(me.email) >= 0; }
function canPopis_(me, q) { return isOpen_(q) && !q.decision && (me.lead || (!!me.email && q.createdBy === me.email)); }
function canOpatreni_(me, q) { return isOpen_(q) && !q.decision; }
function canShifts_(me, q) { return me.lead && isOpen_(q) && !q.decision; }
function canDecide_(me, q) { return me.lead && q.status === 'ROZHODNUTÍ'; }
function canAnalyze_(me, q) { return isAnalysis_(q) && (me.lead || isPilot_(me, q)); }
function canEffect_(me, q) { return q.status === 'OVĚŘENÍ'; }
function canClose_(me, q) { return me.manager && (q.status === 'OVĚŘENÍ' || q.status === 'SCHVÁLENÍ'); }
function canAssess_(me, q) { return me.lead && q.status !== 'ZRUŠENO'; }

/** A problem as the page gets it, including what the current user may do with it. */
function pubQ_(q, me, acts, effs) {
  const o = {};
  COLS[TAB.qraps].forEach(c => { o[c[0]] = q[c[0]]; });
  const eff = effState_(effs);
  o.s3Missing = s3Missing_(q, iaActions_(acts));
  o.eff = { round: eff.round, ok: eff.okCount, allOk: eff.allOk };
  o.checklist = checklist_(q, acts, eff);
  me = screenMe_(me);
  o.can = {
    popis: canPopis_(me, q), opatreni: canOpatreni_(me, q), shifts: canShifts_(me, q), decide: canDecide_(me, q),
    analyze: canAnalyze_(me, q), pilots: me.lead && isAnalysis_(q), effect: canEffect_(me, q), close: canClose_(me, q),
    assess: canAssess_(me, q), manage: me.manager
  };
  return o;
}

function pubA_(a, me, q) {
  me = screenMe_(me);
  const o = pub_(TAB.actions, a);
  const analyst = canAnalyze_(me, q);
  o.canEdit = a.part === '⑥' && analyst && !a.removed;
  o.canDone = a.part === '⑥' && !a.done && !a.removed && isAnalysis_(q) && (analyst || (!!me.email && a.ownerEmail === me.email));
  return o;
}

function pub_(tab, row) {
  const o = {};
  COLS[tab].forEach(c => { o[c[0]] = row[c[0]]; });
  return o;
}

/** The account the page is shown to (the kiosk stays the kiosk after a signature). */
function viewer_() { return REAL_ || me_(); }

function pack_(id) {
  const me = viewer_();
  const q = find_(id);
  const acts = actionsOf_(id);
  const effs = effectsOf_(id);
  q.status = statusOf_(q, acts, effs);
  return {
    qrap: pubQ_(q, me, acts, effs),
    actions: acts.map(a => pubA_(a, me, q)),
    effects: effs.map(r => pub_(TAB.effects, r)),
    assess: table_(TAB.assess).rows.filter(r => r.qrapId === id).map(r => pub_(TAB.assess, r))
  };
}

/** Open problems + problems closed in the last N days (or everything when all = true). */
function listData_(all) {
  const me = viewer_();
  const since = Date.now() - (Number(setting_('ZOBRAZIT_UZAVRENE_DNI')) || 60) * 864e5;
  const group = tab => {
    const g = {};
    table_(tab).rows.forEach(r => { (g[r.qrapId] = g[r.qrapId] || []).push(r); });
    return g;
  };
  const acts = group(TAB.actions);
  const effs = group(TAB.effects);
  const assess = group(TAB.assess);
  const out = { qraps: [], actions: [], effects: [], assess: [], all: !!all };
  table_(TAB.qraps).rows.forEach(q => {
    const a = (acts[q.id] || []).sort((x, y) => x.no - y.no);
    const e = effs[q.id] || [];
    q.status = statusOf_(q, a, e);
    if (!all && !isOpen_(q) && new Date(q.closedAt || q.updated || q.created).getTime() < since) return;
    out.qraps.push(pubQ_(q, me, a, e));
    a.forEach(x => out.actions.push(pubA_(x, me, q)));
    e.forEach(x => out.effects.push(pub_(TAB.effects, x)));
    (assess[q.id] || []).forEach(x => out.assess.push(pub_(TAB.assess, x)));
  });
  return out;
}

// =====================================================================================
// 6. SHEET HELPERS AND FORM CHECKS
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
  COLS[name].forEach(c => {
    if (o[c[0]] === undefined) o[c[0]] = '';
    row[t.idx[c[0]]] = toCell_(c[0], o[c[0]]);
  });
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

function actionsOf_(id) { return table_(TAB.actions).rows.filter(a => a.qrapId === id).sort((a, b) => a.no - b.no); }
function effectsOf_(id) { return table_(TAB.effects).rows.filter(r => r.qrapId === id); }
function nextNo_(acts) { return acts.reduce((m, x) => Math.max(m, x.no || 0), 0) + 1; }

function log_(id, text) {
  sheet_(TAB.log).appendRow([new Date(), who_() || '(neznámý účet)', "'" + id, "'" + text]);
}

/** Who did it, for the history: the e-mail, plus " (kiosk)" when signed by name on the kiosk. */
function who_() { const me = me_(); return me.email + (me.viaKiosk ? ' (kiosk)' : ''); }

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
    .map((r, i) => ({
      row: i + 2,
      name: String(r[0]).trim(),
      email: String(r[1]).trim().toLowerCase(),
      role: roleOf_(r[2]),
      area: String(r[3]).trim(),
      active: plain_(r[4]) !== 'NE'
    }))
    .filter(p => p.name || p.email);
}

/** "Vedoucí", "leader" … → 'VEDOUCÍ'; "Manažer", "manager" → 'MANAŽER'; "admin", "správce" → 'ADMIN'; "kiosk" → 'KIOSK'. */
function roleOf_(v) {
  const r = plain_(v);
  if (['VEDOUCI', 'LEADER', 'LEAD', 'TL', 'SUPERVIZOR', 'SUPERVISOR', 'MISTR'].indexOf(r) >= 0) return 'VEDOUCÍ';
  if (['MANAZER', 'MANAGER'].indexOf(r) >= 0) return 'MANAŽER';
  if (['ADMIN', 'SPRAVCE'].indexOf(r) >= 0) return 'ADMIN';
  if (r === 'KIOSK') return 'KIOSK';
  return '';
}

// ---- small value helpers
function plain_(v) { return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase(); }
function need_(ok, msg) { if (!ok) throw new Error(msg); }
function txt_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 2000); }
function short_(s) { s = String(s || ''); return s.length > 70 ? s.slice(0, 67) + '…' : s; }
function list_(s) { return String(s || '').split(',').map(x => x.trim()).filter(String); }
function multi_(v) { return (Array.isArray(v) ? v : list_(v)).map(x => txt_(x, 100)).filter(String).join(', '); }
function onlyFrom_(v, allowed) { return list_(multi_(v)).filter(x => allowed.indexOf(x) >= 0).join(', '); }
function isOther_(v) { return plain_(v) === 'JINE'; }
function yn_(v) { v = plain_(v); return v === 'ANO' || v === 'NE' ? v : ''; }
function nowIso_() { return new Date().toISOString(); }
function tz_() { return Session.getScriptTimeZone() || 'Europe/Prague'; }
function fmt_(iso) { return iso ? Utilities.formatDate(new Date(iso), tz_(), 'd.M.yyyy HH:mm') : ''; }

function oneOf_(v, allowed, msg) {
  v = txt_(v, 50);
  need_(allowed.indexOf(v) >= 0, msg);
  return v;
}

function num_(v, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  need_(isFinite(n) && n >= 0 && Math.round(n) === n, (label || 'Počet') + ' musí být celé číslo 0 nebo větší.');
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

/** ① ② from the form, checked like the paper form. */
function popisFrom_(f) {
  const q = {
    safety: yn_(f.safety), what: txt_(f.what), how: txt_(f.how, 100), howOther: txt_(f.howOther, 200),
    when: iso_(f.when), zone: txt_(f.zone, 100), location: txt_(f.location, 100), originZone: txt_(f.originZone, 100),
    qty: num_(f.qty, 'KOLIK'), unit: txt_(f.unit, 50), nokSituation: f.nokSituation === true || f.nokSituation === 'ANO' ? 'ANO' : '',
    repeat7: yn_(f.repeat7), repeatRef: txt_(f.repeatRef, 40).toUpperCase(), finder: txt_(f.finder, 100),
    materialNo: txt_(f.materialNo, 60), huNo: txt_(f.huNo, 60), supplier: txt_(f.supplier, 100),
    photoException: txt_(f.photoException, 500), notified: multi_(f.notified), notifiedOther: txt_(f.notifiedOther, 200),
    notifyPeople: emailsOf_(f.notifyPeople).join(',')
  };
  if (!isOther_(q.how)) q.howOther = '';
  if (q.repeat7 !== 'ANO') q.repeatRef = '';
  if (!list_(q.notified).some(isOther_)) q.notifiedOther = '';
  const miss = [];
  if (!q.safety) miss.push('SAFETY');
  if (!q.what) miss.push('CO je za problém?');
  if (!q.how) miss.push('JAK byl objeven?'); else if (isOther_(q.how) && !q.howOther) miss.push('JAK – jiné');
  if (!q.when) miss.push('KDY?');
  if (!q.zone) miss.push('KDE? – zóna');
  if (!q.location) miss.push('KDE? – lokace');
  if (q.qty === '') miss.push('KOLIK?');
  if (!q.repeat7) miss.push('Stejný problém v posledních 7 dnech?');
  if (!q.finder) miss.push('JMÉNO');
  if (!q.notified) miss.push('② Kdo byl upozorněn?');
  else if (list_(q.notified).some(isOther_) && !q.notifiedOther) miss.push('② Jiné – kdo');
  need_(!miss.length, 'Vyplňte prosím: ' + miss.join(', ') + '.');
  notFuture_(q.when, 'KDY');
  need_(q.qty > 0 || q.nokSituation, 'Zadejte KOLIK větší než 0, nebo zaškrtněte „NOK situace bez kusů“.');
  need_(!(q.qty > 0) || q.unit, 'Vyberte jednotku (KOLIK).');
  need_(q.repeat7 !== 'ANO' || q.repeatRef, 'Vyberte číslo opakovaného QRAP.');
  return q;
}

/** "Stejný problém v posledních 7 dnech? = ANO" → the QRAP must exist and be from the 7 days before KDY. */
function checkRepeat_(q) {
  if (q.repeat7 !== 'ANO') return;
  const r = table_(TAB.qraps).rows.filter(x => x.id === q.repeatRef && x.id !== q.id)[0];
  const det = new Date(q.when).getTime();
  const ref = r ? new Date(r.when).getTime() : 0;
  need_(r && ref <= det + 60000 && ref >= det - 7 * 864e5, 'Opakovaný QRAP ' + q.repeatRef + ' neexistuje nebo není z posledních 7 dnů před KDY.');
}

/** ③ answers from the form (the actions are checked by iaFields_). Only the risk answer is required. */
function opatreniFrom_(f, when) {
  const s = {
    risk: yn_(f.risk), checked: num_(f.checked, 'Zkontrolováno'), wrong: num_(f.wrong, 'Nalezeno špatně'),
    checkRunning: f.checkRunning === true || f.checkRunning === 'ANO' ? 'ANO' : '',
    processStopped: yn_(f.processStopped), restoredAt: iso_(f.restoredAt)
  };
  need_(s.risk, 'Odpovězte: Je riziko u zboží už na skladě nebo už expedovaného?');
  if (s.risk !== 'ANO') Object.assign(s, { checked: '', wrong: '', checkRunning: '' });
  need_(s.wrong === '' || s.checked === '' || s.wrong <= s.checked, '„Nalezeno špatně“ nemůže být víc než „Zkontrolováno“.');
  if (s.processStopped !== 'ANO') s.restoredAt = '';
  notFuture_(s.restoredAt, 'Čas obnovení procesu');
  need_(!s.restoredAt || s.restoredAt >= when, 'Proces nemohl být obnoven před KDY.');
  return s;
}

/** One ③ immediate action: Typ, Co bylo uděláno, Kdo (required), Hotovo v (empty = still running). */
function iaFields_(r, when) {
  const a = { kind: txt_(r.kind, 100), text: txt_(r.text, 500), owner: txt_(r.owner, 100), done: iso_(r.done) };
  need_(a.kind && a.text && a.owner, 'U každého okamžitého opatření vyplňte Typ, Co bylo uděláno a Kdo.');
  notFuture_(a.done, 'Čas „Hotovo v“');
  need_(!a.done || a.done >= when, '„Hotovo v“ nemůže být před KDY.');
  return a;
}

/** Saves the ③ action rows: new ones are added, changed ones updated, removed ones marked (never deleted). */
function syncIa_(id, rows) {
  const existing = actionsOf_(id).filter(a => a.part === '③');
  rows.forEach(r => {
    const cur = r.no ? existing.filter(a => a.no === Number(r.no))[0] : null;
    if (cur) {
      if (r.remove) cur.removed = 'ANO'; else Object.assign(cur, { kind: r.kind, text: r.text, owner: r.owner, done: r.done });
      update_(TAB.actions, cur);
    } else if (!r.remove) {
      insert_(TAB.actions, { qrapId: id, no: nextNo_(actionsOf_(id)), part: '③', kind: r.kind, text: r.text, owner: r.owner,
        done: r.done, created: nowIso_() });
    }
  });
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
  f.ownerEmail = p ? p.email : (/^[^@\s]+@[^@\s]+$/.test(key) ? key : '');
  if (p) f.owner = p.name;
  return f;
}

/** When the risk is ANO, "Kvalita" is added to ② automatically (as on the paper form). */
function addQuality_(q) {
  if (q.risk !== 'ANO') return;
  const k = cfg_().lists.alert.filter(x => /kvalit/i.test(x))[0];
  if (k && list_(q.notified).indexOf(k) < 0) q.notified = list_(q.notified).concat(k).join(', ');
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
// =====================================================================================

function leaders_(zone) {
  const l = cfg_().people.filter(p => p.active && p.role === 'VEDOUCÍ' && (!p.area || p.area === zone)).map(p => p.email);
  return l.length ? l : managers_();
}

function managers_() {
  const m = cfg_().people.filter(p => p.active && p.role === 'MANAŽER').map(p => p.email);
  return m.length ? m : cfg_().people.filter(p => p.active && p.role === 'ADMIN').map(p => p.email);
}

function facts_(q) {
  return ['CO: ' + q.what, 'KDE: ' + [q.zone, q.location].filter(String).join(' / '), 'KDY: ' + fmt_(q.when),
    'KOLIK: ' + (q.qty === '' ? '–' : q.qty + ' ' + q.unit), 'JMÉNO: ' + q.finder];
}

function mailNew_(q) {
  send_(leaders_(q.zone).concat(list_(q.notifyPeople)), q.id + ' – nový problém (' + q.zone + ')', ['Byl nahlášen nový QRAP.', ''].concat(facts_(q), ['',
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
      ['Zkontrolováno: ' + (q.checked === '' ? '–' : q.checked) + ' · Nalezeno špatně: ' + (q.wrong === '' ? '–' : q.wrong)]), q.id);
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
    'Akce: ' + a.text, 'Plán: ' + a.due, 'Problém: ' + q.what, '',
    'Až bude hotovo, otevřete odkaz a klikněte na „✓ Hotovo“.'
  ], q.id);
}

function mailNotEffective_(q) {
  send_(list_(q.pilots).concat(leaders_(q.zone)), q.id + ' – efektivita nepotvrzena', [
    'Chyba se znovu objevila. QRAP se vrátil do analýzy 5 Proč a počítání 5 směn začne znovu.', ''].concat(facts_(q)), q.id);
}

function send_(to, subject, lines, id) {
  if (NO_MAIL_ || plain_(setting_('EMAILY')) !== 'ANO') return;
  const list = to.map(x => String(x || '').trim().toLowerCase())
    .filter((x, i, a) => /^[^@\s]+@[^@\s]+$/.test(x) && a.indexOf(x) === i);
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

/** Every morning (if switched on in the menu): leaders get their open problems, pilots their late actions. */
function dailyReminder(e) {
  const fromTrigger = !!(e && e.triggerUid) && ScriptApp.getProjectTriggers().some(t => t.getUniqueId() === e.triggerUid);
  if (!fromTrigger) ownerOnly_();
  const allActs = table_(TAB.actions).rows;
  const allEffs = table_(TAB.effects).rows;
  const open = table_(TAB.qraps).rows.filter(q => {
    q.status = statusOf_(q, allActs.filter(a => a.qrapId === q.id), allEffs.filter(r => r.qrapId === q.id));
    return isOpen_(q);
  });
  const today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  cfg_().people.filter(p => p.active && p.role && p.role !== 'KIOSK').forEach(p => {
    const mine = open.filter(q => !p.area || p.area === q.zone);
    if (!mine.length) return;
    send_([p.email], 'otevřené problémy: ' + mine.length, ['Dobré ráno, tyto QRAP jsou otevřené:', '']
      .concat(mine.map(q => q.id + '  čeká: ' + NEXT_STEP[q.status] + '  –  ' + short_(q.what))), '');
  });
  const late = allActs.filter(a => a.part === '⑥' && !a.done && !a.removed && a.ownerEmail && a.due && a.due <= today &&
    open.some(q => q.id === a.qrapId));
  late.map(a => a.ownerEmail).filter((x, i, arr) => arr.indexOf(x) === i).forEach(email => {
    const mine = late.filter(a => a.ownerEmail === email);
    send_([email], 'konečné akce po termínu: ' + mine.length, ['Tyto vaše akce mají plán dnes nebo už prošel:', '']
      .concat(mine.map(a => a.qrapId + '  ' + a.due + '  –  ' + short_(a.text))), '');
  });
}

// =====================================================================================
// 8. SETUP, ADMIN MENU, EXAMPLE DATA
// =====================================================================================

/**
 * Admin functions may be run only by the owner of the script (from the menu or the editor).
 * Without this check anybody could start them from the browser, because every public function is callable.
 */
function ownerOnly_() {
  let active = '';
  try { active = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { active = ''; }
  need_(active && active === ownerEmail_(), 'Tuto funkci může spustit jen vlastník aplikace (z menu eQRAP v tabulce).');
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
  ownerOnly_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(tz_());

  [TAB.qraps, TAB.actions, TAB.effects, TAB.assess, TAB.log].forEach(name => {
    const sh = makeTab_(ss, name, COLS[name].map(c => c[1]));
    if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
      sh.protect().setDescription('Data aplikace eQRAP – měňte přes aplikaci').setWarningOnly(true);
    }
  });

  if (!ss.getSheetByName(TAB.people)) {
    const sh = makeTab_(ss, TAB.people, ['Jméno', 'E-mail', 'Role', 'Oblast', 'Aktivní']);
    const rows = [['Správce aplikace', Session.getEffectiveUser().getEmail(), 'ADMIN', '', 'ANO']].concat(EXAMPLE_PEOPLE);
    sh.getRange(2, 1, rows.length, 5).setValues(rows);
    sh.getRange(2, 3, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(ROLES, true).setAllowInvalid(false)
      .setHelpText('Prázdné = běžný uživatel. VEDOUCÍ = ③ ④ ⑤ ⑥ ⑦. MANAŽER = navíc uzavírá QRAP. ADMIN = navíc Správa. KIOSK = sdílený účet kiosku.').build());
    sh.getRange(2, 5, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['ANO', 'NE'], true).build());
  }

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
  ownerOnly_();
  removeReminder();
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(6).create();
  toast_('Denní připomínky jsou zapnuté (každé ráno kolem 6:00).');
}

function removeReminder() {
  ownerOnly_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyReminder').forEach(t => ScriptApp.deleteTrigger(t));
}

/** Three example problems in different stages, to see how the app works. No e-mails are sent. */
function exampleData() {
  ownerOnly_();
  NO_MAIL_ = true;
  const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
  const base = { safety: 'NE', repeat7: 'NE', finder: 'Ukázka', notified: 'Team Leader', photoException: 'Ukázková data bez fotek' };
  apiCreate(Object.assign({}, base, {
    what: 'Promáčknutý obal na paletě, 2 krabice poškozené', how: 'skladování', when: hoursAgo(2), zone: 'Sklad',
    location: 'B-12-03', qty: 2, unit: 'krabice', materialNo: '00-4711', s3: { risk: 'NE' }
  }));
  const b = apiCreate(Object.assign({}, base, {
    what: 'Na 4 boxech chybí etiketa zákazníka', how: 'kontrola expedice', when: hoursAgo(5), zone: 'Expedice',
    location: 'Rampa 3', qty: 4, unit: 'krabice', huNo: 'DL-2026-0815', notified: 'Team Leader, Supervizor',
    s3: { risk: 'ANO', checked: 40, wrong: 4, processStopped: 'NE',
      ia: [{ kind: 'přeetiketování', text: 'Etikety doplněny na všech 4 boxech', owner: 'Ukázka', done: hoursAgo(4) }] }
  })).qrap.id;
  const c = apiCreate(Object.assign({}, base, {
    what: 'Zákazník obdržel o 1 paletu méně, než je na dodacím listu', how: 'reklamace zákazníka', when: hoursAgo(50),
    zone: 'Nakládka', location: 'Rampa 1', qty: 1, unit: 'palety', huNo: 'DL-2026-0790', notified: 'Supervizor, Vedoucí logistiky',
    s3: { risk: 'NE', processStopped: 'NE',
      ia: [{ kind: 'informovat zákazníka / dodavatele', text: 'Chybějící paleta odeslána expresem', owner: 'Ukázka', done: hoursAgo(48) }] }
  })).qrap.id;
  const lead = cfg_().people.filter(p => p.active && p.role && p.email)[0] || { name: me_().name, email: me_().email };
  apiSave(c, 'rozhodnuti', { decision: 'POKRAČOVAT', decisionNote: 'Opakuje se podruhé tento měsíc', pilots: lead.email,
    shifts: cfg_().lists.shifts.join(', ') });
  apiSave(c, 'pricina', { o1: 'Paleta nebyla naložena', o2: 'Nebyla na nakládacím seznamu',
    o3: 'Seznam se tiskl před posledním vychystáním', rootO: 3, n1: 'Počet palet se při nakládce nekontroluje', rootN: 1,
    learned: 'Nakládací seznam až po potvrzení vychystání', std: 'NE' });
  const due = Utilities.formatDate(new Date(Date.now() + 7 * 864e5), tz_(), 'yyyy-MM-dd');
  apiSaveAction(c, { text: 'Tisknout nakládací seznam až po potvrzení vychystání ve WMS', kind: 'O3', owner: lead.name, due: due });
  const r = apiSaveAction(c, { text: 'Kontrola počtu palet při nakládce (podpis řidiče)', kind: 'N1', owner: lead.name, due: due });
  apiSaveAction(c, { no: r.actions.filter(a => a.part === '⑥').pop().no, done: true });
  NO_MAIL_ = false;
  toast_('Ukázková data vložena (' + b + ', ' + c + ' a jeden nový).');
}

function toast_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'eQRAP', 10); } catch (e) { /* not in the Sheet */ }
  Logger.log(msg);
}
