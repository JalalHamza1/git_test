// Server-side tests of eQRAP Lite (Code.gs) against the Apps Script mock.
// The rules checked here are the rules of the QRAP V3.0 form (logistics version).
'use strict';
const assert = require('assert');
const { makeEnv } = require('./lite_gas');
const env = makeEnv({});
const { call, as, state, sheetRows } = env;
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const throws = (fn, re, m) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e && re.test(e.message), m + ' → ' + (e ? e.message : 'no error')); };

const OWNER = 'owner@example.com', LEAD = 'jana.novakova@example.com', LEAD2 = 'petr.svoboda@example.com',
  MGR = 'eva.dvorakova@example.com', USER = 'tomas.cerny@example.com', KIOSK = 'kiosk.expedice@example.com', STRANGER = 'nobody@example.com';
const PNG = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
const iso = h => new Date(Date.now() - h * 3600e3).toISOString();
const pad = x => String(x).padStart(2, '0');
const day = d => { const t = new Date(Date.now() + d * 864e5); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); };
const bootOf = html => JSON.parse(/const BOOT = (.*);<\/script>/.exec(html)[1]);
const defs = r => r.actions.filter(a => a.part === '⑥' && !a.removed);

// ---------------------------------------------------------------- setup; admin functions are owner-only
as(USER);
throws(() => call('setup'), /jen vlastník/, 'setup refused for non-owner');
as(OWNER);
eq(call('setup'), 'Hotovo', 'setup returns');
eq(call('setup'), 'Hotovo', 'setup is repeatable');
['Problémy', 'Akce', 'Ověření', 'Hodnocení', 'Historie', 'Lidé', 'Seznamy', 'Nastavení'].forEach(t => ok(env.ss.sheets[t], 'tab ' + t));
eq(env.ss.sheets['Problémy'].protections.length, 1, 'one protection only (setup twice)');
eq(env.ss.sheets['Seznamy'].data[0].length, 6, 'six lists');
ok(sheetRows('Nastavení').find(r => r['Klíč'] === 'FOTKY_SLOZKA_ID')['Hodnota'].startsWith('FOLDER-'), 'photo folder created');
env.setConfig('EMAIL_KVALITA', 'kvalita@example.com');
env.setConfig('EMAIL_BOZP', 'bozp@example.com');
call('onOpen');
eq(state.menu.length, 5, 'menu items');
as(STRANGER);
['exampleData', 'installReminder', 'removeReminder', 'dailyReminder'].forEach(f => throws(() => call(f), /jen vlastník/, f + ' refused for non-owner'));
throws(() => call('dailyReminder', { triggerUid: 'fake' }), /jen vlastník/, 'fake trigger id refused');

