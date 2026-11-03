// Runs Code.gs + Projects.gs in Node against in-memory fakes of the Apps Script services.
// Usage: node tasks-app/test/server.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

/* ---------- Fakes ---------- */
function makeSheet(name) {
  const sh = { name, data: [], maxRows: 1000, maxCols: 26, frozen: 0 };
  const cell = (r, c) => (sh.data[r - 1] && sh.data[r - 1][c - 1] !== undefined ? sh.data[r - 1][c - 1] : '');
  const set = (r, c, v) => { while (sh.data.length < r) sh.data.push([]); sh.data[r - 1][c - 1] = v; };
  const range = (r, c, nr, nc) => {
    const rg = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      getDisplayValues: () => rg.getValues().map(row => row.map(v => (v instanceof Date ? v.toISOString() : String(v)))),
      setValues: vals => { assert.strictEqual(vals.length, nr, 'row count'); vals.forEach((row, i) => { assert.strictEqual(row.length, nc, 'col count'); row.forEach((v, j) => set(r + i, c + j, v)); }); return rg; },
      setNumberFormat: () => rg, setFontWeight: () => rg, setBackground: () => rg, setFontColor: () => rg,
    };
    return rg;
  };
  Object.assign(sh, {
    getName: () => name,
    getMaxRows: () => sh.maxRows, getMaxColumns: () => sh.maxCols,
    insertRowsAfter: (a, n) => { sh.maxRows += n; },
    insertColumnsAfter: (a, n) => { sh.maxCols += n; },
    getLastRow: () => { for (let i = sh.data.length; i > 0; i--) if ((sh.data[i - 1] || []).some(v => v !== '' && v != null)) return i; return 0; },
    getRange: (a, b, c, d) => {
      if (typeof a === 'string') return range(1, 1, 1, 1);
      return range(a, b, c || 1, d || 1);
    },
    getRangeList: () => ({ setNumberFormat: () => {} }),
    setFrozenRows: n => { sh.frozen = n; }, setColumnWidth: () => {},
    deleteRow: r => { sh.data.splice(r - 1, 1); sh.maxRows--; },
    deleteRows: (r, n) => { sh.data.splice(r - 1, n); sh.maxRows -= n; },
  });
  return sh;
}

function makeEnv() {
  const sheets = {};
  const props = { doc: {}, user: {} };
  const store = o => ({ getProperty: k => (k in o ? o[k] : null), setProperty: (k, v) => { o[k] = String(v); } });
  const events = {};
  let evSeq = 0;
  const mkEvent = (title, start, allDay, opts) => {
    const id = 'ev' + (++evSeq) + '@google.com';
    const ev = { id, title, start, allDay, desc: (opts || {}).description || '', tags: {}, deleted: false };
    const api = {
      getId: () => id, getTitle: () => ev.title, setTitle: t => { ev.title = t; },
      getDescription: () => ev.desc, setDescription: d => { ev.desc = d; },
      setTime: (s) => { ev.start = s; ev.allDay = false; }, setAllDayDate: d => { ev.start = d; ev.allDay = true; },
      getAllDayStartDate: () => ev.start, setTag: (k, v) => { ev.tags[k] = v; }, getTag: k => ev.tags[k] || null,
      addPopupReminder: () => {}, setColor: () => {}, deleteEvent: () => { ev.deleted = true; delete events[id]; },
      _ev: ev,
    };
    events[id] = api;
    return api;
  };
  const cal = {
    createEvent: (t, s, e, o) => mkEvent(t, s, false, o),
    createAllDayEvent: (t, d, o) => mkEvent(t, d, true, o),
    getEventById: id => events[id] || null, setColor: () => {},
  };
  const mail = [];
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSpreadsheetTimeZone: () => 'UTC', getUrl: () => 'https://docs.google.com/spreadsheets/d/x', toast: () => {},
  };
  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, Set, Map, Error, isNaN, isFinite, RegExp, Promise,
    SpreadsheetApp: { getActive: () => ss, openById: () => ss },
    PropertiesService: { getDocumentProperties: () => store(props.doc), getScriptProperties: () => store(props.doc), getUserProperties: () => store(props.user) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'me@example.com' }), getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }), getScriptTimeZone: () => 'UTC' },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => (fmt === 'HH:mm' ? d.toISOString().slice(11, 16) : fmt === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toDateString()),
      base64Encode: b => Buffer.from(b).toString('base64'),
      computeDigest: (alg, s) => [...crypto.createHash('md5').update(s).digest()],
      DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
    },
    CalendarApp: { getCalendarsByName: () => [cal], createCalendar: () => cal, Color: { BLUE: 'blue' }, EventColor: new Proxy({}, { get: (_, k) => String(k) }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }) }) }), getService: () => ({ getUrl: () => '' }), deleteTrigger: () => {} },
    MailApp: { sendEmail: m => mail.push(m) },
    HtmlService: {},
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'Projects.gs'), 'utf8') +
    '\n;globalThis.__reset = () => { Object.keys(_cache).forEach(k => delete _cache[k]); };', ctx);
  // Every google.script.run call is a fresh execution, so reset the per-run cache around each call.
  const call = (fn, ...args) => { ctx.__reset(); const r = ctx[fn](...args); ctx.__reset(); return JSON.parse(JSON.stringify(r)); };
  return { ctx, sheets, props, events, mail, ss, call };
}

