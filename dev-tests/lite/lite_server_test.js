// Server-side tests of eQRAP Lite (Code.gs) against the Apps Script mock.
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

// ---- setup
as(OWNER);
eq(call('setup'), 'Hotovo', 'setup returns');
eq(call('setup'), 'Hotovo', 'setup is repeatable');
['Problémy', 'Akce', 'Historie', 'Lidé', 'Seznamy', 'Nastavení'].forEach(t => ok(env.ss.sheets[t], 'tab ' + t));
eq(env.ss.sheets['Problémy'].protections.length, 1, 'one protection only (setup twice)');
eq(env.ss.sheets['Lidé'].data.length, 7, 'owner + 5 example people + header');
ok(sheetRows('Nastavení').find(r => r['Klíč'] === 'FOTKY_SLOZKA_ID')['Hodnota'].startsWith('FOLDER-'), 'photo folder created');
call('onOpen'); ok(state.menu.length === 5, 'menu items');

// ---- doGet boot
as(USER);
let html = env.run('doGet({parameter:{}}).getContent()');
let boot = JSON.parse(/const BOOT = (.*);<\/script>/.exec(html)[1]);
eq(boot.me.role, '', 'normal user');
eq(boot.qraps.length, 0, 'no problems yet');
ok(boot.lists.areas.includes('Expedice'), 'lists sent');
eq(boot.people.length, 6, 'people for owner picker');

// ---- create
const iso = h => new Date(Date.now() - h * 3600e3).toISOString();
const base = { reporter: 'Tomáš Černý', area: 'Expedice', type: 'Záměna dílu', what: 'Na paletě jiný díl než na etiketě', when: iso(3), notified: ['Vedoucí směny', 'Kvalita'] };
throws(() => call('apiCreate', { reporter: 'X' }), /Vyplňte prosím: Oblast, Typ problému, Co se stalo, Kdy zjištěno, ② Kdo byl upozorněn/, 'required fields');
throws(() => call('apiCreate', Object.assign({}, base, { when: new Date(Date.now() + 3600e3).toISOString() })), /budoucnosti/, 'future time');
throws(() => call('apiCreate', Object.assign({}, base, { qty: -2 })), /kladné/, 'negative qty');
state.sent = [];
let r = call('apiCreate', Object.assign({}, base, { partNo: '00123', delivery: '=HYPERLINK("http://x")', qty: '3', where: '+rampa' }));
const id1 = r.qrap.id;
ok(/^Q-\d{4}-001$/.test(id1), 'id format ' + id1);
eq(r.qrap.status, 'OPATŘENÍ', 'new → OPATŘENÍ');
eq(r.qrap.partNo, '00123', 'leading zeros kept');
eq(r.qrap.delivery, '=HYPERLINK("http://x")', 'formula-like text kept as text');
eq(r.qrap.qty, 3, 'qty number');
eq(r.qrap.notified, 'Vedoucí směny, Kvalita', 'notified joined');
eq(r.qrap.createdBy, USER, 'account stored');
ok(r.qrap.can.popis && r.qrap.can.opatreni && !r.qrap.can.decide, 'reporter can edit ①② and ③ but not decide');
eq(state.sent.length, 1, 'one mail'); ok(state.sent[0].to === LEAD, 'mail to Expedice leader only: ' + state.sent[0].to);
ok(/\?id=Q-/.test(state.sent[0].body), 'mail has link');