// ---------------------------------------------------------------- ① ② validation (the questions of the paper form)
as(USER);
const base = {
  safety: 'NE', what: 'Na paletě jiný materiál než na etiketě', how: 'vychystávání', when: iso(3), zone: 'Expedice',
  location: 'Rampa 2', qty: 6, unit: 'ks', repeat7: 'NE', finder: 'Tomáš Černý', notified: ['Team Leader'],
  photoWrong: PNG, photoRight: PNG, s3: { risk: 'NE' }
};
const mk = o => Object.assign({}, base, o);
throws(() => call('apiCreate', { s3: { risk: 'NE' } }), /SAFETY, CO je za problém\?, JAK byl objeven\?, KDY\?, KDE\? – zóna, KDE\? – lokace, KOLIK\?, Stejný problém v posledních 7 dnech\?, JMÉNO nebo číslo odznaku, ② Kdo byl upozorněn\?/, 'all required ① ② fields');
throws(() => call('apiCreate', mk({ how: 'jiné' })), /JAK – jiné/, 'JAK jiné needs text');
throws(() => call('apiCreate', mk({ notified: ['jiné'] })), /② Jiné – kdo/, '② jiné needs text');
throws(() => call('apiCreate', mk({ when: new Date(Date.now() + 3600e3).toISOString() })), /budoucnosti/, 'KDY not in the future');
throws(() => call('apiCreate', mk({ qty: 0 })), /NOK situace bez kusů/, 'KOLIK 0 needs NOK situation');
ok(call('apiCreate', mk({ qty: 0, unit: '', nokSituation: true, what: 'Chybí dokumentace k zásilce' })).qrap.nokSituation === 'ANO', 'KOLIK 0 + NOK situation ok');
throws(() => call('apiCreate', mk({ unit: '' })), /jednotku/, 'KOLIK > 0 needs a unit');
throws(() => call('apiCreate', mk({ qty: 1.5 })), /celé číslo/, 'KOLIK must be whole');
throws(() => call('apiCreate', mk({ repeat7: 'ANO' })), /opakovaného QRAP/, 'repeat needs a number');
throws(() => call('apiCreate', mk({ repeat7: 'ANO', repeatRef: 'Q-2020-001' })), /neexistuje/, 'repeat QRAP must exist');
throws(() => call('apiCreate', mk({ photoRight: '' })), /Foto ŠPATNĚ a Foto SPRÁVNĚ/, 'both photos required');
ok(call('apiCreate', mk({ photoWrong: '', photoRight: '', photoException: 'Mobil nefunguje' })).qrap.photoException, 'photo exception with reason');
throws(() => call('apiCreate', mk({ s3: {} })), /riziko/, '③ risk answer required');
throws(() => call('apiCreate', mk({ s3: { risk: 'ANO', checked: 2, wrong: 5 } })), /Nalezeno špatně/, 'wrong ≤ checked');
throws(() => call('apiCreate', mk({ s3: { risk: 'NE', ia: [{ kind: 'přebalení', text: 'x' }] } })), /Typ, Co bylo uděláno a Kdo/, 'immediate action needs all fields');
throws(() => call('apiCreate', mk({ s3: { risk: 'NE', ia: [{ kind: 'přebalení', text: 'x', owner: 'y', done: iso(5) }] } })), /před KDY/, '„Hotovo v“ not before KDY');
throws(() => call('apiCreate', mk({ badge: '', finder: '' })), /JMÉNO nebo číslo odznaku/, 'name or badge');
ok(call('apiCreate', mk({ finder: '', badge: '4711', what: 'Jen odznak' })).qrap.badge === '4711', 'badge alone is enough');

state.sent = [];
let r = call('apiCreate', mk({ materialNo: '0012345', huNo: '=HYPERLINK("http://x")', badge: '007', qty: '6' }));
const id1 = r.qrap.id;
ok(/^Q-\d{4}-\d{3}$/.test(id1), 'id ' + id1);
eq(r.qrap.status, 'OPATŘENÍ', 'only the risk answered → OPATŘENÍ');
eq(r.qrap.s3Missing, ['alespoň jedno opatření', 'odpověď „Proces zastaven?“'], '③ missing list');
eq(r.qrap.materialNo, '0012345', 'leading zeros kept');
eq(r.qrap.badge, '007', 'badge zeros kept');
eq(r.qrap.huNo, '=HYPERLINK("http://x")', 'formula-like text stays text');
eq(r.qrap.qty, 6, 'KOLIK is a number');
ok(r.qrap.photoWrong && r.qrap.photoRight && !r.qrap.photoException, 'two photos stored');
ok(r.qrap.can.popis && r.qrap.can.opatreni && !r.qrap.can.decide && !r.qrap.can.shifts, 'reporter rights');
eq(state.sent.length, 1, 'one mail');
eq(state.sent[0].to, LEAD, 'mail to the leader of the zone');
ok(/\?id=Q-/.test(state.sent[0].body), 'mail has a link');
const idRepeat = call('apiCreate', mk({ repeat7: 'ANO', repeatRef: id1, what: 'Znovu jiný materiál' })).qrap.id;
ok(idRepeat, 'repeat of a QRAP from the last 7 days');

