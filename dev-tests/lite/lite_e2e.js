// Browser test of eQRAP Lite with the QRAP V3.0 questions:
// new QRAP ①②③ → ③ completed → ④ signed → ⑤ 5 Proč → ⑥ action → 5 shifts → closure → ⑦, kiosk, phone.
'use strict';
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { start } = require('./lite_e2e_server');
const path = require('path');
const SHOTS = path.join(__dirname, 'shots');
require('fs').mkdirSync(SHOTS, { recursive: true });
const PNG = require('./png')(1600, 1200, [200, 40, 40]);
const PNG2 = require('./png')(1600, 1200, [40, 160, 60]);
let failures = 0;
const check = (c, m) => { if (!c) { failures++; console.log('FAIL:', m); } else console.log('ok:', m); };
const OWNER = 'owner@example.com', USER = 'tomas.cerny@example.com', LEAD = 'jana.novakova@example.com', MGR = 'eva.dvorakova@example.com', KIOSK = 'kiosk.expedice@example.com';
const pad = x => String(x).padStart(2, '0');
const day = d => { const t = new Date(Date.now() + d * 864e5); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); };

(async () => {
  const { server, env } = await start(8124);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const errors = [];
  const calls = async () => Number(await (await fetch('http://localhost:8124/calls')).text());
  async function open(as, query, viewport, clock) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    if (clock) await page.clock.install();
    page.on('pageerror', e => errors.push(as + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location().url)) errors.push(as + ' console: ' + m.text()); });
    await page.goto('http://localhost:8124/?as=' + encodeURIComponent(as) + (query ? '&' + query : ''));
    return page;
  }
  const badgeIs = (p, re) => p.waitForFunction(r => new RegExp(r).test(document.querySelector('.d-head h1 .badge').textContent), re.source);
  const fld = label => '.fld:has-text("' + label + '")';
  const pick = (p, label, value) => p.click(fld(label) + ' .choice:has(input[value="' + value + '"])');

  // ---------------- board
  let c0 = await calls();
  let p = await open(USER);
  await p.waitForSelector('.row:not(.head)');
  check(await calls() === c0, 'board shows without any extra server call');
  check((await p.$$('.row:not(.head)')).length === 3, 'three example problems');
  await p.screenshot({ path: SHOTS + '/01-board.png' });
  await p.fill('input[type=search]', '00-4711');
  check((await p.$$('.row:not(.head)')).length === 1, 'search by material number');
  await p.fill('input[type=search]', '');

  // ---------------- new QRAP: ① ② ③ with the original questions
  await p.click('text=+ Nahlásit problém');
  await p.waitForSelector('.wiz-steps');
  const nextStep = () => p.click('button:has-text("Pokračovat →")');
  const onStep = async n => (await p.$$eval('.wiz-step', els => els.findIndex(e => e.classList.contains('on')))) === n - 1;
  await nextStep();
  await p.waitForSelector('.toast.bad');
  const msg = await p.textContent('#toast');
  check(/SAFETY, JAK byl objeven, CO je za problém, Stejný problém v posledních 7 dnech/.test(msg), 'step 1 checks only its questions: ' + msg);
  check(await onStep(1), 'stays on step 1');
  await pick(p, 'SAFETY', 'NE');
  await p.selectOption(fld('JAK byl objeven') + ' select', 'jiné');
  check(await p.isVisible(fld('JAK – jiné')), '„jiné“ asks for text');
  await p.selectOption(fld('JAK byl objeven') + ' select', 'vychystávání');
  await p.fill(fld('CO je za problém') + ' textarea', 'Na paletě pro zákazníka je jiný materiál, než je na etiketě');
  await pick(p, 'Stejný problém', 'ANO');
  check(await p.isVisible(fld('Vyberte QRAP z posledních 7 dnů')), 'repeat → choose QRAP');
  await pick(p, 'Stejný problém', 'NE');
  await nextStep();
  check(await onStep(2), 'step 2 Kdy a kde');
  check(await p.inputValue(fld('KDE? – zóna') + ' select') === 'Expedice', 'zóna prefilled from Lidé');
  await p.fill(fld('KDE? – lokace') + ' input', 'Rampa 2');
  await nextStep();
  check(await onStep(3), 'step 3 Množství');
  check(await p.inputValue(fld('JMÉNO') + ' input') === 'Tomáš Černý', 'JMÉNO prefilled');
  await p.fill(fld('KOLIK?') + ' input', '6');
  await nextStep();
  check(/jednotku/.test(await p.textContent('#toast')), 'unit required');
  await p.selectOption(fld('Jednotka') + ' select', 'ks');
  await p.fill(fld('Číslo materiálu') + ' input', '0012345');
  await nextStep();
  await nextStep();
  check(/ŠPATNĚ i SPRÁVNĚ/.test(await p.textContent('#toast')), 'photos required');
  await p.setInputFiles('.pslot.wrong input[type=file]', { name: 'spatne.png', mimeType: 'image/png', buffer: PNG });
  await p.setInputFiles('.pslot.right input[type=file]', { name: 'spravne.png', mimeType: 'image/png', buffer: PNG2 });
  await p.waitForSelector('.pslot.right .ph img');
  await p.screenshot({ path: SHOTS + '/02-new.png' });
  await nextStep();
  check(await onStep(5), 'step 5 ②');
  await p.click('.check:has-text("Team Leader")');
  await nextStep();
  check(await onStep(6) && !(await p.$('.ia-row')), 'operator: ③ is only the risk question');
  await pick(p, 'Je riziko', 'ANO');
  await nextStep();
  check(await onStep(7) && await p.isVisible(fld('CO je za problém')), 'step 7 shows everything for a check');
  await p.screenshot({ path: SHOTS + '/02b-check.png', fullPage: true });
  c0 = await calls();
  await p.click('button:has-text("Odeslat")');
  await p.waitForSelector('.flash');
  check(await calls() - c0 === 1, 'send = one server call, then straight back home');
  check(/odeslán/.test(await p.textContent('.flash')) && await p.isVisible('.hero-btn'), 'home with confirmation and the big button');
  await p.screenshot({ path: SHOTS + '/01b-home-flash.png' });
  const id = (await p.textContent('.flash')).match(/Q-\d{4}-\d{3}/)[0];
  check(env.state.sent.some(m => m.to.includes(LEAD) && m.subject.includes(id)), 'zone leader e-mailed');
  check(env.state.sent.some(m => m.to === 'kvalita@example.com'), 'Quality e-mailed');
  await p.click('.flash button');
  await p.waitForSelector('.d-head');
  check(/Opatření/.test(await p.textContent('.d-head h1 .badge')), '③ waits for the TL: ' + id);
  check(/Kvalita/.test(await p.textContent('#sec2')), 'Kvalita added to ② automatically');
  check(env.sheetRows('Problémy').find(r => r.ID === id)['① Číslo materiálu'] === '0012345', 'material number with zeros in the Sheet');
  await p.waitForSelector('.pslot.right .ph img');
  check(!(await p.$('text=Rozhodnout')), 'normal user has no decide button');

  // ③ finished later (TL)
  await p.click('button:has-text("Doplnit ③")');
  check(await p.isVisible(fld('Zkontrolováno (ks)')), 'risk ANO → check quantities');
  await p.fill(fld('Zkontrolováno (ks)') + ' input', '24');
  await p.fill(fld('Nalezeno špatně (ks)') + ' input', '6');
  await p.selectOption('.ia-row ' + fld('Typ') + ' select', 'blokace / karanténa zásob');
  await p.fill('.ia-row ' + fld('Co bylo uděláno') + ' input', 'Paleta zablokována');
  await p.click('.ia-row ' + fld('Hotovo v') + ' button:has-text("Teď")');
  await pick(p, 'Proces zastaven?', 'NE');
  await p.click('button:has-text("Uložit ③")');
  await badgeIs(p, /Rozhodnutí/);
  check(true, '③ complete → ④ Rozhodnutí');
  await p.goBack();
  await p.waitForSelector('.tiles');
  check(true, 'browser back → board');

  // ---------------- leader: shifts and signature
  const L = await open(LEAD, 'id=' + id);
  await L.waitForSelector('.d-head');
  await L.click('#sec4 .check:has-text("Ranní")');
  await L.click('button:has-text("Uložit směny")');
  await L.waitForFunction(() => /Uloženo/.test(document.getElementById('toast').textContent));
  await L.click('button:has-text("Rozhodnout")');
  await L.click('.choice:has-text("Pokračovat s analýzou")');
  await L.click('.editing .check:has-text("Tomáš Černý")');
  await L.click('.editing .check:has-text("Odpolední")');
  await L.click('.editing .check:has-text("Noční")');
  await L.click('button:has-text("Podepsat")');
  await badgeIs(L, /5 Proč/);
  check(/Podepsal\(a\) Jana Nováková/.test(await L.textContent('#sec4')), '④ signed and locked');
  check(!(await L.$('#sec1 button:has-text("Upravit")')), '① locked after ④');

  // ---------------- pilot: ⑤ and ⑥
  await p.goto('http://localhost:8124/?as=' + encodeURIComponent(USER) + '&id=' + id);
  await p.waitForSelector('button:has-text("Vyplnit 5 Proč")');
  await p.click('button:has-text("Vyplnit 5 Proč")');
  await p.fill(fld('O1 – Proč?') + ' input', 'Etiketa z jiné zakázky');
  await p.fill(fld('O2 – Proč?') + ' input', 'Tiskárna tiskla starou frontu');
  await p.fill(fld('O3 – Proč?') + ' input', 'Fronta se na konci směny nemaže');
  await p.click('.why-row:has(' + fld('O3 – Proč?') + ') .why-root input');
  await p.click('text=+ Přidat řetězec');
  await p.fill(fld('N1 – Proč?') + ' input', 'Etiketa se při nakládce nekontroluje');
  await p.click('.why-row:has(' + fld('N1 – Proč?') + ') .why-root input');
  await p.fill(fld('Co jsme se naučili') + ' textarea', 'Frontu tiskárny mazat při předávce směny');
  await pick(p, 'STANDARDU', 'NE');
  await p.click('button:has-text("Uložit analýzu")');
  await p.waitForSelector('.root-step');
  check((await p.$$('.root-step')).length === 2, 'two root causes marked');
  await p.click('button:has-text("+ Přidat konečnou akci")');
  await p.fill('.act-form ' + fld('Konečná akce') + ' textarea', 'Mazat tiskovou frontu při předávce směny');
  await p.selectOption('.act-form ' + fld('Odstraňuje krok') + ' select', 'O3');
  await p.fill('.act-form ' + fld('Pilot') + ' input', 'Tomáš Černý');
  await p.fill('.act-form input[type=date]', day(3));
  await p.click('button:has-text("Přidat akci")');
  await badgeIs(p, /Akce/);
  check(true, 'root + action → ⑥ Akce');
  await p.click('#sec6 button:has-text("✓ Hotovo")');
  await badgeIs(p, /Ověření/);
  check(true, 'action done → Ověření 5 směn');

  // ---------------- 5 shifts (TL / anyone)
  const slots = [['Ranní', 0], ['Odpolední', 0], ['Noční', -1], ['Ranní', -1], ['Odpolední', -1]];
  for (let i = 0; i < 5; i++) {
    const row = p.locator('table.slots tr').nth(i + 1);
    await row.locator('input[type=date]').fill(day(slots[i][1]));
    await row.locator('select').nth(0).selectOption(slots[i][0]);
    await row.locator('select').nth(1).selectOption('EFEKTIVNÍ');
    await row.locator('button').click();
    await p.waitForFunction(n => document.querySelectorAll('table.slots .badge.ok').length === n, i + 1);
  }
  check(/efektivní na 5 z 5/.test(await p.textContent('#sec6')), '5 effective shifts');
  check(!(await p.$('button:has-text("Podepsat uzavření")')), 'pilot cannot sign the closure');

  // ---------------- only a manager closes; leader does ⑦
  await L.reload();
  await L.waitForSelector('.checklist');
  check(!(await L.$('button:has-text("Podepsat uzavření")')), 'leader cannot close');
  const M = await open(MGR, 'id=' + id);
  await M.waitForSelector('button:has-text("Podepsat uzavření")');
  check((await M.$$('.checklist .ok')).length === 6, 'closure checklist all ✓');
  await M.click('button:has-text("Podepsat uzavření")');
  await badgeIs(M, /Uzavřeno/);
  check(true, 'manager closes → Uzavřeno');
  await L.reload();
  await L.waitForSelector('button:has-text("+ Hodnotit")');
  await L.click('button:has-text("+ Hodnotit")');
  for (const g of await L.$$('.editing .choices.inline')) await (await g.$('.choice:has(input[value="OK"])')).click();
  await L.fill(fld('OJT s kým') + ' input', 'Tomáš Černý');
  await L.selectOption(fld('Typ zpětné vazby') + ' select', 'pochvala');
  await L.fill(fld('Zpětná vazba') + ' textarea', 'Rychlá reakce');
  await L.click('button:has-text("Uložit hodnocení")');
  await L.waitForSelector('.assess-item');
  check(/Celkem hodnocení: 1/.test(await L.textContent('#sec7')), '⑦ assessment saved');
  await L.click('.card:has-text("HISTORIE") button:has-text("Zobrazit")');
  await L.waitForSelector('.timeline li');
  check((await L.$$('.timeline li')).length >= 12, 'history entries');
  await L.screenshot({ path: SHOTS + '/03-closed.png', fullPage: true });
  await L.emulateMedia({ media: 'print' });
  await L.screenshot({ path: SHOTS + '/04-print.png', fullPage: true });
  await L.emulateMedia({ media: 'screen' });

  // ---------------- manager: reopen and cancel
  await M.reload();
  await M.waitForSelector('text=SPRÁVA QRAP (MANAŽER)');
  await M.fill('.card:has-text("SPRÁVA QRAP") input', 'Kontrola');
  await M.click('button:has-text("Znovu otevřít")');
  await badgeIs(M, /Ověření/);
  await M.fill('.card:has-text("SPRÁVA QRAP") input', 'Duplicita');
  await M.click('button:has-text("Zrušit QRAP")');
  await badgeIs(M, /Zrušeno/);
  check(true, 'manager reopen + cancel');
  // dashboard
  await M.click('nav >> text=Přehled');
  await M.waitForSelector('svg.viz');
  check((await M.$$('.hbar')).length > 0 && (await M.$$('.tiles-6 .tile')).length === 6, 'dashboard tiles and bars');
  await M.hover('.viz-group >> nth=7');
  check(await M.isVisible('.viz-tip') && /Nové/.test(await M.textContent('.viz-tip')), 'chart tooltip on hover');
  await M.screenshot({ path: SHOTS + '/10-dashboard.png', fullPage: true });
  await M.click('text=Zobrazit tabulku');
  check(await M.isVisible('.card table.roles'), 'chart has a table view');
  check(!(await M.$('nav >> text=Správa')), 'manager has no Správa');
  await M.click('text=Jak to funguje');
  await M.waitForSelector('table.roles');
  await M.screenshot({ path: SHOTS + '/05-help.png', fullPage: true });

  // ---------------- Správa (admin)
  const O = await open(OWNER);
  await O.click('nav >> text=Správa');
  await O.waitForSelector('text=LIDÉ A ROLE');
  await O.click('button:has-text("+ Přidat osobu")');
  await O.fill('.act-form ' + fld('Jméno') + ' input', 'Karel Nový');
  await O.fill('.act-form ' + fld('E-mail') + ' input', 'karel.novy@example.com');
  await O.selectOption('.act-form ' + fld('Role') + ' select', 'MANAŽER');
  await O.click('button:has-text("Přidat osobu") >> nth=-1');
  await O.waitForSelector('td:has-text("karel.novy@example.com")');
  check(env.sheetRows('Lidé').some(r => r['E-mail'] === 'karel.novy@example.com' && r['Role'] === 'MANAŽER'), 'admin added a manager from the web');
  await O.screenshot({ path: SHOTS + '/11-admin.png', fullPage: true });

  // ---------------- kiosk: operator minimum, then leader and manager sign by name on the same kiosk
  const K = await open(KIOSK, '', null, true);
  await K.waitForSelector('.row:not(.head)');
  check(await K.textContent('.who') === 'Kiosk', 'kiosk account → kiosk mode');
  await K.click('.hero-btn');
  const kn = () => K.click('button:has-text("Pokračovat →")');
  await pick(K, 'SAFETY', 'NE');
  await K.selectOption(fld('JAK byl objeven') + ' select', 'inventura');
  await K.fill(fld('CO je za problém') + ' textarea', 'V krabici 48 ks místo 50');
  await pick(K, 'Stejný problém', 'NE');
  await kn();
  await K.selectOption(fld('KDE? – zóna') + ' select', 'Sklad');
  await K.fill(fld('KDE? – lokace') + ' input', 'C-04-01');
  await kn();
  check(await K.inputValue(fld('JMÉNO') + ' input') === '', 'kiosk: JMÉNO empty');
  await K.fill(fld('KOLIK?') + ' input', '2');
  await K.selectOption(fld('Jednotka') + ' select', 'ks');
  await K.fill(fld('JMÉNO') + ' input', 'Operátor Novák');
  await kn();
  await K.click('text=Fotku nelze pořídit');
  await K.fill(fld('Důvod výjimky') + ' textarea', 'Kiosk bez fotoaparátu');
  await kn();
  await K.click('.check:has-text("Supervizor")');
  await kn();
  await pick(K, 'Je riziko', 'NE');
  await kn();
  await K.click('button:has-text("Odeslat")');
  await K.waitForSelector('.flash');
  check(!(await K.$('.flash button')), 'kiosk: back home, no detail link');
  const kr = env.sheetRows('Problémy').find(r => r['① JMÉNO'] === 'Operátor Novák');
  check(kr && kr['Stav'] === 'OPATŘENÍ' && kr['Účet'] === KIOSK && /bez fotoaparátu/.test(kr['① Výjimka – proč nejsou fotky']), 'kiosk QRAP stored');
  await K.click('.row:has-text("V krabici 48 ks")');
  await K.click('button:has-text("Doplnit ③")');
  await K.selectOption('.ia-row ' + fld('Typ') + ' select', 'přebalení');
  await K.fill('.ia-row ' + fld('Kdo') + ' input', 'TL Dvořák');
  await K.fill('.ia-row ' + fld('Co bylo uděláno') + ' input', 'Krabice doplněna');
  await K.click('.ia-row ' + fld('Hotovo v') + ' button:has-text("Teď")');
  await pick(K, 'Proces zastaven?', 'NE');
  await K.click('button:has-text("Uložit ③")');
  await badgeIs(K, /Rozhodnutí/);
  await K.click('button:has-text("Rozhodnout")');
  await K.click('.choice:has-text("Problém vyřešen")');
  await K.fill(fld('Komentář') + ' textarea', 'Jednorázová chyba, OJT provedeno');
  await K.click('button:has-text("Podepsat")');
  check(/Kdo podepisuje/.test(await K.textContent('#toast')), 'kiosk asks for the name');
  await K.fill(fld('Kdo podepisuje') + ' input', 'Jana Nováková');
  await K.click('button:has-text("Podepsat")');
  await badgeIs(K, /Ke schválení/);
  check(/Podepsal\(a\) Jana Nováková/.test(await K.textContent('#sec4')), 'signed with the typed name');
  await K.fill(fld('Kdo uzavírá') + ' input', 'Jana Nováková');
  await K.click('button:has-text("Schválit a uzavřít")');
  await K.waitForSelector('.toast.bad');
  check(/manažer/.test(await K.textContent('#toast')), 'a leader name cannot close');
  await K.fill(fld('Kdo uzavírá') + ' input', 'Eva Dvořáková');
  await K.click('button:has-text("Schválit a uzavřít")');
  await badgeIs(K, /Uzavřeno/);
  check(env.sheetRows('Historie').some(r => r['Kdo'] === MGR + ' (kiosk)'), 'history: manager name on the kiosk');
  await K.screenshot({ path: SHOTS + '/06-kiosk-closed.png', fullPage: true });
  await K.click('header button:has-text("+ Nahlásit problém")');
  await K.clock.fastForward(130000);
  await K.waitForSelector('.tiles', { timeout: 5000 });
  check(true, 'kiosk returns to the board by itself');

  // ---------------- phone
  const P = await open(LEAD, '', { width: 390, height: 844 });
  await P.waitForSelector('.row:not(.head)');
  await P.screenshot({ path: SHOTS + '/07-phone-board.png', fullPage: true });
  check(!(await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll on phone');
  await P.click('.row:not(.head) >> nth=0');
  await P.waitForSelector('.d-head');
  await P.screenshot({ path: SHOTS + '/08-phone-detail.png', fullPage: true });
  check(!(await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll on phone detail');
  await P.click('text=+ Nahlásit problém');
  await P.screenshot({ path: SHOTS + '/09-phone-new.png', fullPage: true });
  check(!(await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll on phone form');

  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log(failures ? failures + ' FAILED' : 'ALL OK');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
