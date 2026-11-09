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
  const LOCAL = 'file://' + path.join(__dirname, '..', 'dist', 'preview-local.html');
  const CDN_PAGE = 'file://' + path.join(__dirname, '..', 'dist', 'preview.html');
  const optional = require('fs').readFileSync(path.join(__dirname, '..', 'optional', 'quill.html'), 'utf8');
  const QUILL_JS = optional.slice(optional.indexOf('<script>\n') + 9, optional.lastIndexOf('\n</script>'));
  // The offline copy must be exactly the file the CDN loader's integrity hash allows.
  const pinned = /integrity = '(sha384-[^']+)'/.exec(require('fs').readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'))[1];
  assert.strictEqual('sha384-' + require('crypto').createHash('sha384').update(QUILL_JS, 'utf8').digest('base64'), pinned, 'optional/quill.html matches the pinned hash');
  await page.goto(LOCAL);
  await page.waitForSelector('.prow');
  let passed = 0;
  const step = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); if (errors.length) console.log('    page errors:', errors); await page.screenshot({ path: path.join(__dirname, 'failure.png') }); throw e; } };
  const snackText = () => page.textContent('#snackText');
  const wait = ms => page.waitForTimeout(ms);
  const state = (fn, arg) => page.evaluate(fn, arg);
  const ops = () => state(() => NE.quill.getContents().ops);
  const selectText = (text, len) => state(([t, l]) => {
    let pos = 0;
    for (const op of NE.quill.getContents().ops) {
      if (typeof op.insert !== 'string') { pos += 1; continue; }
      const k = op.insert.indexOf(t);
      if (k >= 0) { NE.quill.setSelection(pos + k, l == null ? t.length : l, 'user'); return pos + k; }
      pos += op.insert.length;
    }
    throw new Error('text not found: ' + t);
  }, [text, len]);
  // Click a note checkbox where it is drawn (it's a pseudo-element in the line's left margin), and make
  // sure that spot really is Quill's checkbox element, as it would be for a person clicking it.
  const clickBox = async liSel => {
    const r = await page.locator(liSel).first().boundingBox();
    const x = r.x + 10, y = r.y + Math.min(r.height, 24) / 2;
    const hit = await page.evaluate(([px, py]) => { const el = document.elementFromPoint(px, py); return el && el.className; }, [x, y]);
    assert.strictEqual(hit, 'ql-ui', 'checkbox is under the pointer');
    await page.mouse.click(x, y);
  };
  // Block formats of the line containing `text` (they sit on that line's newline).
  const lineAttrs = (all, text) => {
    const i = all.findIndex(o => typeof o.insert === 'string' && o.insert.includes(text));
    if (i < 0) return null;
    if (all[i].insert.slice(all[i].insert.indexOf(text) + text.length).includes('\n')) return all[i].attributes || {};
    for (let j = i + 1; j < all.length; j++) if (typeof all[j].insert === 'string' && all[j].insert.includes('\n')) return all[j].attributes || {};
    return null;
  };

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
    await page.click('.ne .ql-editor');
    const lines = ['Ana handles the ERP export', 'Ravi owns the QA log', 'Tom needs numbers by Monday 10:00'];
    for (const l of lines) { await page.keyboard.type(l + '\n', { delay: 25 }); await wait(1100); }
    await wait(2000);
    const val = await state(() => NE.quill.getText());
    lines.forEach(l => assert.ok(val.includes(l), 'editor lost: ' + l));
    assert.strictEqual(await page.inputValue('.ntitle'), 'Vendor contacts');
    const st = await state(() => { const n = S.notes.find(x => x.title === 'Vendor contacts'); return n && noteText(n); });
    lines.forEach(l => assert.ok(st && st.includes(l), 'state lost: ' + l));
    // Leaving the editor shows the latest text everywhere, and the same editor comes back.
    await page.click('[data-act="tab"][data-v="overview"]');
    await page.click('[data-act="tab"][data-v="notes"]');
    await page.click('.nitem:has-text("Vendor contacts")');
    assert.ok((await state(() => NE.quill.getText())).includes(lines[2]));
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

  await step('Old plain-text notes open formatted, and checkboxes match their tasks', async () => {
    await page.click('[data-act="tab"][data-v="notes"]');
    await page.click('.nitem:has-text("Kickoff")');
    await page.waitForSelector('.ne .ql-editor li');
    assert.strictEqual(await page.locator('.ne .ql-editor li[data-list="bullet"]').count(), 2);
    assert.strictEqual(await page.locator('.ne .ql-editor li[data-list="unchecked"], .ne .ql-editor li[data-list="checked"]').count(), 3);
    // "Ask IT…" was linked to demox06, which an earlier step completed: its box is ticked on open.
    assert.strictEqual(await page.getAttribute('.ne .ql-editor li[data-task="demox06"]', 'data-list'), 'checked');
    await page.click('.nitem:has-text("One sheet per report")');
    await page.waitForSelector('.ne .ql-editor h3');
    assert.ok(await page.locator('.ne .ql-editor li.ql-indent-1').count(), 'nested bullet');
    assert.ok(await page.locator('.ne .ql-editor a[href*="lookerstudio"]').count(), 'link');
  });

  await step('Typing shortcuts: # heading, - bullets, Tab / Shift+Tab, [ ] checkbox, --- divider, Ctrl+B', async () => {
    await page.click('[data-act="new-note"][data-v="reference"]');
    await page.fill('.ntitle', 'Rollout plan');
    await page.keyboard.press('Enter');                     // Enter in the title jumps into the text
    await page.keyboard.type('# Plan\n', { delay: 10 });
    await page.keyboard.type('- First point\n', { delay: 10 });
    await page.keyboard.type('Second', { delay: 10 });
    await page.keyboard.press('Tab');                        // mid-line Tab still indents the item
    await page.keyboard.type(' (detail)\n', { delay: 10 });
    await page.keyboard.press('Enter');                      // empty nested item: step out one level
    await page.keyboard.type('Third\n', { delay: 10 });
    await page.keyboard.press('Enter');                      // empty top-level item: leave the list
    await page.keyboard.type('[ ] Call IT about access\n', { delay: 10 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('---\n', { delay: 10 });
    await page.keyboard.type('Owner is Ana', { delay: 10 });
    await page.keyboard.down('Shift');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Control+b');
    const all = await ops();
    assert.deepStrictEqual(lineAttrs(all, 'Plan'), { header: 1 });
    assert.deepStrictEqual(lineAttrs(all, 'First point'), { list: 'bullet' });
    assert.deepStrictEqual(lineAttrs(all, 'Second'), { list: 'bullet', indent: 1 });
    assert.deepStrictEqual(lineAttrs(all, 'Third'), { list: 'bullet' });
    assert.deepStrictEqual(lineAttrs(all, 'Call IT about access'), { list: 'unchecked' });
    assert.ok(all.some(o => o.insert && o.insert.divider), 'divider');
    assert.ok(all.some(o => o.insert === 'Ana' && o.attributes && o.attributes.bold), 'bold');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Tab');                  // outdent on a plain line does nothing harmful
  });

  await step('Make task from a checkbox; ticking it completes the task and unticking reopens it', async () => {
    await page.hover('.ne .ql-editor li:has-text("Call IT about access")');
    await page.waitForSelector('.ne-hover:not([hidden])');
    assert.match(await page.textContent('.ne-hover'), /Make task/);
    await page.click('.ne-hover');
    await wait(100);
    const id = await page.getAttribute('.ne .ql-editor li:has-text("Call IT about access")', 'data-task');
    assert.ok(id, 'checkbox linked');
    const t = await state(i => { const t = S.tasks.find(x => x.id === i); return t && { title: t.title, list: t.list, ms: t.milestone }; }, id);
    assert.deepStrictEqual(t, { title: 'Call IT about access', list: 'Excel Digitization', ms: 'demom2' });
    await clickBox(`.ne .ql-editor li[data-task="${id}"]`);
    await wait(100);
    assert.strictEqual(await state(i => S.tasks.find(x => x.id === i).archType, id), 'Completed');
    await clickBox(`.ne .ql-editor li[data-task="${id}"]`);
    await wait(100);
    assert.strictEqual(await state(i => S.tasks.find(x => x.id === i).archType, id), '');
    // Completing the task elsewhere ticks the box, in the open editor and in the saved note.
    await page.click('[data-act="tab"][data-v="tasks"]');
    await page.click(`.task[data-id="${id}"] .check`);
    await wait(400);
    await page.click('[data-act="tab"][data-v="notes"]');
    assert.strictEqual(await page.getAttribute(`.ne .ql-editor li[data-task="${id}"]`, 'data-list'), 'checked');
    await wait(1000);
    // Line(s) to tasks from the toolbar, several at once.
    await page.click('.ne .ql-editor');
    await state(() => { const q = NE.quill, txt = q.getText(), a = txt.indexOf('First point'), b = txt.indexOf('Third'); q.setSelection(a, b - a + 2, 'user'); });
    await page.click('.ne-bar [data-ne="task"]');
    await wait(100);
    for (const title of ['First point', 'Second (detail)', 'Third']) assert.ok(await state(x => S.tasks.some(t => t.title === x && t.list === 'Excel Digitization'), title), 'task ' + title);
    assert.match(await page.textContent('.ne-info'), /4 checkboxes · 4 linked to tasks/);
  });

  await step('A note that is not open gets its checkbox ticked when the task is completed', async () => {
    const id = await page.getAttribute('.ne .ql-editor li:has-text("Third")', 'data-task');
    const noteId = await state(() => NE.noteId);
    await page.click('.nitem:has-text("Kickoff")');            // the rollout note is no longer open
    await page.click('[data-act="tab"][data-v="tasks"]');
    await page.click(`.task[data-id="${id}"] .check`);
    await wait(400);
    const body = await state(n => S.notes.find(x => x.id === n).body, noteId);
    const line = JSON.parse(body).ops.find(o => o.attributes && o.attributes.task === id);
    assert.strictEqual(line.attributes.list, 'checked');
    await page.click('[data-act="tab"][data-v="notes"]');
  });

  await step('Links (Ctrl+K), clean paste, search', async () => {
    await page.click('.nitem:has-text("Rollout plan")');
    await page.click('.ne .ql-editor');
    await selectText('Owner');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.ne-pop input');
    await page.keyboard.type('example.com/rollout');
    await page.keyboard.press('Enter');
    const lops = await ops();
    assert.ok(lops.some(o => o.insert === 'Owner' && o.attributes && o.attributes.link === 'https://example.com/rollout'), JSON.stringify(lops.slice(-8)));
    const at = await selectText('Owner', 0);
    await state(i => NE.quill.setSelection(i + 2, 0, 'user'), at);
    await page.waitForSelector('.ne-pop a[href="https://example.com/rollout"]');
    // Paste from a web page: keep bold and the list, drop colours and sizes.
    await state(() => { const q = NE.quill; q.setSelection(q.getLength() - 1, 0, 'user'); });
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<p><span style="color:#ff0000;background:#00ff00;font-size:28px"><b>Pasted bold</b> plain</span></p><ul><li>Pasted item</li></ul>');
      dt.setData('text/plain', 'Pasted bold plain\nPasted item');
      NE.quill.root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await wait(50);
    const all = await ops();
    const pasted = all.filter(o => typeof o.insert === 'string' && /Pasted/.test(o.insert));
    assert.ok(pasted.some(o => o.attributes && o.attributes.bold), 'bold kept');
    assert.ok(pasted.every(o => !o.attributes || (!o.attributes.color && !o.attributes.background && !o.attributes.size)), 'colours dropped');
    assert.deepStrictEqual(lineAttrs(all, 'Pasted item'), { list: 'bullet' }, JSON.stringify(all.slice(-6)));
    await page.click('.ntitle');
    await wait(900);
    await page.fill('#search', 'about access');
    await wait(250);
    assert.ok(await page.locator('.nmini:has-text("Rollout plan")').count(), 'note found by its text');
    await page.fill('#search', 'insert');
    await wait(250);
    assert.strictEqual(await page.locator('.nmini').count(), 0, 'stored format is not searchable text');
    await page.keyboard.press('Escape');
  });

  await step('Resize the editor from its corner, the list with the splitter; hide the list; focus mode', async () => {
    await page.click('.srow[data-id="demop1"]');
    await page.click('[data-act="tab"][data-v="notes"]');
    await page.click('.nitem:has-text("Rollout plan")');
    const box = async sel => page.locator(sel).first().boundingBox();
    const before = await box('.ne');
    const g = await box('.ne-grip');
    await page.mouse.move(g.x + 9, g.y + 9);
    await page.mouse.down();
    await page.mouse.move(g.x + 9 - 250, g.y + 9 + 200, { steps: 5 });
    await page.mouse.up();
    const after = await box('.ne');
    assert.ok(Math.abs(after.width - (before.width - 250)) < 3, `width ${before.width} → ${after.width}`);
    assert.ok(after.height > before.height + 150, 'taller');
    assert.ok(await state(() => prefs.noteW > 0 && prefs.noteH > 0));
    const sp = await box('.nsplit'), listW = (await box('.nlist-card')).width;
    await page.mouse.move(sp.x + 7, sp.y + 40);
    await page.mouse.down();
    await page.mouse.move(sp.x + 7 + 80, sp.y + 40, { steps: 4 });
    await page.mouse.up();
    assert.ok(Math.abs((await box('.nlist-card')).width - (listW + 80)) < 3, 'list wider');
    await page.dblclick('.ne-grip');
    assert.ok(await state(() => prefs.noteW === null));
    await page.click('.ne-bar [data-ne="list"]');
    assert.ok(await page.locator('.notes-wrap.list-hidden').count(), 'list hidden');
    const wide = (await box('.ne')).width;
    assert.ok(wide > after.width + 300, 'editor gets the space');
    await page.click('.ne-bar [data-ne="list"]');
    await page.click('.ne .ql-editor');
    await page.keyboard.press('Control+.');
    assert.ok(await state(() => document.body.classList.contains('note-focus')));
    assert.strictEqual(await page.locator('.topbar').isVisible(), false);
    await page.keyboard.press('Escape');
    assert.ok(await state(() => !document.body.classList.contains('note-focus')));
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
    await page.fill('#search', 'rollout');
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
    for (const sel of ['.nav[data-v="home"]', '.srow[data-id="demop1"]', '[data-act="tab"][data-v="notes"]']) {
      await page.evaluate(s => document.querySelector(s).click(), sel);
      await wait(150);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.getElementById('main').scrollWidth]);
      assert.ok(w[0] <= 390 && w[1] <= 390, 'width ' + w);
    }
  });

  await step('If the editor library cannot load, notes stay readable', async () => {
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    p2.on('pageerror', e => errs.push(e.message));
    await p2.addInitScript(() => { Object.defineProperty(window, 'Quill', { value: undefined, writable: false, configurable: false }); });
    await p2.goto(LOCAL);
    await p2.waitForSelector('.nav');
    await p2.evaluate(() => { openProject('demop1', 'notes'); S.noteId = 'demok2'; renderNow(); });
    await p2.waitForSelector('.ne-warn');
    assert.match(await p2.textContent('.ne-ro'), /one named owner/);
    assert.ok(await p2.locator('.ne-ro li, .ne-ro .ro-li').count() >= 3);
    assert.deepStrictEqual(errs, []);
    await p2.close();
  });

  await step('From the CDN: the app opens at once, the editor appears when it arrives, or notes go read-only', async () => {
    const run = async (handler, expect) => {
      const p3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errs = [];
      p3.on('pageerror', e => errs.push(e.message));
      await p3.route('https://cdn.jsdelivr.net/**', handler);
      const t0 = Date.now();
      await p3.goto(CDN_PAGE, { waitUntil: 'domcontentloaded' });
      await p3.waitForSelector('.prow');
      assert.ok(Date.now() - t0 < 1500, 'the app did not wait for the editor');
      await p3.evaluate(() => { openProject('demop1', 'notes'); S.noteId = 'demok2'; renderNow(); });
      await expect(p3);
      assert.deepStrictEqual(errs, []);
      await p3.close();
    };
    // Slow CDN: read-only "Loading the editor…" first, then the real editor.
    await run(route => setTimeout(() => route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: QUILL_JS }), 1500), async p3 => {
      await p3.waitForSelector('.ne-loading');
      await p3.waitForSelector('.ne .ql-editor h3', { timeout: 5000 });
      assert.strictEqual(await p3.locator('.ne-loading').count(), 0);
    });
    // Blocked CDN: a clear warning and the note still readable.
    await run(route => route.abort(), async p3 => {
      await p3.waitForSelector('.ne-warn');
      assert.match(await p3.textContent('.ne-ro'), /one named owner/);
    });
    // A tampered file fails the integrity check and is not run.
    await run(route => route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: QUILL_JS + '\n;window.HACKED = 1;' }), async p3 => {
      await p3.waitForSelector('.ne-warn');
      assert.strictEqual(await p3.evaluate(() => window.HACKED), undefined);
    });
  });

  assert.deepStrictEqual(errors, [], 'no script errors');
  console.log(`\n${passed} UI checks passed`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