// ---------------------------------------------------------------- SAFETY
state.sent = [];
as(KIOSK);
r = call('apiCreate', mk({ safety: 'ANO', finder: 'Operátor z kiosku', what: 'Padající krabice z regálu' }));
const idSafe = r.qrap.id;
ok(state.sent.some(m => /SAFETY/.test(m.subject) && m.to.includes('bozp@example.com') && m.to.includes(MGR)), 'SAFETY mail to BOZP + managers');

// ---------------------------------------------------------------- ③ by anyone on the shift; risk ANO → Kvalita
as(STRANGER);
throws(() => call('apiSave', id1, 'popis', base), /Popis ① ② může upravit/, 'stranger cannot edit ①');
state.sent = [];
r = call('apiSave', id1, 'opatreni', { risk: 'ANO', checkRunning: true, processStopped: 'ANO',
  ia: [{ kind: 'blokace / karanténa zásob', text: 'Paleta zablokována', owner: 'Náhodný kolega', done: iso(2) },
    { kind: 'přeetiketování', text: 'Etikety vyměněny', owner: 'Náhodný kolega' }] });
eq(r.qrap.notified, 'Team Leader, Kvalita', 'Kvalita added to ② automatically');
ok(state.sent.some(m => m.to === 'kvalita@example.com'), 'Quality mailed');
eq(r.qrap.s3Missing, ['kontrola ještě probíhá', 'všechna opatření hotová', 'čas obnovení procesu'], '③ missing after a partial save');
const ia = r.actions.filter(a => a.part === '③');
eq(ia.length, 2, 'two immediate actions');
throws(() => call('apiSave', id1, 'opatreni', { risk: 'ANO', processStopped: 'ANO', restoredAt: iso(4) }), /před KDY/, 'restore not before KDY');
r = call('apiSave', id1, 'opatreni', { risk: 'ANO', checked: 30, wrong: 2, processStopped: 'ANO', restoredAt: iso(1),
  ia: [{ no: ia[0].no, remove: true }, { no: ia[1].no, kind: 'přeetiketování', text: 'Etikety vyměněny', owner: 'Náhodný kolega', done: iso(1) },
    { kind: 'přebalení', text: 'Krabice přebaleny', owner: 'Náhodný kolega', done: iso(1) }] });
eq(r.qrap.status, 'ROZHODNUTÍ', '③ complete → ROZHODNUTÍ');
ok(r.qrap.s3Done, '③ completion time set');
eq(r.actions.filter(a => a.part === '③' && !a.removed).length, 2, 'two active immediate actions');
eq(r.actions.filter(a => a.removed === 'ANO').length, 1, 'removed action is kept and marked');
r = call('apiSave', id1, 'opatreni', { risk: 'ANO', checked: 30, wrong: 2, checkRunning: true, processStopped: 'ANO', restoredAt: iso(1),
  ia: r.actions.filter(a => a.part === '③' && !a.removed) });
eq(r.qrap.status, 'OPATŘENÍ', '③ can become incomplete again before ④');
r = call('apiSave', id1, 'opatreni', { risk: 'ANO', checked: 30, wrong: 2, processStopped: 'ANO', restoredAt: iso(1),
  ia: r.actions.filter(a => a.part === '③' && !a.removed) });
eq(r.qrap.status, 'ROZHODNUTÍ', 'and complete again');
throws(() => call('apiSave', id1, 'smeny', { shifts: 'Ranní' }), /Směny označuje vedoucí/, 'stranger cannot tick shifts');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'POKRAČOVAT' }), /vedoucí/, 'stranger cannot decide');