// ---- permissions for ③ and ④
as(STRANGER);
r = call('apiGet', id1);
ok(!r.qrap.can.popis && r.qrap.can.opatreni, 'stranger: no ①, yes ③');
throws(() => call('apiSave', id1, 'popis', base), /Popis může upravit/, 'stranger cannot edit ①');
throws(() => call('apiSave', id1, 'opatreni', { s3Action: 'x' }), /Zákazník informován, Kdo opatření provedl/, '③ required');
throws(() => call('apiSave', id1, 'opatreni', { s3Action: 'x', s3Customer: 'NE', s3By: 'Y', s3Checked: 2, s3Nok: 5 }), /NOK/, 'NOK > checked');
r = call('apiSave', id1, 'opatreni', { s3Action: 'Paleta zastavena', s3Customer: 'NENÍ POTŘEBA', s3By: 'Náhodný kolega', s3Places: ['Sklad'], s3Checked: 10, s3Nok: 1 });
eq(r.qrap.status, 'ROZHODNUTÍ', '③ → ROZHODNUTÍ');
const s3done = r.qrap.s3Done;
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'ANALÝZA' }), /Rozhoduje vedoucí/, 'stranger cannot decide');
as(LEAD);
r = call('apiSave', id1, 'opatreni', { s3Action: 'Paleta zastavena a přeložena', s3Customer: 'NENÍ POTŘEBA', s3By: 'Jana' });
eq(r.qrap.s3Done, s3done, 'editing ③ keeps original done time');
throws(() => call('apiSave', id1, 'rozhodnuti', { decision: 'XYZ' }), /Vyberte rozhodnutí/, 'bad decision');
state.sent = [];
r = call('apiSave', id1, 'rozhodnuti', { decision: 'ESKALACE', decisionNote: 'Opakuje se' });
eq(r.qrap.status, 'ANALÝZA', 'escalation → ANALÝZA');
eq(state.sent.length, 1, 'escalation mail'); ok(state.sent[0].to.includes(MGR) && state.sent[0].to.includes(OWNER), 'to managers: ' + state.sent[0].to);
as(USER);
throws(() => call('apiSave', id1, 'opatreni', { s3Action: 'x', s3Customer: 'NE', s3By: 'y' }), /Po rozhodnutí/, '③ locked for users after decision');
throws(() => call('apiSave', id1, 'popis', base), /Popis může upravit/, '① locked for reporter after decision');

// ---- ⑤ ⑥
as(LEAD);
throws(() => call('apiSave', id1, 'pricina', { why1: 'a' }), /Proč 1/, 'root cause required');
r = call('apiSave', id1, 'pricina', { why1: 'Špatná etiketa', why2: 'Tiskárna', rootCause: 'Etiketa tištěna před změnou dílu', causeType: 'Postup / metoda' });
eq(r.qrap.status, 'ANALÝZA', 'still ANALÝZA without actions');
throws(() => call('apiSaveAction', id1, { text: 'x', owner: 'Tomáš Černý' }), /termín/, 'action due required');
throws(() => call('apiSaveAction', id1, { text: 'x', owner: 'Tomáš Černý', due: '5.10.2026' }), /termín/, 'action date format');
state.sent = [];
const due = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
r = call('apiSaveAction', id1, { text: 'Tisk etiket až po potvrzení', owner: 'tomáš černý', due: due });
eq(r.actions[0].ownerEmail, USER, 'owner e-mail looked up by name (case-insensitive)');
eq(r.actions[0].owner, 'Tomáš Černý', 'owner name normalised');
eq(r.actions[0].due, due, 'due date round-trips');
eq(state.sent.length, 1, 'action mail'); eq(state.sent[0].to, USER, 'action mail to owner');
r = call('apiSaveAction', id1, { text: 'Kontrola', owner: 'externi@example.org', due: due });
eq(r.actions[1].ownerEmail, 'externi@example.org', 'free e-mail owner');
as(LEAD2);
r = call('apiGet', id1);
ok(r.actions.every(a => a.canEdit) && r.actions[0].canDone, 'other leader can edit and mark');
as(STRANGER);
throws(() => call('apiSaveAction', id1, { no: 1, done: true }), /odpovědná osoba/, 'stranger cannot mark action');
throws(() => call('apiSaveAction', id1, { text: 'z', owner: 'a', due: due }), /Akce zadává vedoucí/, 'stranger cannot add');
as(USER);
r = call('apiGet', id1);
ok(r.actions[0].canDone && !r.actions[0].canEdit && !r.actions[1].canDone, 'owner flags');
r = call('apiSaveAction', id1, { no: 1, done: true, text: 'HACK' });
ok(r.actions[0].done && r.actions[0].text === 'Tisk etiket až po potvrzení', 'owner marks done, cannot change text');
eq(r.qrap.status, 'ANALÝZA', 'one action still open');
as(LEAD);
throws(() => call('apiSave', id1, 'overeni', { effective: 'ANO' }), /Ověřit lze/, 'cannot verify with open action');
r = call('apiSaveAction', id1, { no: 2, done: true });
eq(r.qrap.status, 'OVĚŘENÍ', 'all done → OVĚŘENÍ');
throws(() => call('apiSave', id1, 'overeni', { effective: 'NE' }), /co se znovu objevilo/, 'NE needs note');
r = call('apiSave', id1, 'overeni', { effective: 'NE', effectiveNote: 'Znovu 2. 10.' });
eq(r.qrap.status, 'ANALÝZA', 'not effective → back to ANALÝZA');
r = call('apiSaveAction', id1, { text: 'Poka-yoke skener', owner: 'Jana Nováková', due: due });
eq(r.qrap.effective, '', 'new action clears failed check');
r = call('apiSaveAction', id1, { no: 3, text: 'Poka-yoke skener na rampě', owner: 'Jana Nováková', due: due, done: true });
eq(r.qrap.status, 'OVĚŘENÍ', 'again OVĚŘENÍ');
r = call('apiSave', id1, 'overeni', { effective: 'ANO', effectiveNote: '5 směn bez výskytu' });
eq(r.qrap.status, 'UZAVŘENO', 'effective → UZAVŘENO'); ok(r.qrap.closedAt, 'closedAt set');
ok(!r.qrap.can.decide && !r.qrap.can.analyze && r.qrap.can.assess, 'closed: only ⑦ possible');
throws(() => call('apiSaveAction', id1, { no: 1, done: false }), /uzavřený/, 'no action changes after close');

