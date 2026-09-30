// Browser test of eQRAP Lite: report → ③ → decision → ⑤ → action → done → verify → ⑦, kiosk, mobile.
'use strict';
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { start } = require('./lite_e2e_server');
const path = require('path');
const SHOTS = path.join(__dirname, 'shots');
require('fs').mkdirSync(SHOTS, { recursive: true });
const PNG = require('./png')(1600, 1200, [200, 40, 40]);
let failures = 0;
const check = (c, m) => { if (!c) { failures++; console.log('FAIL:', m); } else console.log('ok:', m); };
const USER = 'tomas.cerny@example.com', LEAD = 'jana.novakova@example.com', MGR = 'eva.dvorakova@example.com', KIOSK = 'kiosk.expedice@example.com';

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
  const toastGone = p => p.waitForFunction(() => document.getElementById('toast').hidden, null, { timeout: 10000 });
  const status = p => p.textContent('.d-head h1 .badge');

  // ---------------- board (user)
  let c0 = await calls();
  let p = await open(USER);
  await p.waitForSelector('.row:not(.head)');
  check(await calls() === c0, 'board shows without any extra server call');
  check((await p.$$('.row:not(.head)')).length === 3, 'three example problems');
  const tiles = await p.$$eval('.tile', els => els.map(e => e.textContent));
  check(tiles.length === 5 && /Otevřené/.test(tiles[0]), 'tiles ' + tiles.join(' | '));
  await p.screenshot({ path: SHOTS + '/01-board.png' });
  await p.fill('input[type=search]', '00-4711');
  check((await p.$$('.row:not(.head)')).length === 1, 'search by part number');
  await p.fill('input[type=search]', '');
  await p.click('.tile:has-text("Čeká na rozhodnutí")');
  check((await p.$$('.row:not(.head)')).length === 1, 'filter tile');
  await p.click('.tile:has-text("Otevřené")');

  // ---------------- new problem
  await p.click('text=+ Nahlásit problém');
  await p.waitForSelector('text=Odeslat hlášení');
  check(await p.inputValue('.fld:has-text("Kdo hlásí") input') === 'Tomáš Černý', 'reporter prefilled');
  await p.click('text=Odeslat hlášení');
  await p.waitForSelector('.toast.bad');
  check(/Typ problému, Co se stalo, Koho jste/.test(await p.textContent('#toast')), 'validation message: ' + await p.textContent('#toast'));
  check((await p.$$('.fld.invalid')).length === 3, 'missing fields marked red');
  check(await p.inputValue('.fld:has-text("Oblast") select') === 'Expedice', 'area prefilled from Lidé');
  await p.selectOption('.fld:has-text("Oblast") select', 'Expedice');
  await p.selectOption('.fld:has-text("Typ problému") select', 'Záměna dílu');
  await p.fill('.fld:has-text("Co se stalo") textarea', 'Na paletě pro zákazníka C je jiný díl, než je na etiketě');
  await p.fill('.fld:has-text("Kde přesně") input', 'Rampa 2');
  await p.fill('.fld:has-text("Číslo dílu") input', '0012345');
  await p.fill('.fld:has-text("Množství NOK") input', '6');
  await p.click('.check:has-text("Vedoucí směny")');
  await p.setInputFiles('.photos input[type=file]', { name: 'foto.png', mimeType: 'image/png', buffer: PNG });
  await p.waitForSelector('.photos .ph img');
  await p.screenshot({ path: SHOTS + '/02-new.png', fullPage: true });
  c0 = await calls();
  await p.click('text=Odeslat hlášení');
  await p.waitForSelector('.d-head');
  await p.waitForSelector('.ph img');
  check(await calls() - c0 === 3, 'create = 1 save + 1 background refresh + 1 photo: ' + (await calls() - c0));
  const id = (await p.textContent('.d-head h1')).match(/Q-\d{4}-\d{3}/)[0];
  check(/Opatření/.test(await status(p)), 'new problem waits for ③: ' + id);
  check(env.sheetRows('Problémy').find(r => r.ID === id)['① Číslo dílu'] === '0012345', 'part number with zeros in Sheet');
  check(!(await p.$('text=Rozhodnout')), 'normal user has no decide button');
  await p.waitForSelector('.ph img');
  check(true, 'photo loads in detail');

  // ③
  await p.click('text=Vyplnit ③');
  await p.fill('.fld:has-text("Co bylo okamžitě uděláno") textarea', 'Paleta zastavena, díly vyměněny');
  await p.click('.check:has-text("Rampa / kamion")');
  await p.fill('.fld:has-text("Zkontrolováno ks") input', '24');
  await p.fill('.fld:has-text("Z toho NOK") input', '6');
  await p.selectOption('.fld:has-text("Zákazník informován") select', 'NENÍ POTŘEBA');
  await p.click('text=Uložit – opatření jsou hotová');
  await p.waitForFunction(() => /Rozhodnutí/.test(document.querySelector('.d-head h1 .badge').textContent));
  check(true, '③ saved → waiting for decision');
  // back button returns to board
  await p.goBack();
  await p.waitForSelector('.tiles');
  check(true, 'browser back → board');

  // ---------------- leader
  const L = await open(LEAD, 'id=' + id);
  await L.waitForSelector('.d-head');
  check(/Vedoucí/.test(await L.textContent('.who')), 'leader role shown');
  await L.click('button:has-text("Rozhodnout")');
  await L.click('.choice:has-text("Pokračovat analýzou")');
  await L.click('text=Potvrdit rozhodnutí');
  await L.waitForFunction(() => /Analýza/.test(document.querySelector('.d-head h1 .badge').textContent));
  check(true, '④ ANALÝZA');
  await L.click('text=Vyplnit ⑤');
  await L.fill('.fld:has-text("Proč 1?") input', 'Etiketa z jiné zakázky');
  await L.fill('.fld:has-text("Proč 2?") input', 'Tiskárna tiskla frontu z předchozí směny');
  await L.fill('.fld:has-text("Hlavní příčina") textarea', 'Tisková fronta se na konci směny nemaže');
  await L.selectOption('.fld:has-text("Kategorie příčiny") select', 'Postup / metoda');
  await L.click('text=Uložit příčinu');
  await L.waitForSelector('.root');
  await L.click('text=+ Přidat akci');
  await L.fill('.act-form .fld:has-text("Co se udělá") textarea', 'Mazat tiskovou frontu při předávce směny');
  await L.fill('.act-form .fld:has-text("Odpovědná osoba") input', 'Tomáš Černý');
  const due = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  await L.fill('.act-form input[type=date]', due);
  await L.click('text=Přidat akci');
  await L.waitForSelector('.act');
  check(env.state.sent.some(m => m.to === USER && /máte novou akci/.test(m.subject)), 'owner got e-mail');
  await L.screenshot({ path: SHOTS + '/03-detail-leader.png', fullPage: true });

  // ---------------- owner marks done
  await p.goto('http://localhost:8124/?as=' + encodeURIComponent(USER));
  await p.waitForSelector('text=MOJE AKCE (1)');
  await p.click('.tile:has-text("Moje úkoly")');
  check((await p.$$('.row:not(.head)')).length === 1, 'my tasks = my action');
  await p.click('.card:has-text("MOJE AKCE") button:has-text("Otevřít")');
  await p.click('button:has-text("✓ Hotovo")');
  await p.waitForFunction(() => /Ověření/.test(document.querySelector('.d-head h1 .badge').textContent));
  check(true, 'action done → Ověření');

  // ---------------- leader verifies and assesses
  await L.reload();
  await L.waitForSelector('text=Ověřit a uzavřít');
  await L.click('text=Ověřit a uzavřít');
  await L.click('.choice:has-text("Neopakoval")');
  await L.click('text=Uložit ověření');
  await L.waitForFunction(() => /Uzavřeno/.test(document.querySelector('.d-head h1 .badge').textContent));
  check(true, 'verified → Uzavřeno');
  await L.click('button:has-text("Ohodnotit")');
  for (const c of await L.$$('.choices.inline')) await (await c.$('.choice:has-text("OK")')).click();
  await L.click('text=Uložit hodnocení');
  await L.waitForSelector('.crit');
  await L.click('.card:has-text("HISTORIE") button:has-text("Zobrazit")');
  await L.waitForSelector('.timeline li');
  check((await L.$$('.timeline li')).length >= 8, 'history entries');
  await L.screenshot({ path: SHOTS + '/04-closed.png', fullPage: true });
  await L.emulateMedia({ media: 'print' });
  await L.screenshot({ path: SHOTS + '/05-print.png', fullPage: true });
  await L.emulateMedia({ media: 'screen' });

  // ---------------- manager: cancel + reopen
  const M = await open(MGR, 'id=' + id);
  await M.waitForSelector('text=SPRÁVA (JEN MANAŽER)');
  await M.click('text=Znovu otevřít');
  await M.waitForFunction(() => /Ověření/.test(document.querySelector('.d-head h1 .badge').textContent));
  await M.fill('.card:has-text("SPRÁVA") input', 'Duplicita');
  await M.click('text=Zrušit problém');
  await M.waitForFunction(() => /Zrušeno/.test(document.querySelector('.d-head h1 .badge').textContent));
  check(true, 'manager reopen + cancel');
  await M.click('text=Jak to funguje');
  await M.waitForSelector('table.roles');
  await M.screenshot({ path: SHOTS + '/06-help.png', fullPage: true });

  // ---------------- kiosk
  const K = await open(KIOSK, 'kiosk=1', null, true);
  await K.waitForSelector('.row:not(.head)');
  check(await K.textContent('.who') === 'Kiosk', 'kiosk header');
  await K.click('text=+ Nahlásit problém');
  check(await K.inputValue('.fld:has-text("Kdo hlásí") input') === '', 'kiosk reporter empty');
  await K.fill('.fld:has-text("Kdo hlásí") input', 'Operátor Směna B');
  await K.selectOption('.fld:has-text("Oblast") select', 'Sklad');
  await K.selectOption('.fld:has-text("Typ problému") select', 'Chybné množství');
  await K.fill('.fld:has-text("Co se stalo") textarea', 'V krabici 48 ks místo 50');
  await K.click('.check:has-text("Mistr skladu")');
  await K.click('text=Okamžitá opatření už jsou hotová');
  await K.fill('.fld:has-text("Co bylo okamžitě uděláno") textarea', 'Krabice doplněna');
  await K.selectOption('.fld:has-text("Zákazník informován") select', 'NE');
  await K.fill('.fld:has-text("Kdo opatření provedl") input', 'Operátor Směna B');
  await K.click('text=Odeslat hlášení');
  await K.waitForSelector('.done-page');
  check(/Děkujeme/.test(await K.textContent('.done-page h1')), 'kiosk thank-you page');
  await K.screenshot({ path: SHOTS + '/07-kiosk-done.png' });
  await K.clock.fastForward(30000);
  await K.waitForSelector('.tiles', { timeout: 5000 });
  check(true, 'kiosk returns to board by itself');
  const kr = env.sheetRows('Problémy').find(r => r['① Kdo hlásí'] === 'Operátor Směna B');
  check(kr && kr['Stav'] === 'ROZHODNUTÍ' && kr['Účet'] === KIOSK, 'kiosk problem stored with ③');

  // ---------------- phone
  const P = await open(LEAD, '', { width: 390, height: 844 });
  await P.waitForSelector('.row:not(.head)');
  await P.screenshot({ path: SHOTS + '/08-phone-board.png', fullPage: true });
  const overflow = await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no horizontal scroll on phone');
  await P.click('.row:not(.head) >> nth=0');
  await P.waitForSelector('.d-head');
  await P.screenshot({ path: SHOTS + '/09-phone-detail.png', fullPage: true });
  check(!(await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll on phone detail');
  await P.click('text=+ Nahlásit problém');
  await P.screenshot({ path: SHOTS + '/10-phone-new.png', fullPage: true });

  check(errors.length === 0, 'no page errors ' + errors.join(' | '));
  await browser.close();
  server.close();
  console.log(failures ? failures + ' FAILED' : 'ALL OK');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