// ---------------------------------------------------------------- ④ decision rules
as(LEAD);
r = call('apiSave', id1, 'smeny', { shifts: ['Ranní', 'Neexistující'] });
eq(r.qrap.shifts, 'Ranní', 'only real shifts are saved');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'XYZ' }), /Vyberte rozhodnutí/, 'unknown decision');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'VYŘEŠENO' }), /komentář/, 'SOLVED needs a comment');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'ESKALACE' }), /komentář/, 'ESCALATE needs a comment');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'POKRAČOVAT' }), /pilota/, 'CONTINUE needs a pilot');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'POKRAČOVAT', pilots: 'Nikdo Neznámý' }), /není na listu Lidé/, 'unknown pilot');
state.sent = [];
r = call('apiSave', id1, 'rozhodnuti', { decision: 'POKRAČOVAT', pilots: 'Tomáš Černý', shifts: 'Ranní, Odpolední, Noční' });
eq(r.qrap.status, 'ANALÝZA', 'CONTINUE → ANALÝZA');
eq(r.qrap.pilots, USER, 'pilot e-mail stored');
eq(r.qrap.shifts, 'Ranní, Odpolední, Noční', 'shifts saved with the signature');
eq(r.qrap.decisionBy, 'Jana Nováková', 'signed by');
ok(state.sent.some(m => m.to === USER && /pilot/.test(m.subject)), 'pilot mailed');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'VYŘEŠENO', decisionNote: 'x' }), /už je podepsané/, '④ locked after signing');
throws(() => call('apiSave', id1, 'opatreni', { risk: 'NE' }), /jen do rozhodnutí/, '③ locked after ④ (leaders too)');
throws(() => call('apiSave', id1, 'popis', base), /jen do rozhodnutí/, '① locked after ④');
throws(() => call('apiSetPhoto', id1, 'WRONG', PNG), /jen do rozhodnutí/, 'photos locked after ④');

// ---------------------------------------------------------------- ⑤ by pilots and leaders
as(STRANGER);
throws(() => call('apiSave', id1, 'pricina', { o1: 'x' }), /piloti a vedoucí/, 'stranger cannot analyse');
as(USER); // the pilot
ok(call('apiGet', id1).qrap.can.analyze, 'pilot can analyse');
throws(() => call('apiSave', id1, 'pricina', { o1: 'a', o3: 'c' }), /krok 2 je prázdný/, 'no gaps in the chain');
throws(() => call('apiSave', id1, 'pricina', { o1: 'a', rootO: 2 }), /kořenová příčina musí být vyplněný krok/, 'root must be a filled step');
throws(() => call('apiSave', id1, 'pricina', { o1: 'a', std: 'ANO' }), /který standard/, 'standard ANO needs which one');
const why = { o1: 'Etiketa z jiné zakázky', o2: 'Tiskárna tiskla starou frontu', o3: 'Fronta se nemaže', rootO: 3,
  n1: 'Kontrola etiket se nedělá', rootN: 1, learned: '' };
r = call('apiSave', id1, 'pricina', Object.assign({ std: 'ANO', stdRef: 'Pracovní postup P-12' }, why));
const std = defs(r).filter(a => a.kind === 'STD');
eq(std.length, 1, '„Aktualizovat standard“ action created');
eq(std[0].text, 'Aktualizovat standard: Pracovní postup P-12', 'STD action text');
eq(std[0].ownerEmail, USER, 'STD action owner = first pilot');
r = call('apiSave', id1, 'pricina', Object.assign({ std: 'NE' }, why));
eq(defs(r).filter(a => a.kind === 'STD').length, 0, 'standard NE removes the open STD action');
eq(r.qrap.status, 'ANALÝZA', 'no action yet → ANALÝZA');

