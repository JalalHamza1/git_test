// Drives dist/preview.html (sample data, no server) through the main flows in Chromium.
// Usage: node tools/build-preview.js && node test/ui.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !/ERR_/.test(m.text())) errors.push(m.text()); });
  await page.goto('file://' + path.join(__dirname, '..', 'dist', 'preview.html'));
  await page.waitForSelector('.prow');
  let passed = 0;
  const step = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); await page.screenshot({ path: path.join(__dirname, 'failure.png') }); throw e; } };
  const snackText = () => page.textContent('#snackText');
  const wait = ms => page.waitForTimeout(ms);
  const state = (fn, arg) => page.evaluate(fn, arg);

  await step('Typing in a note survives slow server replies (like real Apps Script)', async () => {
    // Make saves answer after 900 ms with a snapshot taken when the save was sent, as the real server does.
    await page.evaluate(() => {
      const real = google.script.run;
      const runner = (ok, fail) => new Proxy({}, { get: (_, name) => {
        if (name === 'withSuccessHandler') return fn => runner(fn, fail);
        if (name === 'withFailureHandler') return fn => runner(ok, fn);
        return (...args) => {
          let snap = null;
          if (name === 'saveNote') { const n = S.notes.find(x => x.id === args[0].id); snap = { notes: [Object.assign(JSON.parse(JSON.stringify(n || {})), args[0])] }; }
          if (name === 'saveTask') { const t = S.tasks.find(x => x.id === args[0].id); snap = { tasks: [Object.assign(JSON.parse(JSON.stringify(t || {})), args[0])] }; }
          if (!snap) return real.withSuccessHandler(ok).withFailureHandler(fail)[name](...args);
          setTimeout(() => ok && ok(JSON.parse(JSON.stringify(snap))), 900);
        };
      } });
      window.google.script.run = runner();
    });
    await page.click('.srow[data-id="demop1"]');
    await page.click('[data-act="tab"][data-v="notes"]');
    await page.click('[data-act="new-note"][data-v="reference"]');
    await page.type('.ntitle', 'Vendor contacts', { delay: 30 });
    await page.click('.nbody');
    const lines = ['Ana handles the ERP export', 'Ravi owns the QA log', 'Tom needs numbers by Monday 10:00'];
    for (const l of lines) { await page.keyboard.type(l + '\n', { delay: 25 }); await wait(1100); }
    await wait(2000);
    const val = await page.inputValue('.nbody');
    lines.forEach(l => assert.ok(val.includes(l), 'textarea lost: ' + l));
    assert.strictEqual(await page.inputValue('.ntitle'), 'Vendor contacts');
    const st = await state(() => { const n = S.notes.find(x => x.title === 'Vendor contacts'); return n && n.body; });
    lines.forEach(l => assert.ok(st && st.includes(l), 'state lost: ' + l));
    // Leaving the editor shows the latest text everywhere.
    await page.click('[data-act="tab"][data-v="overview"]');
    await page.click('[data-act="tab"][data-v="notes"]');
    await page.click('.nitem:has-text("Vendor contacts")');
    assert.ok((await page.inputValue('.nbody')).includes(lines[2]));
    // Task details typed in the panel survive too.
    await page.click('[data-act="tab"][data-v="tasks"]');
    await page.click('.task[data-id="demox09"] .tt');
    await page.click('#panel .pn-desc');
    for (const w of ['Book the room. ', 'Bring laptops. ', 'Share the link.']) { await page.keyboard.type(w, { delay: 25 }); await wait(1000); }
    await wait(1500);
    assert.strictEqual(await page.inputValue('#panel .pn-desc'), 'Book the room. Bring laptops. Share the link.');
    await page.keyboard.press('Escape');
    await wait(1200);
    assert.strictEqual(await state(() => S.tasks.find(t => t.id === 'demox09').desc), 'Book the room. Bring laptops. Share the link.');
    await page.reload();
    await page.waitForSelector('.nav[data-v="home"]');
    await page.click('.nav[data-v="home"]');
    await page.waitForSelector('.prow');
  });

  await step('Home lists open projects riskiest first, with attention items', async () => {
    assert.strictEqual(await page.locator('.prow').count(), 4);
    assert.ok(await page.locator('.att').count() >= 4);
    const first = await page.locator('.prow .pname').first().textContent();
    assert.match(first, /TV Automation/, 'blocked project with old update sorts first');
  });

  await step('Project overview shows goal, milestones, progress and signals', async () => {
    await page.click('.srow[data-id="demop1"]');
    await page.waitForSelector('.tabs');
    assert.match(await page.textContent('#viewTitle'), /Excel Digitization/);
    assert.strictEqual(await page.locator('.mrow').count(), 4);
    assert.ok(await page.locator('.sig').count() >= 2);
    assert.ok(await page.locator('.summary .fact').count() === 3);
  });

  await step('Completing a blocker that was itself blocked unblocks the task waiting on it', async () => {
    await page.click('[data-act="tab"][data-v="tasks"]');
    await page.click('.task[data-id="demox07"] .tt');
    await page.waitForSelector('#panel.open .blockbox');
    await page.click('#panel .blockbox .bitem .check');
    await wait(150);
    assert.match(await snackText(), /Unblocked: Build the QA log sheet/);
    assert.strictEqual(await state(() => S.tasks.find(t => t.id === 'demox07').status), 'Not started');
    assert.strictEqual(await page.locator('#panel .blockbox').count(), 0);
    assert.ok(await page.locator('#panel .hist div').count() >= 1, 'block moved into history');
  });

  await step('Marking a task blocked asks why and creates the unblocking task', async () => {
    await page.click('.task[data-id="demox08"] .tt');
    await page.click('#panel [data-act="block"]');
    await page.waitForSelector('.dlg #bReason');
    await page.click('.dlg .btn.danger');
    assert.match(await page.textContent('#bErr'), /reason/);
    await page.fill('#bReason', 'Need read access to the old file share');
    await page.fill('.dlg [data-new]', 'Ask IT for file share access');
    await page.fill('#bWait', 'IT helpdesk');
    await page.click('.dlg .btn.danger');
    await wait(100);
    const t = await state(() => { const t = S.tasks.find(x => x.id === 'demox08'); return { status: t.status, reason: t.blockReason, by: t.blockedBy.length, waiting: t.waiting }; });
    assert.deepStrictEqual(t, { status: 'Blocked', reason: 'Need read access to the old file share', by: 1, waiting: 'IT helpdesk' });
    assert.ok(await page.locator('.task .tt', { hasText: 'Ask IT for file share access' }).count());
    await page.waitForSelector('#panel .blockbox');
  });

  await step('Finishing the unblocking task keeps it blocked while still waiting; "It arrived" unblocks', async () => {
    await page.click('#panel .blockbox .bitem .check');
    await wait(100);
    assert.strictEqual(await state(() => S.tasks.find(t => t.id === 'demox08').status), 'Blocked');
    await page.click('#panel .blockbox [data-act="arrived"]');
    await wait(100);
    assert.strictEqual(await state(() => S.tasks.find(t => t.id === 'demox08').status), 'Not started');
    assert.match(await snackText(), /came through/);
    await page.keyboard.press('Escape');
  });

  await step('Completing the last open task of a milestone marks it reached; undo reopens it', async () => {
    await page.click('[data-act="tab"][data-v="tasks"]');
    for (const id of ['demox05', 'demox06', 'demox07', 'demox08']) {
      const done = await state(i => S.tasks.find(t => t.id === i).archived, id);
      if (!done) { await page.click(`.task[data-id="${id}"] .check`); await wait(350); }
    }
    const extra = await state(() => S.tasks.filter(t => t.milestone === 'demom2' && !t.archived).map(t => t.id));
    for (const id of extra) { await page.click(`.task[data-id="${id}"] .check`); await wait(350); }
    assert.ok(await state(() => !!S.milestones.find(m => m.id === 'demom2').done), 'milestone reached');
    assert.match(await snackText(), /Milestone reached: Sheets built/);
    await page.click('#snackAction');
    await wait(100);
    assert.strictEqual(await state(() => S.milestones.find(m => m.id === 'demom2').done), '');
  });

  await step('Quick add understands date, priority, size and ^milestone', async () => {
    await page.fill('[data-key="qa:ms:demop1:demom2"]', 'Write the rollout email tomorrow !high ~L ^Team');
    await page.waitForSelector('[data-preview="ms:demop1:demom2"] .chip');
    await page.press('[data-key="qa:ms:demop1:demom2"]', 'Enter');
    await wait(100);
    const t = await state(() => { const t = S.tasks.find(x => x.title === 'Write the rollout email'); return t && { m: t.milestone, p: t.priority, s: t.size, due: !!t.due }; });
    assert.deepStrictEqual(t, { m: 'demom3', p: 'High', s: 3, due: true });
  });

  await step('Notes: action items become tasks and the link is kept', async () => {
    await page.click('[data-act="tab"][data-v="notes"]');
    await page.click('.nitem:has-text("Kickoff")');
    const before = await state(() => S.tasks.length);
    await page.click('[data-act="note-task"]');
    await wait(100);
    assert.strictEqual(await state(() => S.tasks.length), before + 1);
    assert.ok(await page.locator('.ai-row .made').count() >= 2);
    await page.fill('.nbody', (await page.inputValue('.nbody')) + '\n[ ] Book the training room');
    await wait(50);
    assert.ok(await page.locator('.ai-row', { hasText: 'Book the training room' }).count());
  });

  await step('New decision note and status update', async () => {
    await page.click('[data-act="new-note"][data-v="decision"]');
    await page.fill('.ntitle', 'Use Apps Script for the import');
    await page.click('[data-act="tab"][data-v="overview"]');
    assert.ok(await page.locator('.nmini', { hasText: 'Use Apps Script for the import' }).count(), 'decision shows on overview');
    await page.click('[data-act="compose"]');
    await page.click('.hbtn.amber');
    await page.fill('[data-key="upd:ov:demop1"]', 'Sheets are built. IT access is still slow.');
    await page.click('[data-act="post-update"]');
    await wait(50);
    assert.strictEqual(await state(() => S.updates.filter(u => u.projectId === 'demop1').length), 3);
    assert.ok((await page.textContent('.upd')).includes('IT access is still slow'));
  });

  await step('Milestones dialog adds, renames and saves', async () => {
    await page.click('.srow[data-id="demop2"]');
    await page.click('[data-act="milestones"]');
    await page.click('.dlg [data-madd]');
    await page.fill('.dlg .mline:last-child [data-mn]', 'Cohort signed off');
    await page.fill('.dlg .mline:last-child [data-mt]', '2030-01-15');
    await page.click('.dlg .btn.primary');
    await wait(50);
    assert.ok(await state(() => S.milestones.some(m => m.projectId === 'demop2' && m.name === 'Cohort signed off' && m.order === 2)));
  });

  await step('Blocked project: banner, "It arrived" reactivates it', async () => {
    await page.click('.srow[data-id="demop4"]');
    await page.waitForSelector('.blockbox');
    assert.match(await page.textContent('.blockbox .reason'), /TV model/);
    await page.click('.blockbox [data-act="arrived"]');
    await wait(50);
    assert.strictEqual(await state(() => S.projects.find(p => p.id === 'demop4').status), 'active');
  });

  await step('Project can be blocked from its status menu with an unblocking task', async () => {
    await page.click('[data-act="status-menu"]');
    await page.click('.menu-i:has-text("Blocked")');
    await page.fill('#bReason', 'Waiting for budget sign-off');
    await page.fill('.dlg [data-new]', 'Send the quote to Finance');
    await page.click('.dlg .btn.danger');
    await wait(50);
    const p = await state(() => S.projects.find(x => x.id === 'demop4'));
    assert.strictEqual(p.status, 'blocked');
    const tid = p.blockedBy[0];
    await page.click('[data-act="tab"][data-v="overview"]');
    await page.click(`.blockbox .check[data-id="${tid}"]`);
    await wait(100);
    assert.strictEqual(await state(() => S.projects.find(x => x.id === 'demop4').status), 'active');
  });

  await step('QRQC offers to close; closing records the outcome', async () => {
    await page.click('.srow[data-id="demop3"]');
    await page.fill('[data-key="outcome:demop3"]', 'Repeat defects down 38%');
    await page.click('[data-act="close-project"]');
    await wait(50);
    const p = await state(() => S.projects.find(x => x.id === 'demop3'));
    assert.strictEqual(p.status, 'done');
    assert.strictEqual(p.outcome, 'Repeat defects down 38%');
  });

  await step('Other views render: My Day, Upcoming, Starred, Review, Trash, Search', async () => {
    for (const v of ['myday', 'upcoming', 'starred', 'review', 'trash']) {
      await page.click(`.nav[data-v="${v}"]`);
      await page.waitForSelector('.wrap');
    }
    await page.click('.nav[data-v="myday"]');
    assert.ok(await page.locator('.task').count() >= 3);
    await page.click('.nav[data-v="review"]');
    assert.ok(await page.locator('.composer').count() >= 1);
    await page.fill('#search', 'shared');
    await wait(250);
    assert.strictEqual(await state(() => S.view), 'search');
    assert.ok(await page.locator('mark').count() >= 1);
    await page.keyboard.press('Escape');
  });

  await step('Create task from the panel, plan it for today', async () => {
    await page.click('.drawer .create');
    await page.fill('#panel .pn-title', 'Call the supplier');
    await page.click('#panel .quick button:has-text("Today")');
    await page.click('#panel [data-act="submit-new"]');
    await wait(50);
    const t = await state(() => S.tasks.find(x => x.title === 'Call the supplier'));
    assert.ok(t && t.plan);
  });

  await step('A list can be turned into a project; a new project can be created', async () => {
    await page.click('.srow[data-name="Personal"]');
    await page.click('[data-act="list-menu"]');
    await page.click('.menu-i:has-text("Turn into a project")');
    await page.click('.dlg .btn.primary');
    await page.waitForSelector('.dlg #pName');
    await page.fill('#pTarget', '2030-06-01');
    await page.click('.dlg .btn.primary');
    await wait(50);
    assert.ok(await state(() => S.projects.some(p => p.name === 'Personal' && p.target === '2030-06-01')));
    await page.click('[data-act="new-project"]');
    await page.fill('#pName', 'Website refresh');
    await page.click('.dlg .btn.primary');
    await wait(50);
    assert.match(await page.textContent('#viewTitle'), /Website refresh/);
  });

  await step('Phone width: no sideways scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const sel of ['.nav[data-v="home"]', '.srow[data-id="demop1"]']) {
      await page.evaluate(s => document.querySelector(s).click(), sel);
      await wait(100);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.getElementById('main').scrollWidth]);
      assert.ok(w[0] <= 390 && w[1] <= 390, 'width ' + w);
    }
  });

  assert.deepStrictEqual(errors, [], 'no script errors');
  console.log(`\n${passed} UI checks passed`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