/* ---------- A sheet in the old (v2) format, like the one in the screenshot ---------- */
const V2 = ['ID', 'Task', 'Description', 'Due Date', 'Status', 'Priority', 'Event ID', 'Last Synced', 'List', 'Archived',
  'Starred', 'Parent', 'Order', 'Repeat', 'Due Time', 'Created', 'Completed'];
function seedV2(env) {
  const sh = env.ss.insertSheet('Tasks');
  const d = s => new Date(s + 'T12:00:00Z');
  const row = o => V2.map(h => (h in o ? o[h] : ''));
  sh.data.push(V2.slice());
  sh.data.push(row({ ID: 'tGen0001', Task: 'TV automation', Description: 'Read the file in downloads', 'Due Date': d('2026-10-12'), Status: 'Blocked', Priority: 'Medium', List: 'General', Order: 1, Created: d('2026-10-01') }));
  sh.data.push(row({ ID: 'tQrq0001', Task: 'Set up board', Status: 'Done', Priority: 'Medium', List: 'Project - QRQC', Archived: 'Completed', Order: 1, Created: d('2026-09-10'), Completed: d('2026-09-20') }));
  sh.data.push(row({ ID: 'tExc0001', Task: 'Digitize Excel workflow', 'Due Date': d('2026-10-26'), Status: 'Not started', Priority: 'High', List: 'Project - Excel Digitization', Order: 1, Created: d('2026-10-05') }));
  sh.data.push(row({ ID: '', Task: 'Row typed straight into the sheet', Status: 'Not started', List: 'General' }));
  env.props.doc.schemaVersion = '2';
  env.props.doc.lists_v2 = JSON.stringify([{ name: 'General', color: 'GRAY' }, { name: 'Project - QRQC', color: 'GRAY' },
    { name: 'Project - OJT', color: 'ORANGE' }, { name: 'Project - Excel Digitization', color: 'GRAY' }]);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; }
}

const env = makeEnv();
seedV2(env);
const { call, sheets, props, events } = env;
const ids = { n: 0 };
const nid = p => p + 'test' + String(++ids.n).padStart(4, '0');

console.log('Migration');
let data;
test('getAll upgrades the sheet and turns "Project - " lists into projects', () => {
  data = call('getAll');
  assert.strictEqual(props.doc.schemaVersion, '3');
  assert.strictEqual(props.doc.projectsMigrated, '1');
  assert.deepStrictEqual(sheets.Tasks.data[0].slice(17), ['Milestone', 'Plan Date', 'Size', 'Blocked By', 'Block Reason', 'Blocked Since', 'Waiting On', 'Waiting Since', 'Block Log', 'Updated']);
  assert.deepStrictEqual(data.projects.map(p => p.name).sort(), ['Excel Digitization', 'OJT', 'QRQC']);
  assert.deepStrictEqual(data.lists.map(l => l.name), ['General']);
  assert.strictEqual(data.tasks.find(t => t.id === 'tExc0001').list, 'Excel Digitization');
  assert.strictEqual(data.tasks.find(t => t.id === 'tQrq0001').list, 'QRQC');
  assert.strictEqual(data.projects.find(p => p.name === 'OJT').color, 'ORANGE');
  assert.strictEqual(data.projects.find(p => p.name === 'Excel Digitization').start, '2026-10-05');
  assert.ok(data.tasks.every(t => t.id), 'rows typed into the sheet get an id');
  assert.ok(sheets.Projects && sheets.Milestones && sheets.Notes && sheets.Updates);
});
test('a second getAll changes nothing', () => {
  const again = call('getAll');
  assert.strictEqual(again.projects.length, 3);
  assert.strictEqual(again.tasks.length, data.tasks.length);
});
test('old blocked task keeps status Blocked with no plan', () => {
  const t = data.tasks.find(x => x.id === 'tGen0001');
  assert.strictEqual(t.status, 'Blocked');
  assert.deepStrictEqual(t.blockedBy, []);
  assert.strictEqual(t.blockReason, '');
});