// ---------------------------------------------------------------- ⑥ definitive actions
throws(() => call('apiSaveAction', id1, { text: 'x', kind: 'O5', owner: 'Tomáš Černý', due: day(5) }), /vyplněný krok/, 'action must remove a filled step');
throws(() => call('apiSaveAction', id1, { text: 'x', kind: 'O3', owner: 'Tomáš Černý' }), /plán/, 'plan required');
throws(() => call('apiSaveAction', id1, { text: 'x', kind: 'O3', owner: 'Tomáš Černý', due: day(5), evidence: 'javascript:alert(1)' }), /http/, 'evidence must be http(s)');
state.sent = [];
r = call('apiSaveAction', id1, { text: 'Mazat tiskovou frontu při předávce', kind: 'o3', owner: 'jana nováková', due: day(5) });
const a1 = defs(r).pop();
eq(a1.kind, 'O3', 'step normalised');
eq(a1.ownerEmail, LEAD, 'pilot of the action looked up by name');
eq(a1.dueFirst, a1.due, 'first plan remembered');
eq(r.qrap.status, 'AKCE', 'root + action → AKCE');
ok(state.sent.some(m => m.to === LEAD && /konečnou akci/.test(m.subject)), 'action pilot mailed');
r = call('apiSaveAction', id1, { text: 'Kontrola etiket při nakládce', kind: 'N1', owner: 'Tomáš Černý', due: day(3) });
const a2 = defs(r).pop();
r = call('apiSaveAction', id1, { no: a2.no, text: a2.text, kind: 'N1', owner: 'Tomáš Černý', due: day(6) });
eq(r.actions.find(a => a.no === a2.no).due, day(6), 'plan changed');
eq(r.actions.find(a => a.no === a2.no).dueFirst, day(3), 'original plan kept');
r = call('apiSaveAction', id1, { text: 'Omylem', kind: 'O1', owner: 'Tomáš Černý', due: day(3) });
const a3 = defs(r).pop();
r = call('apiSaveAction', id1, { no: a3.no, remove: true });
ok(r.actions.find(a => a.no === a3.no).removed === 'ANO', 'action removed (kept in the Sheet)');
as(LEAD2); // a leader who is not a pilot
ok(call('apiGet', id1).actions.find(a => a.no === a1.no).canEdit, 'other leader may edit');
as(STRANGER);
throws(() => call('apiSaveAction', id1, { no: a1.no, done: true }), /pilot/, 'stranger cannot mark an action');
as(LEAD); // pilot of a1 (and a leader)
r = call('apiSaveAction', id1, { no: a1.no, done: true, evidence: 'https://example.com/foto' });
ok(r.actions.find(a => a.no === a1.no).done, 'a1 done');
eq(r.qrap.status, 'AKCE', 'one still open → AKCE');
as(USER);
throws(() => call('apiSaveAction', id1, { no: a2.no, done: day(2) }), /budoucnosti/, 'done date not in the future');
r = call('apiSaveAction', id1, { no: a2.no, done: day(0) });
eq(r.qrap.status, 'OVĚŘENÍ', 'all actions done → OVĚŘENÍ (5 shifts)');

