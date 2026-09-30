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
const USER = 'tomas.cerny@example.com', LEAD = 'jana.novakova@example.com', MGR = 'eva.dvorakova@example.com', KIOSK = 'kiosk.expedice@example.com';
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
  await p.waitForSelector('text=Odeslat');
  check(await p.inputValue(fld('JMÉNO') + ' input') === 'Tomáš Černý', 'JMÉNO prefilled');
  check(await p.inputValue(fld('KDE? – zóna') + ' select') === 'Expedice', 'zóna prefilled from Lidé');
  await p.click('button:has-text("Odeslat")');
  await p.waitForSelector('.toast.bad');
  const msg = await p.textContent('#toast');
  check(/SAFETY, JAK byl objeven, CO je za problém, Stejný problém v posledních 7 dnech, KDE\? – lokace, KOLIK, Upozorněné role/.test(msg), 'validation lists the form questions: ' + msg);
  await pick(p, 'SAFETY', 'NE');
  await p.selectOption(fld('JAK byl objeven') + ' select', 'jiné');
  check(await p.isVisible(fld('JAK – jiné')), '„jiné“ asks for text');
  await p.selectOption(fld('JAK byl objeven') + ' select', 'vychystávání');
  check(!(await p.isVisible(fld('JAK – jiné'))), 'text hidden again');
  await p.fill(fld('CO je za problém') + ' textarea', 'Na paletě pro zákazníka je jiný materiál, než je na etiketě');
  await pick(p, 'Stejný problém', 'ANO');
  check(await p.isVisible(fld('Vyberte QRAP z posledních 7 dnů')), 'repeat → choose QRAP');
  await pick(p, 'Stejný problém', 'NE');
  await p.fill(fld('KDE? – lokace') + ' input', 'Rampa 2');
  await p.fill(fld('KOLIK?') + ' input', '6');
  await p.selectOption(fld('Jednotka') + ' select', 'ks');
  await p.fill(fld('Číslo materiálu') + ' input', '0012345');
  await p.click('.check:has-text("Team Leader")');
  await p.click('button:has-text("Odeslat")');
  await p.waitForSelector('.toast.bad');
  check(/Foto ŠPATNĚ a Foto SPRÁVNĚ/.test(await p.textContent('#toast')), 'photos required');
  await p.setInputFiles('.pslot.wrong input[type=file]', { name: 'spatne.png', mimeType: 'image/png', buffer: PNG });
  await p.setInputFiles('.pslot.right input[type=file]', { name: 'spravne.png', mimeType: 'image/png', buffer: PNG2 });
  await p.waitForSelector('.pslot.right .ph img');
  await pick(p, 'Je riziko', 'ANO');
  check(await p.isVisible(fld('Zkontrolováno (ks)')), 'risk ANO → check quantities');
  await p.fill(fld('Zkontrolováno (ks)') + ' input', '24');
  await p.fill(fld('Nalezeno špatně (ks)') + ' input', '6');
  await p.selectOption('.ia-row ' + fld('Typ') + ' select', 'blokace / karanténa zásob');
  await p.fill('.ia-row ' + fld('Co bylo uděláno') + ' input', 'Paleta zablokována');
  await p.click('.ia-row ' + fld('Hotovo v') + ' button:has-text("Teď")');
  await p.screenshot({ path: SHOTS + '/02-new.png', fullPage: true });
  c0 = await calls();
  await p.click('button:has-text("Odeslat")');
  await p.waitForSelector('.d-head');
  const id = (await p.textContent('.d-head h1')).match(/Q-\d{4}-\d{3}/)[0];
  check(/Opatření/.test(await p.textContent('.d-head h1 .badge')), 'sent; „Proces zastaven?“ missing → ③ Opatření: ' + id);
  check(/Kvalita/.test(await p.textContent('#sec2')), 'Kvalita added to ② automatically');
  check(env.state.sent.some(m => m.to === 'kvalita@example.com'), 'Quality e-mailed');
  check(env.sheetRows('Problémy').find(r => r.ID === id)['① Číslo materiálu'] === '0012345', 'material number with zeros in the Sheet');
  await p.waitForSelector('.pslot.right .ph img');
  check(await calls() - c0 === 4, 'create = 1 save + 1 refresh + 2 photos: ' + (await calls() - c0));
  check(!(await p.$('text=Rozhodnout')), 'normal user has no decide button');

  // ③ completed later
  await p.click('button:has-text("Doplnit ③")');
  check((await p.$$('.editing .ia-row')).length === 1, 'existing immediate action shown in the form');
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

  // ---------------- leader: closure and ⑦
  await L.reload();
  await L.waitForSelector('button:has-text("Podepsat uzavření")');
  check((await L.$$('.checklist .ok')).length === 6, 'closure checklist all ✓');
  await L.click('button:has-text("Podepsat uzavření")');
  await badgeIs(L, /Uzavřeno/);
  check(true, 'closure signed → Uzavřeno');
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
  const M = await open(MGR, 'id=' + id);
  await M.waitForSelector('text=SPRÁVA (JEN MANAŽER)');
  await M.fill('.card:has-text("SPRÁVA") input', 'Kontrola');
  await M.click('button:has-text("Znovu otevřít")');
  await badgeIs(M, /Ověření/);
  await M.fill('.card:has-text("SPRÁVA") input', 'Duplicita');
  await M.click('button:has-text("Zrušit QRAP")');
  await badgeIs(M, /Zrušeno/);
  check(true, 'manager reopen + cancel');
  await M.click('text=Jak to funguje');
  await M.waitForSelector('table.roles');
  await M.screenshot({ path: SHOTS + '/05-help.png', fullPage: true });

  // ---------------- kiosk (photo exception)
  const K = await open(KIOSK, 'kiosk=1', null, true);
  await K.waitForSelector('.row:not(.head)');
  check(await K.textContent('.who') === 'Kiosk', 'kiosk header');
  await K.click('text=+ Nahlásit problém');
  check(await K.inputValue(fld('JMÉNO') + ' input') === '', 'kiosk: JMÉNO empty');
  await pick(K, 'SAFETY', 'NE');
  await K.selectOption(fld('JAK byl objeven') + ' select', 'inventura');
  await K.fill(fld('CO je za problém') + ' textarea', 'V krabici 48 ks místo 50');
  await pick(K, 'Stejný problém', 'NE');
  await K.selectOption(fld('KDE? – zóna') + ' select', 'Sklad');
  await K.fill(fld('KDE? – lokace') + ' input', 'C-04-01');
  await K.fill(fld('KOLIK?') + ' input', '2');
  await K.selectOption(fld('Jednotka') + ' select', 'ks');
  await K.fill(fld('Číslo odznaku') + ' input', '4711');
  await K.click('text=Fotku nelze pořídit');
  await K.fill(fld('Důvod výjimky') + ' textarea', 'Kiosk bez fotoaparátu');
  await K.click('.check:has-text("Supervizor")');
  await pick(K, 'Je riziko', 'NE');
  await K.click('button:has-text("Odeslat")');
  await K.waitForSelector('.done-page');
  check(/odeslán/.test(await K.textContent('.done-page h1')), 'kiosk thank-you page');
  await K.screenshot({ path: SHOTS + '/06-kiosk-done.png' });
  await K.clock.fastForward(30000);
  await K.waitForSelector('.tiles', { timeout: 5000 });
  check(true, 'kiosk returns to the board by itself');
  const kr = env.sheetRows('Problémy').find(r => r['① Číslo odznaku'] === '4711');
  check(kr && kr['Stav'] === 'OPATŘENÍ' && kr['Účet'] === KIOSK && /bez fotoaparátu/.test(kr['① Výjimka – proč nejsou fotky']), 'kiosk QRAP stored');

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