const excel = () => call('getAll').projects.find(p => p.name === 'Excel Digitization');
const getTask = id => call('getAll').tasks.find(t => t.id === id);

console.log('Projects, milestones, tasks');
const P = excel().id;
const M1 = nid('m'), M2 = nid('m');
test('saveProject updates goal, target and priority', () => {
  const r = call('saveProject', { id: P, goal: 'All reports in Sheets', target: '2026-12-15', priority: 1 });
  assert.strictEqual(r.projects[0].goal, 'All reports in Sheets');
  assert.strictEqual(r.projects[0].priority, 1);
});
test('a project cannot take a list name', () => {
  assert.throws(() => call('saveProject', { id: nid('p'), create: true, name: 'general' }), /already has that name/);
});
test('a list cannot take a project name', () => {
  assert.throws(() => call('createList', 'QRQC', 'BLUE'), /project already has that name/);
});
test('saveMilestone creates milestones', () => {
  call('saveMilestone', { id: M1, create: true, projectId: P, name: 'Sheets built', target: '2026-11-20' });
  call('saveMilestone', { id: M2, create: true, projectId: P, name: 'Team migrated', target: '2026-12-10' });
  assert.strictEqual(call('getAll').milestones.filter(m => m.projectId === P).length, 2);
});
const T1 = nid('t'), T2 = nid('t');
test('saveTask stores milestone, plan date and size', () => {
  call('saveTask', { id: T1, create: true, title: 'Build tracker', list: 'Excel Digitization', milestone: M1, plan: '2026-11-05', size: 3 });
  call('saveTask', { id: 'tExc0001', milestone: M1 });
  const t = getTask(T1);
  assert.strictEqual(t.milestone, M1);
  assert.strictEqual(t.plan, '2026-11-05');
  assert.strictEqual(t.size, 3);
});
test('moving a task to another list clears its milestone', () => {
  call('saveTask', { id: T2, create: true, title: 'Temp', list: 'Excel Digitization', milestone: M2 });
  call('saveTask', { id: T2, list: 'General' });
  assert.strictEqual(getTask(T2).milestone, '');
});
test('completing the last task of a milestone marks it reached; restoring reopens it', () => {
  call('completeTask', 'tExc0001', null);
  assert.strictEqual(call('getAll').milestones.find(m => m.id === M1).done, '');
  const r = call('completeTask', T1, null);
  assert.ok(r.milestones && r.milestones.some(m => m.id === M1 && m.done), 'milestone returned as reached');
  const r2 = call('restoreTask', T1);
  assert.ok(r2.milestones.some(m => m.id === M1 && m.done === ''));
});