// ---------------------------------------------------------------- ⑥ 5-shift effectiveness
as(KIOSK); // TL on the kiosk records a slot
throws(() => call('apiSaveEffect', id1, { slot: 1, date: day(0), shift: 'Ranní' }), /výsledek/, 'result required');
throws(() => call('apiSaveEffect', id1, { slot: 1, date: day(1), shift: 'Ranní', result: 'EFEKTIVNÍ', by: 'TL' }), /budoucnosti/, 'shift not in the future');
throws(() => call('apiSaveEffect', id1, { slot: 1, date: day(0), shift: 'Víkend', result: 'EFEKTIVNÍ', by: 'TL' }), /směnu/, 'unknown shift');
r = call('apiSaveEffect', id1, { slot: 1, date: day(0), shift: 'Ranní', result: 'EFEKTIVNÍ', by: 'TL Novák' });
eq(r.qrap.eff.ok, 1, 'one effective shift');
throws(() => call('apiSaveEffect', id1, { slot: 2, date: day(0), shift: 'Ranní', result: 'EFEKTIVNÍ', by: 'TL' }), /jiná směna/, 'the same shift twice is refused');
throws(() => call('apiSaveEffect', id1, { slot: 1, date: day(-1), shift: 'Ranní', result: 'NEOVĚŘENO', by: 'TL' }), /nelze změnit/, 'effective slot is final');
call('apiSaveEffect', id1, { slot: 2, date: day(-1), shift: 'Ranní', result: 'NEOVĚŘENO', by: 'TL' });
r = call('apiSaveEffect', id1, { slot: 2, date: day(-1), shift: 'Ranní', result: 'EFEKTIVNÍ', by: 'TL' });
eq(r.qrap.eff.ok, 2, 'NEOVĚŘENO can be overwritten');
state.sent = [];
r = call('apiSaveEffect', id1, { slot: 3, date: day(-1), shift: 'Noční', result: 'NEEFEKTIVNÍ', by: 'TL' });
eq(r.qrap.status, 'ANALÝZA', 'not effective → back to ANALÝZA');
eq(r.qrap.eff.round, 2, 'round 2');
eq(r.qrap.eff.ok, 0, 'counting starts again');
ok(state.sent.some(m => /efektivita nepotvrzena/.test(m.subject) && m.to.includes(USER)), 'pilots mailed');
throws(() => call('apiSaveEffect', id1, { slot: 1, date: day(0), shift: 'Ranní', result: 'EFEKTIVNÍ', by: 'TL' }), /Ověření 5 směn/, 'no slots outside OVĚŘENÍ');
as(USER);
r = call('apiSaveAction', id1, { text: 'Skener etiket na rampě', kind: 'N1', owner: 'Tomáš Černý', due: day(2) });
eq(r.qrap.status, 'AKCE', 'a NEW action is needed after „neefektivní“');
r = call('apiSaveAction', id1, { no: defs(r).pop().no, done: true });
eq(r.qrap.status, 'OVĚŘENÍ', 'back to OVĚŘENÍ');
[['Ranní', 0], ['Odpolední', 0], ['Noční', -1], ['Ranní', -1], ['Odpolední', -1]].forEach((x, i) => {
  r = call('apiSaveEffect', id1, { slot: i + 1, date: day(x[1]), shift: x[0], result: 'EFEKTIVNÍ', by: 'Tomáš' });
});
eq(r.qrap.eff.ok, 5, '5 effective shifts');
ok(r.qrap.eff.allOk, 'on 5 different shifts');

// ---------------------------------------------------------------- closure checklist and signature
const miss = r.qrap.checklist.filter(c => !c.ok).map(c => c.label);
eq(miss, ['„Co jsme se naučili z QR?“ vyplněno'], 'only „learned“ missing');
throws(() => call('apiSave', id1, 'uzavreni', {}), /vedoucí/, 'pilot cannot sign the closure');
as(LEAD);
throws(() => call('apiSave', id1, 'uzavreni', {}), /Co jsme se naučili/, 'closure blocked by the checklist');
r = call('apiSave', id1, 'pricina', Object.assign({ std: 'NE' }, why, { learned: 'Frontu mazat při každé předávce' }));
eq(r.qrap.status, 'OVĚŘENÍ', 'editing ⑤ keeps OVĚŘENÍ');
r = call('apiSave', id1, 'uzavreni', {});
eq(r.qrap.status, 'UZAVŘENO', 'closure signed → UZAVŘENO');
eq(r.qrap.closedBy, 'Jana Nováková', 'closed by');
ok(!r.qrap.can.analyze && !r.qrap.can.effect && r.qrap.can.assess, 'closed: only ⑦ remains');
throws(() => call('apiSaveAction', id1, { no: a1.no, done: false }), /pilot/, 'no action changes after closure');

// ---------------------------------------------------------------- ⑦ assessments (many per QRAP)
as(USER);
throws(() => call('apiAssess', id1, { c1: 'OK' }), /Hodnotí vedoucí/, 'normal user cannot assess');
as(LEAD);
throws(() => call('apiAssess', id1, { c1: 'OK' }), /všech 5/, 'all 5 criteria required');
throws(() => call('apiAssess', id1, { c1: 'OK', c2: 'OK', c3: 'OK', c4: 'OK', c5: 'OK', feedbackType: 'xyz' }), /zpětné vazby/, 'feedback type');
call('apiAssess', id1, { c1: 'OK', c2: 'OK', c3: 'NOK', c4: 'N/A', c5: 'OK', ojtWith: 'Tomáš Černý', feedback: 'Dobrá práce', feedbackType: 'pochvala' });
as(MGR);
r = call('apiAssess', id1, { c1: 'OK', c2: 'OK', c3: 'OK', c4: 'OK', c5: 'OK' });
eq(r.assess.length, 2, 'two assessments');
eq(r.assess[0].c3, 'NOK', 'values stored');
eq(r.qrap.status, 'UZAVŘENO', '⑦ does not change the status');