// ---- ⑦
throws(() => call('apiSave', id1, 'hodnoceni', { a1: 'OK' }), /všech 5/, 'all 5 criteria');
r = call('apiSave', id1, 'hodnoceni', { a1: 'OK', a2: 'OK', a3: 'NOK', a4: 'N/A', a5: 'OK', aNote: 'Dobře' });
eq(r.qrap.a3, 'NOK', '⑦ saved'); eq(r.qrap.status, 'UZAVŘENO', '⑦ does not change status');

// ---- VYŘEŠENO path, cancel, reopen
as(KIOSK);
r = call('apiCreate', Object.assign({}, base, { reporter: 'Operátor z kiosku', area: 'Sklad', safety: 'ANO',
  s3: { s3Action: 'Zablokováno', s3Customer: 'NE', s3By: 'Operátor' } }));
const id2 = r.qrap.id;
ok(/-002$/.test(id2), 'sequential id'); eq(r.qrap.status, 'ROZHODNUTÍ', 'with ③ → ROZHODNUTÍ'); eq(r.qrap.safety, 'ANO', 'safety');
as(LEAD);
r = call('apiSave', id2, 'rozhodnuti', { decision: 'VYŘEŠENO' });
eq(r.qrap.status, 'UZAVŘENO', 'VYŘEŠENO closes');
throws(() => call('apiAdmin', id2, 'reopen'), /manažer/, 'leader cannot reopen');
as(MGR);
r = call('apiAdmin', id2, 'reopen', 'omyl');
eq(r.qrap.status, 'ROZHODNUTÍ', 'reopen → back to decision'); eq(r.qrap.closedAt, '', 'closedAt cleared');
throws(() => call('apiAdmin', id2, 'cancel', ''), /důvod/, 'cancel needs reason');
r = call('apiAdmin', id2, 'cancel', 'Duplicita');
eq(r.qrap.status, 'ZRUŠENO', 'cancelled');
r = call('apiAdmin', id2, 'reopen');
eq(r.qrap.status, 'ROZHODNUTÍ', 'reopen cancelled');

// ---- photos
const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
as(USER);
r = call('apiCreate', Object.assign({}, base, { photos: [png, png] }));
const id3 = r.qrap.id;
const ids = r.qrap.photos.split(',');
eq(ids.length, 2, 'two photos stored');
ok(call('apiPhoto', id3, ids[0]).startsWith('data:image/png;base64,'), 'photo readable');
throws(() => call('apiPhoto', id1, ids[0]), /nepatří/, 'photo of another problem refused');
throws(() => call('apiAddPhoto', id3, 'data:text/html;base64,PGgxPg=='), /obrázek/, 'non-image refused');
r = call('apiAddPhoto', id3, png); eq(r.qrap.photos.split(',').length, 3, 'photo added');
as(STRANGER);
throws(() => call('apiAddPhoto', id3, png), /Fotku může přidat/, 'stranger cannot add photo');