console.log('Blocking');
const B = nid('t'), U1 = nid('t'), U2 = nid('t');
test('blockTask needs a reason', () => {
  call('saveTask', { id: B, create: true, title: 'Build QA log', list: 'Excel Digitization', milestone: M1 });
  assert.throws(() => call('blockTask', B, { reason: '  ' }), /why/);
});
test('blockTask creates the unblocking tasks in the same project and milestone', () => {
  const r = call('blockTask', B, { reason: 'No Shared Drive access', waiting: 'IT helpdesk', create: [{ id: U1, title: 'Request Shared Drive' }] });
  const t = r.tasks.find(x => x.id === B), u = r.tasks.find(x => x.id === U1);
  assert.strictEqual(t.status, 'Blocked');
  assert.strictEqual(t.blockReason, 'No Shared Drive access');
  assert.deepStrictEqual(t.blockedBy, [U1]);
  assert.strictEqual(t.waiting, 'IT helpdesk');
  assert.ok(t.blockedSince && t.waitingSince);
  assert.strictEqual(u.list, 'Excel Digitization');
  assert.strictEqual(u.milestone, M1);
  assert.ok(u.order < t.order, 'unblocking task sorts before the blocked one');
});
test('finishing the unblocking task does not unblock while still waiting on a person', () => {
  call('completeTask', U1, null);
  assert.strictEqual(getTask(B).status, 'Blocked');
});
test('"It arrived" clears the wait and unblocks, keeping a history entry', () => {
  const r = call('clearWaiting', 'task', B);
  const t = r.tasks[0];
  assert.strictEqual(t.status, 'Not started');
  assert.strictEqual(t.blockReason, '');
  assert.strictEqual(t.blockLog.length, 1);
  assert.strictEqual(t.blockLog[0].reason, 'No Shared Drive access');
  assert.match(t.blockLog[0].how, /IT helpdesk came through/);
});
test('with only tasks as the plan, finishing them unblocks automatically', () => {
  call('blockTask', B, { reason: 'Need sample files', create: [{ id: U2, title: 'Collect sample files' }] });
  const r = call('completeTask', U2, null);
  assert.ok(r.tasks.some(t => t.id === B && t.status === 'Not started'), 'unblocked task is returned');
});
test('blocking on an existing task, then deleting that task, unblocks', () => {
  const X = nid('t');
  call('saveTask', { id: X, create: true, title: 'Ask Finance', list: 'Excel Digitization' });
  call('blockTask', B, { reason: 'Finance format unknown', blockers: [X] });
  call('deleteTask', X);
  assert.strictEqual(getTask(B).status, 'Not started');
});
test('blockers that would make a loop are dropped', () => {
  const A = nid('t'), Z = nid('t');
  call('saveTask', { id: A, create: true, title: 'A', list: 'General' });
  call('saveTask', { id: Z, create: true, title: 'Z', list: 'General' });
  call('blockTask', A, { reason: 'needs Z', blockers: [Z] });
  const r = call('blockTask', Z, { reason: 'needs A', blockers: [A] });
  assert.deepStrictEqual(r.tasks[0].blockedBy, []);
});
test('setting another status by hand unblocks and logs it', () => {
  const t0 = data.tasks.find(x => x.id === 'tGen0001');
  call('blockTask', t0.id, { reason: 'Waiting for file' });
  const r = call('saveTask', { id: t0.id, status: 'In progress' });
  assert.strictEqual(r.tasks[0].status, 'In progress');
  assert.strictEqual(r.tasks[0].blockLog.slice(-1)[0].how, 'Unblocked by hand');
});
test('completing a blocked task moves its block into history', () => {
  const Q = nid('t');
  call('saveTask', { id: Q, create: true, title: 'Q', list: 'General' });
  call('blockTask', Q, { reason: 'r' });
  const r = call('completeTask', Q, null);
  assert.strictEqual(r.tasks[0].blockReason, '');
  assert.strictEqual(r.tasks[0].blockLog[0].how, 'Finished while blocked');
});

console.log('Blocked projects');
const OJT = () => call('getAll').projects.find(p => p.name === 'OJT');
const PU = nid('t');
test('blockProject sets status, reason and creates high-priority unblocking tasks', () => {
  const r = call('blockProject', OJT().id, { reason: 'HR has not approved the budget', create: [{ id: PU, title: 'Send budget to HR' }] });
  assert.strictEqual(r.projects[0].status, 'blocked');
  assert.deepStrictEqual(r.projects[0].blockedBy, [PU]);
  const u = r.tasks.find(t => t.id === PU);
  assert.strictEqual(u.list, 'OJT');
  assert.strictEqual(u.priority, 'High');
});
test('saveProject cannot set "blocked" directly', () => {
  const r = call('saveProject', { id: excel().id, status: 'blocked' });
  assert.strictEqual(r.projects[0].status, 'active');
});
test('finishing the unblocking task reactivates the project', () => {
  const r = call('completeTask', PU, null);
  assert.ok(r.projects.some(p => p.name === 'OJT' && p.status === 'active'));
  assert.strictEqual(OJT().blockLog.length, 1);
});
test('a project waiting on a person unblocks on "It arrived"', () => {
  call('blockProject', OJT().id, { reason: 'Need trainer list', waiting: 'Supervisors' });
  assert.ok(OJT().waitingSince);
  call('followUp', 'project', OJT().id);
  const r = call('clearWaiting', 'project', OJT().id);
  assert.strictEqual(r.projects[0].status, 'active');
});