// ---------------------------------------------------------------- SOLVED, ESCALATE, unlock, cancel, reopen
as(LEAD);
throws(() => call('apiSave', idSafe, 'rozhodnuti', { decision: 'VYŘEŠENO', decisionNote: 'x' }), /opatření ③ kompletní/, 'decision needs ③ complete');
as(KIOSK);
call('apiSave', idSafe, 'opatreni', { risk: 'NE', processStopped: 'NE', ia: [{ kind: 'jiné', text: 'Regál zajištěn', owner: 'Operátor', done: iso(1) }] });
as(LEAD);
throws(() => call('apiSave', idSafe, 'rozhodnuti', { decision: 'VYŘEŠENO', decisionNote: 'Vyřešeno' }), /SAFETY = ANO/, 'SAFETY cannot be solved without 5 Proč');
state.sent = [];
r = call('apiSave', idSafe, 'rozhodnuti', { decision: 'ESKALACE', decisionNote: 'Regály v celém skladu' });
eq(r.qrap.status, 'ANALÝZA', 'ESCALATE → analysis continues');
ok(state.sent.some(m => /eskalace/.test(m.subject) && m.to.includes(MGR)), 'managers mailed on escalation');
throws(() => call('apiAdmin', idSafe, 'unlock', 'x'), /manažer/, 'leader cannot unlock');
as(MGR);
throws(() => call('apiAdmin', idSafe, 'unlock', ''), /důvod/, 'reason required');
r = call('apiAdmin', idSafe, 'unlock', 'Špatné rozhodnutí');
eq(r.qrap.status, 'ROZHODNUTÍ', 'unlock → back to ROZHODNUTÍ');
ok(r.qrap.can.popis && r.qrap.can.opatreni, '①–③ editable again');
r = call('apiAdmin', idSafe, 'cancel', 'Duplicita');
eq(r.qrap.status, 'ZRUŠENO', 'cancelled');
r = call('apiAdmin', idSafe, 'reopen', 'Omyl');
eq(r.qrap.status, 'ROZHODNUTÍ', 'reopened');

as(USER);
r = call('apiCreate', mk({ what: 'Chybí štítek', s3: { risk: 'NE', processStopped: 'NE', ia: [{ kind: 'přeetiketování', text: 'Doplněn', owner: 'Tomáš', done: iso(1) }] } }));
const idSolved = r.qrap.id;
eq(r.qrap.status, 'ROZHODNUTÍ', 'full ③ at once → ROZHODNUTÍ');
as(LEAD);
r = call('apiSave', idSolved, 'rozhodnuti', { decision: 'VYŘEŠENO', decisionNote: 'Jednorázová chyba, OJT provedeno' });
eq(r.qrap.status, 'UZAVŘENO', 'SOLVED closes');
as(MGR);
r = call('apiAdmin', idSolved, 'reopen', 'Znovu posoudit');
eq(r.qrap.status, 'ROZHODNUTÍ', 'reopen SOLVED → ROZHODNUTÍ');
r = call('apiAdmin', id1, 'reopen', 'Kontrola');
eq(r.qrap.status, 'OVĚŘENÍ', 'reopen CLOSED → OVĚŘENÍ');

// ---------------------------------------------------------------- photos
as(USER);
const idp = call('apiCreate', mk({ what: 'Foto test' })).qrap;
ok(call('apiPhoto', idp.id, idp.photoWrong).startsWith('data:image/png;base64,'), 'photo readable');
throws(() => call('apiPhoto', id1, idp.photoWrong), /nepatří/, 'photo of another problem refused');
throws(() => call('apiSetPhoto', idp.id, 'RIGHT', 'data:text/html;base64,PGgxPg=='), /obrázek/, 'non-image refused');
r = call('apiSetPhoto', idp.id, 'RIGHT', PNG);
ok(r.qrap.photoRight !== idp.photoRight, 'photo replaced');
as(STRANGER);
throws(() => call('apiSetPhoto', idp.id, 'RIGHT', PNG), /Fotku může změnit/, 'stranger cannot change photos');