// ---- history, lists
as(LEAD);
const hist = call('apiHistory', id1);
ok(hist.length >= 12 && /Uzavřeno|Hodnocení/.test(hist[0].text), 'history newest first (' + hist.length + ')');
ok(hist.some(x => x.by === USER && /hotová/.test(x.text)), 'history has who');
let list = call('apiRefresh', false);
eq(list.qraps.length, 3, 'refresh lists all recent');
// make id1 look closed long ago → hidden unless all
const t = env.ss.sheets['Problémy'];
const head = t.data[0];
const row1 = t.data.find(x => x[0] === id1);
row1[head.indexOf('Uzavřeno')] = new Date(Date.now() - 100 * 864e5);
list = call('apiRefresh', false);
eq(list.qraps.length, 2, 'old closed hidden'); ok(!list.actions.some(a => a.qrapId === id1), 'their actions hidden too');
eq(call('apiRefresh', true).qraps.length, 3, 'all=true shows old');

// ---- settings changes via Sheet (cache clear via onEdit)
env.setConfig('EMAILY', 'NE');
state.sent = [];
as(USER);
call('apiCreate', base);
eq(state.sent.length, 0, 'EMAILY=NE → no mail');
const people = env.ss.sheets['Lidé'];
people.data.find(x => x[1] === USER)[2] = 'vedouci';
env.run("onEdit({range:{getSheet:()=>({getName:()=>'Lidé'})}})");
eq(call('apiRefresh', false).qraps[0].can.decide !== undefined, true, 'refresh ok');
html = env.run('doGet({parameter:{id:"' + id1 + '"}}).getContent()');
boot = JSON.parse(/const BOOT = (.*);<\/script>/.exec(html)[1]);
eq(boot.me.role, 'VEDOUCÍ', 'role spelled without accents is accepted');
eq(boot.params.id, id1, 'id param passed');

// ---- boot escaping
as(USER);
call('apiCreate', Object.assign({}, base, { what: '</script><script>alert(1)</script>' }));
html = env.run('doGet({parameter:{}}).getContent()');
ok(!html.includes('</script><script>alert(1)'), 'boot JSON cannot break out of the script tag');
boot = JSON.parse(/const BOOT = (.*);<\/script>/.exec(html)[1]);
ok(boot.qraps.some(q => q.what === '</script><script>alert(1)</script>'), 'text intact after escaping');

// ---- reminder + example data + missing setup
as(OWNER);
env.setConfig('EMAILY', 'ANO');
state.sent = [];
call('dailyReminder');
ok(state.sent.length >= 2, 'reminder mails: ' + state.sent.length);
call('installReminder'); call('installReminder');
eq(state.triggers.length, 1, 'one reminder trigger');
call('removeReminder'); eq(state.triggers.length, 0, 'trigger removed');
state.sent = [];
call('exampleData');
eq(state.sent.length, 0, 'example data sends no mail');
const all = call('apiRefresh', true);
const statuses = all.qraps.map(q => q.status);
ok(statuses.includes('OPATŘENÍ') && statuses.includes('ROZHODNUTÍ') && statuses.includes('ANALÝZA'), 'example states ' + statuses);

// Header renamed → clear error
head[head.indexOf('① Oblast')] = 'Oblast (přejmenováno)';
throws(() => call('apiRefresh', false), /chybí sloupec „① Oblast“/, 'renamed header message');
html = env.run('doGet({parameter:{}}).getContent()');
ok(html.includes('chyb\\u00ed sloupec') || html.includes('chybí sloupec'), 'doGet shows error instead of crashing');
head[head.indexOf('Oblast (přejmenováno)')] = '① Oblast';
call('setup');
eq(env.ss.sheets['Problémy'].data[0].filter(x => x === '① Oblast').length, 1, 'setup does not duplicate headers');

console.log('ALL OK –', n, 'checks');