console.log('Notes and updates');
const N1 = nid('n');
test('saveNote keeps type, body, pin and made-task links', () => {
  call('saveNote', { id: N1, create: true, projectId: P, type: 'meeting', title: 'Kickoff', body: 'Notes\n[ ] Ask IT', pinned: true });
  const r = call('saveNote', { id: N1, made: { 1: U1, evil: 'x' } });
  assert.deepStrictEqual(r.notes[0].made, { 1: U1 });
  assert.strictEqual(call('getAll').notes.find(n => n.id === N1).pinned, true);
});
test('postUpdate requires text and a health', () => {
  assert.throws(() => call('postUpdate', { id: nid('u'), projectId: P, health: 'green', text: '' }), /sentence/);
  assert.throws(() => call('postUpdate', { id: nid('u'), projectId: P, health: 'purple', text: 'x' }), /health/);
  const r = call('postUpdate', { id: nid('u'), projectId: P, health: 'amber', text: 'IT access is slow.', progress: 40 });
  assert.strictEqual(r.updates[0].progress, 40);
});

console.log('Calendar');
test('auto-sync: date-only project tasks get no event, timed ones do, list tasks do', () => {
  call('saveSettings', { autoSync: true });
  const a = nid('t'), b = nid('t'), c = nid('t');
  call('saveTask', { id: a, create: true, title: 'Date only', list: 'Excel Digitization', due: '2026-11-25' });
  call('saveTask', { id: b, create: true, title: 'Timed', list: 'Excel Digitization', due: '2026-11-25', time: '10:00' });
  call('saveTask', { id: c, create: true, title: 'List task', list: 'General', due: '2026-11-25' });
  const all = call('getAll').tasks;
  assert.strictEqual(all.find(t => t.id === a).synced, false);
  assert.strictEqual(all.find(t => t.id === b).synced, true);
  assert.strictEqual(all.find(t => t.id === c).synced, true);
});
test('syncToCalendar adds milestone events and skips reached ones', () => {
  const r = call('syncToCalendar');
  assert.match(r.message, /Created/);
  const ms = call('getAll').milestones;
  assert.ok(ms.find(m => m.id === M2).eventId, 'open milestone has an event');
  assert.ok(Object.values(events).some(e => e.getTitle() === '◆ [Excel Digitization] Team migrated'));
  const again = call('syncToCalendar');
  assert.match(again.message, /Created 0 · Updated 0/);
});
test('pausing a project removes its milestone events', () => {
  call('saveProject', { id: P, status: 'paused' });
  assert.strictEqual(call('getAll').milestones.find(m => m.id === M2).eventId, '');
  call('saveProject', { id: P, status: 'active' });
});

console.log('Lists, deletes, digest');
test('convertListToProject keeps tasks and removes the list', () => {
  call('createList', 'Home reno', 'GREEN');
  const t = nid('t');
  call('saveTask', { id: t, create: true, title: 'Pick tiles', list: 'Home reno' });
  const r = call('convertListToProject', 'Home reno', nid('p'));
  assert.strictEqual(r.projects[0].color, 'GREEN');
  assert.ok(!r.lists.some(l => l.name === 'Home reno'));
  assert.strictEqual(getTask(t).list, 'Home reno');
});
test('renaming a project renames its tasks', () => {
  const p = call('getAll').projects.find(x => x.name === 'Home reno');
  call('saveProject', { id: p.id, name: 'Kitchen' });
  assert.ok(call('getAll').tasks.some(t => t.list === 'Kitchen' && t.title === 'Pick tiles'));
});
test('deleteMilestone clears it from tasks', () => {
  const r = call('deleteMilestone', M2);
  assert.deepStrictEqual(r.gone.milestones, [M2]);
  assert.ok(call('getAll').tasks.every(t => t.milestone !== M2));
});
test('deleteProject sends its tasks to Trash and removes its records', () => {
  const p = call('getAll').projects.find(x => x.name === 'Kitchen');
  const r = call('deleteProject', p.id);
  assert.ok(r.tasks.every(t => t.archType === 'Deleted'));
  assert.ok(!call('getAll').projects.some(x => x.name === 'Kitchen'));
});
test('sendDigest includes projects needing attention', () => {
  call('blockProject', OJT().id, { reason: 'Room not booked' });
  const msg = call('sendDigest', null);
  assert.match(msg, /Digest sent/);
  assert.match(env.mail.slice(-1)[0].htmlBody, /Blocked: Room not booked/);
});
test('emptyTrash purges deleted tasks', () => {
  const r = call('emptyTrash');
  assert.ok(r.removed.length > 0);
});

console.log(`\n${passed} server tests passed`);