// ---------------------------------------------------------------- history, list, settings
as(LEAD);
const hist = call('apiHistory', id1);
ok(hist.length >= 20, 'history entries: ' + hist.length);
ok(hist.some(x => x.by === USER && /Efektivita/.test(x.text)), 'history has who and what');
let list = call('apiRefresh', false);
const count = list.qraps.length;
ok(list.effects.length >= 8 && list.assess.length === 2, 'effects and assessments in the list');
const t = env.ss.sheets['Problémy'];
const head = t.data[0];
const row1 = t.data.find(x => x[0] === idSolved);
env.as(MGR);
call('apiAdmin', idSolved, 'cancel', 'Test');
row1[head.indexOf('Změněno')] = new Date(Date.now() - 100 * 864e5);
eq(call('apiRefresh', false).qraps.length, count - 1, 'old closed hidden');
eq(call('apiRefresh', true).qraps.length, count, 'all=true shows old');

env.setConfig('EMAILY', 'NE');
state.sent = [];
as(USER);
call('apiCreate', mk({ what: 'Bez e-mailu' }));
eq(state.sent.length, 0, 'EMAILY=NE → no mail');
env.setConfig('EMAILY', 'ANO');
const people = env.ss.sheets['Lidé'];
people.data.find(x => x[1] === USER)[2] = 'vedouci';
env.run("onEdit({range:{getSheet:()=>({getName:()=>'Lidé'})}})");
let html = env.run('doGet({parameter:{id:"' + id1 + '"}}).getContent()');
let boot = bootOf(html);
eq(boot.me.role, 'VEDOUCÍ', 'role written without accents is accepted');
eq(boot.params.id, id1, 'id parameter passed');
ok(!('FOTKY_SLOZKA_ID' in boot.cfg), 'folder ID not sent to the browser');

// ---------------------------------------------------------------- boot escaping, reminder, example data, header rename
call('apiCreate', mk({ what: '</script><script>alert(1)</script>' }));
html = env.run('doGet({parameter:{}}).getContent()');
ok(!html.includes('</script><script>alert(1)'), 'text cannot break out of the script tag');
ok(bootOf(html).qraps.some(q => q.what === '</script><script>alert(1)</script>'), 'text intact after escaping');

as(OWNER);
call('installReminder');
call('installReminder');
eq(state.triggers.length, 1, 'one reminder trigger');
state.sent = [];
as(STRANGER);
call('dailyReminder', { triggerUid: state.triggers[0].getUniqueId() });
ok(state.sent.length >= 2, 'reminder from the real trigger works: ' + state.sent.length);
as(OWNER);
call('removeReminder');
eq(state.triggers.length, 0, 'trigger removed');
state.sent = [];
call('exampleData');
eq(state.sent.length, 0, 'example data sends no mail');
const statuses = call('apiRefresh', true).qraps.map(q => q.status);
ok(['OPATŘENÍ', 'ROZHODNUTÍ', 'AKCE'].every(s => statuses.includes(s)), 'example stages: ' + statuses.join(','));

head[head.indexOf('① KDE? – zóna')] = 'Zóna (přejmenováno)';
throws(() => call('apiRefresh', false), /chybí sloupec „① KDE\? – zóna“/, 'renamed header message');
html = env.run('doGet({parameter:{}}).getContent()');
ok(/chyb(í|\\u00ed) sloupec/.test(html), 'doGet shows the error instead of crashing');
head[head.indexOf('Zóna (přejmenováno)')] = '① KDE? – zóna';
call('setup');
eq(t.data[0].filter(x => x === '① KDE? – zóna').length, 1, 'setup does not duplicate headers');

console.log('ALL OK –', n, 'checks');
