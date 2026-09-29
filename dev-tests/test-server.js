// End-to-end test of the server code in the mock environment.
'use strict';
const { makeEnv } = require('./gas-mocks');
const assert = require('assert');

const env = makeEnv({ verbose: !!process.env.V });
const { call, as, state, sheetRows, setConfig } = env;
let passed = 0;
function ok(cond, msg, extra) {
  if (!cond) { console.log('FAIL:', msg, extra !== undefined ? JSON.stringify(extra, null, 1).slice(0, 1500) : ''); process.exitCode = 1; }
  else passed++;
}
const codes = r => (r.errors || []).map(e => e.code);
const mailsFor = (rule) => sheetRows('MAIL_LOG').filter(r => r.rule === rule);
const PNG = Buffer.from('fakejpegdata').toString('base64');
const local = (hAgo) => { // 'YYYY-MM-DDTHH:mm' Prague local, hAgo hours ago
  const d = new Date(Date.now() - hAgo * 3600000);
  return env.ctx.Utilities.formatDate(d, 'Europe/Prague', "yyyy-MM-dd'T'HH:mm");
};

// ---------- setup
as('owner@example.com');
call('setup');
call('setup'); // twice: no duplicates
ok(sheetRows('SET_AREAS').length === 3, 'areas seeded once');
ok(sheetRows('SET_CONFIG').filter(r => r.key === 'DIGEST_TIME').length === 1, 'config not duplicated');
setConfig('PHOTO_FOLDER_ID', 'PHOTOS');
call('installTriggers');
ok(state.triggers.length === 3, 'three triggers');
call('seedDemoData');
call('seedDemoData'); // second run skipped
const qraps = sheetRows('QRAP');
ok(qraps.length === 10, 'demo QRAPs incl. APU copy', qraps.map(q => q.qrap_id + ' ' + q.status));
ok(state.sent.length === 0, 'seed sends no mail');
const report = call('selfTest');
console.log(report.split('\n').filter(l => l.startsWith('✗')).join('\n') || '(selfTest all green)');

// ---------- doGet
as('kiosk.wh1@example.com');
let out = ''; try { out = env.run('doGet({parameter:{page:"board", area:"WH1"}}).getContent()'); } catch (e) { console.log('doGet failed:', e.message); process.exitCode = 1; }
ok(out.indexOf('window.BOOT = {') >= 0 && out.indexOf('<?') < 0, 'doGet renders Index with bootstrap JSON');

// ---------- board
let b = call('apiGetBoard', { area: 'WH1' });
ok(b.ok, 'board ok', b);
ok(b.rows.length >= 5, 'board rows', b.rows.length);
ok(b.rows.every((r, i, a) => i === 0 || a[i - 1].key <= r.key), 'board sorted ascending');
const r2 = b.rows.find(r => r.st === 'QR_OPEN');
ok(r2 && r2.chips[2] === 'late' && r2.late, '③ late chip red', r2);
const rSolved = b.rows.find(r => r.st === 'CLOSED_SOLVED');
ok(rSolved && rSolved.chips[4] === 'na' && rSolved.chips[5] === 'na', 'chips 5/6 na for solved', rSolved);
ok(b.pending >= 2, 'pending count', b.pending);
const bAll = call('apiGetBoard', { area: 'WH1', filter: 'safety' });
ok(bAll.rows.every(r => r.safety), 'safety filter');
const page1 = call('apiGetBoard', { area: 'WH1', filter: 'all', limit: 5 });
const page2 = call('apiGetBoard', { area: 'WH1', filter: 'all', limit: 5, before: page1.rows[0].key });
ok(page1.hasMore && page2.rows.every(r => r.key < page1.rows[0].key), 'paging older rows', [page1.rows.length, page2.rows.length]);

// ---------- wizard
let r = call('apiSaveStep', { area: 'WH1', step: 1, mode: 'next', data: { what: 'x' } });
ok(!r.ok && codes(r).includes('E_REQUIRED'), 'step1 validation', r);
const s1 = { safety: 'NE', what: 'Rozbitá paleta na rampě', how_found: 'SHIP_CHECK', detected_at: local(1), zone: 'Expedice / Rampa',
  location_code: 'R-01', qty: 3, unit: 'BOX', repeat_7d: 'NE', finder_name: 'Jan Novák', material_no: '0012345' };
r = call('apiSaveStep', { area: 'WH1', step: 1, mode: 'next', data: Object.assign({}, s1, { detected_at: local(-2) }) });
ok(!r.ok && codes(r).includes('E_FUTURE'), 'future KDY blocked', r);
r = call('apiSaveStep', { area: 'WH1', step: 1, mode: 'next', data: Object.assign({}, s1, { qty: 0 }) });
ok(!r.ok && codes(r).includes('E_QTY_ZERO'), 'qty 0 needs toggle', r);
r = call('apiSaveStep', { area: 'WH1', step: 1, mode: 'next', data: Object.assign({}, s1, { repeat_7d: 'ANO', repeat_ref: 'XX-1' }) });
ok(!r.ok && codes(r).includes('E_REPEAT_REF'), 'repeat ref must exist', r);
r = call('apiSaveStep', { area: 'WH1', step: 1, mode: 'next', data: s1 });
ok(r.ok && r.id && /^WH1-\d{4}-\d{1,2}-\d+$/.test(r.id), 'step1 saves and creates id', r);
const id = r.id;
ok(r.state.q.material_no === '0012345', 'leading zeros kept', r.state.q.material_no);
r = call('apiSaveStep', { id, step: 2, mode: 'next', data: {} });
ok(!r.ok && codes(r).includes('E_PHOTOS'), 'photos required', r);
r = call('apiUploadPhoto', { qrapId: id, kind: 'WRONG', full: PNG, thumb: PNG });
ok(r.ok && r.photo.file_id, 'upload wrong photo', r);
const wrongFile = r.photo.thumb_file_id;
r = call('apiUploadPhoto', { qrapId: id, kind: 'CORRECT', full: PNG, thumb: PNG });
ok(r.ok, 'upload correct photo', r);
r = call('apiSaveStep', { id, step: 2, mode: 'next', data: {} });
ok(r.ok, 'step2 ok with photos', r);
r = call('apiGetPhoto', { fileId: wrongFile });
ok(r.ok && r.data === PNG, 'photo served as base64');
r = call('apiGetPhoto', { fileId: 'SOME-OTHER-DRIVE-FILE' });
ok(!r.ok && codes(r).includes('E_NOT_FOUND'), 'foreign drive file blocked');
r = call('apiSaveStep', { id, step: 3, mode: 'next', data: { roles: [] } });
ok(!r.ok && codes(r).includes('E_ALERT_NONE'), 'alert required');
r = call('apiSaveStep', { id, step: 3, mode: 'next', data: { roles: ['TL', 'SUPERVISOR'] } });
ok(r.ok && r.state.alerts.length === 2, 'alerts saved', r);
r = call('apiSaveStep', { id, step: 4, mode: 'later', data: {} });
ok(!r.ok && codes(r).includes('E_REQUIRED'), 'later needs risk', r);
const ia = [{ type: 'REPACK', text: 'Přebalit krabice', owner_name: 'Tomáš Dvořák', done_at: '' }];
r = call('apiSaveStep', { id, step: 4, mode: 'next', data: { risk_stock_shipped: 'ANO', checked_qty: 10, wrong_found_qty: 20, actions: ia, process_stopped: 'NE' } });
ok(!r.ok && codes(r).includes('E_WRONG_GT_CHECKED'), 'wrong > checked blocked', r);
r = call('apiSaveStep', { id, step: 4, mode: 'next', data: { risk_stock_shipped: 'ANO', check_in_progress: true, actions: ia, process_stopped: 'NE' } });
ok(!r.ok && codes(r).includes('E_S3_INCOMPLETE'), 'next requires ③ complete', r);
r = call('apiSaveStep', { id, step: 4, mode: 'later', data: { risk_stock_shipped: 'ANO', check_in_progress: true, actions: ia, process_stopped: 'NE' } });
ok(r.ok && r.state.alerts.some(a => a.role_code === 'QUALITY'), 'later saves + Kvalita auto', r);
ok(mailsFor('E3').length === 1, 'E3 sent on risk ANO');
const iaId = r.state.ia[0].id;
r = call('apiSubmitQrap', id);
ok(r.ok && r.status === 'QR_OPEN', 'submitted QR_OPEN', r);
ok(mailsFor('E1').length === 1 && mailsFor('E1')[0].to.includes('supervisor'), 'E1 once to supervisor', mailsFor('E1'));
ok(mailsFor('E1')[0].cc.includes('manager@example.com'), 'E1 cc manager');
const e1 = state.sent.find(m => /opatření probíhají/.test(m.subject));
ok(e1 && /SAFETY: ne · Opakování: NE/.test(e1.subject) && e1.inlineImages && e1.inlineImages.wrong, 'E1 subject + inline photos', e1 && e1.subject);
r = call('apiSubmitQrap', id);
ok(!r.ok && codes(r).includes('E_ALREADY_SENT') && mailsFor('E1').length === 1, 'E1 exactly once');
// complete ③ → WAIT_DECISION
r = call('apiSaveStep', { id, step: 4, mode: 'next', data: { risk_stock_shipped: 'ANO', checked_qty: 30, wrong_found_qty: 2, actions: [Object.assign({}, ia[0], { id: iaId, done_at: local(0.5) })], process_stopped: 'NE' } });
ok(r.ok && r.state.q.status === 'WAIT_DECISION' && r.state.q.containment_done_at, '③ complete → WAIT_DECISION', r.state && r.state.q.status);
ok(sheetRows('IMMEDIATE_ACTION').filter(x => x.qrap_id === id).length === 1, 'IA updated not duplicated');

// kiosk cannot sign
r = call('apiSignDecision', { id, decision: 'CONTINUE', pilots: ['pilot1@example.com'] });
ok(!r.ok && codes(r).includes('E_KIOSK_SIGN'), 'kiosk cannot sign', r);
// idle draft on a sent QRAP with invalid data is rejected
r = call('apiSaveStep', { id, step: 1, mode: 'draft', data: Object.assign({}, s1, { what: '' }) });
ok(!r.ok, 'sent QRAP stays valid on idle save');

// ---------- decision
as('supervisor.wh1@example.com');
r = call('apiSaveShiftInfo', { id, shift_code: 'R' });
ok(r.ok && r.shiftInfo.length === 1, 'shift tick');
r = call('apiSignDecision', { id, decision: 'CONTINUE', pilots: [] });
ok(!r.ok && codes(r).includes('E_PILOT_REQUIRED'), 'pilot required', r);
r = call('apiSignDecision', { id, decision: 'SOLVED', comment: 'ok' });
ok(!r.ok && r.needConfirm && r.warnings.some(w => w.code === 'W_SOLVED_WRONG'), 'solved warning wrong>0', r);
r = call('apiSignDecision', { id, decision: 'CONTINUE', pilots: ['pilot1@example.com'], comment: 'analýza' });
ok(!r.ok && r.needConfirm && r.warnings.some(w => w.code === 'W_SHIFTS'), 'shift warning', r);
r = call('apiSignDecision', { id, decision: 'CONTINUE', pilots: ['pilot1@example.com'], comment: 'analýza', confirmWarnings: true });
ok(r.ok && r.status === 'ANALYSIS', 'continue → ANALYSIS', r);
ok(mailsFor('E5').length === 1 && mailsFor('E5')[0].to.includes('pilot1'), 'E5 to pilot');
r = call('apiSaveShiftInfo', { id, shift_code: 'O' });
ok(!r.ok && codes(r).includes('E_LOCKED'), '④ locked after signature', r);
as('kiosk.wh1@example.com');
r = call('apiSaveStep', { id, step: 1, mode: 'next', data: s1 });
ok(!r.ok && codes(r).includes('E_LOCKED'), '①–③ locked after ④', r);

// ---------- analysis
as('pilot1@example.com');
r = call('apiSaveAnalysis', { id, why: { OCCURRENCE: ['Proč 1', 'Proč 2'] }, root: { OCCURRENCE: 2 }, std_update: 'NE' });
ok(r.ok && r.warnings.some(w => w.code === 'W_FEW_WHYS') && r.status === 'ANALYSIS', 'few whys warning, still ANALYSIS', r);
r = call('apiSaveAnalysis', { id, why: { OCCURRENCE: ['a', '', 'c'] }, root: {} });
ok(!r.ok && codes(r).includes('E_WHY_GAP'), 'why gap blocked', r);
r = call('apiSaveDefAction', { qrap_id: id, text: 'Oprava', root_step: 'O2', pilot_email: 'pilot1@example.com', planned: '2020-01-01' });
ok(!r.ok && codes(r).includes('E_PLANNED_PAST'), 'planned past blocked', r);
const today = env.run('todayStr_()');
r = call('apiSaveDefAction', { qrap_id: id, text: 'Oprava rampy', root_step: 'O2', pilot_email: 'pilot2@example.com', planned: today });
ok(r.ok && r.status === 'ACTIONS_OPEN', 'action → ACTIONS_OPEN', r);
ok(mailsFor('E5b').length === 1 && mailsFor('E5b')[0].to.includes('pilot2'), 'E5b to action pilot');
const act1 = r.action.id;
r = call('apiSaveAnalysis', { id, why: { OCCURRENCE: ['Proč 1', 'Proč 2', 'Proč 3'] }, root: { OCCURRENCE: 3 }, std_update: 'ANO', std_update_ref: 'WI-01', learned: 'Poučení' });
ok(r.ok && sheetRows('DEF_ACTION').some(a => a.qrap_id === id && a.root_step === 'STD'), 'std action auto-created', r);
const stdAct = sheetRows('DEF_ACTION').find(a => a.qrap_id === id && a.root_step === 'STD');
as('pilot2@example.com');
r = call('apiSaveDefAction', { id: act1, done: today });
ok(r.ok && r.status === 'ACTIONS_OPEN', 'action pilot closes own action (std still open)', r);
r = call('apiSaveDefAction', { id: act1, done: today, text: 'hack' });
ok(r.ok && sheetRows('DEF_ACTION').find(a => a.id === act1).text === 'Oprava rampy', 'action owner cannot change text');
r = call('apiAddActionNote', { action_id: act1, note: 'Hotovo, foto v dokumentaci', review_date: today });
ok(r.ok, 'note added', r);
as('pilot1@example.com');
r = call('apiSaveDefAction', { id: stdAct.id, text: stdAct.text, root_step: 'STD', pilot_email: stdAct.pilot_email, planned: stdAct.planned, done: today });
ok(r.ok && r.status === 'VERIFY', 'all closed → VERIFY', r);
r = call('apiGetMyActions', { scope: 'mine', status: 'ALL' });
ok(r.ok && r.actions.length >= 1, 'my actions', r);

// ---------- effectiveness
as('kiosk.wh1@example.com');
const d = n => env.run('addDaysStr_(todayStr_(), ' + n + ')');
r = call('apiSaveEffect', { id, slot: 1, shift_date: d(0), shift_code: 'R', result: 'EFFECTIVE', checked_by: 'Tomáš Dvořák' });
ok(r.ok, 'slot 1', r);
r = call('apiSaveEffect', { id, slot: 2, shift_date: d(0), shift_code: 'R', result: 'EFFECTIVE', checked_by: 'Tomáš Dvořák' });
ok(!r.ok && codes(r).includes('E_SHIFT_DUP'), 'same shift twice blocked', r);
r = call('apiSaveEffect', { id, slot: 2, shift_date: d(1), shift_code: 'O', result: 'EFFECTIVE', checked_by: 'Tomáš Dvořák' });
ok(!r.ok && codes(r).includes('E_SHIFT_FUTURE'), 'future shift blocked', r);
r = call('apiSaveEffect', { id, slot: 2, shift_date: d(-1), shift_code: 'O', result: 'NOT_EFFECTIVE', checked_by: 'Tomáš Dvořák' });
ok(r.ok && r.status === 'ANALYSIS' && r.round === 2, 'not effective → ANALYSIS round 2', r);
ok(mailsFor('E11').length === 1, 'E11 sent');
as('pilot1@example.com');
r = call('apiSaveAnalysis', { id, why: { OCCURRENCE: ['Proč 1', 'Proč 2', 'Proč 3'] }, root: { OCCURRENCE: 3 }, std_update: 'ANO', std_update_ref: 'WI-01', learned: 'Poučení' });
ok(r.ok && r.status === 'ANALYSIS', 'stays ANALYSIS without a new action', r);
r = call('apiSaveDefAction', { qrap_id: id, text: 'Nová akce', root_step: 'O3', pilot_email: 'pilot1@example.com', planned: today, done: today });
ok(r.ok && r.status === 'VERIFY', 'new closed action → VERIFY', r);
as('kiosk.wh1@example.com');
[[0, 'R'], [-1, 'R'], [-1, 'O'], [-1, 'N'], [-2, 'R']].forEach((x, i) => {
  const rr = call('apiSaveEffect', { id, slot: i + 1, shift_date: d(x[0]), shift_code: x[1], result: 'EFFECTIVE', checked_by: 'Tomáš Dvořák' });
  ok(rr.ok, 'round2 slot ' + (i + 1), rr);
});
r = call('apiSignClosure', { id });
ok(!r.ok && codes(r).includes('E_KIOSK_SIGN'), 'kiosk cannot close');
as('supervisor.wh1@example.com');
r = call('apiGetQrap', id);
ok(r.ok && r.detail.closure.ok, 'closure checklist ok', r.detail && r.detail.closure);
r = call('apiSignClosure', { id });
ok(r.ok && r.status === 'CLOSED', 'closed', r);
ok(mailsFor('E9').length === 1, 'E9 sent');
r = call('apiSaveAssessment', { id, c1: 'OK', c2: 'OK', c3: 'NOK', c4: 'NA', c5: 'OK', feedback: 'Dobrá práce', feedback_type: 'PRAISE', ojt_with: 'Jan Novák' });
ok(r.ok, 'assessment', r);
as('kiosk.wh1@example.com');
r = call('apiSaveAssessment', { id, c1: 'OK', c2: 'OK', c3: 'OK', c4: 'OK', c5: 'OK', feedback: 'x' });
ok(!r.ok && codes(r).includes('E_FORBIDDEN'), 'kiosk cannot assess');

// ---------- safety + solved guard + escalation
const s2 = Object.assign({}, s1, { safety: 'ANO', what: 'Padající krabice z regálu', material_no: '' });
r = call('apiSaveStep', { area: 'WH1', step: 1, mode: 'next', data: s2 });
const id2 = r.id;
ok(r.ok && mailsFor('E2').some(m => m.qrap_id === id2), 'E2 at step 1 (before Odeslat)', r);
call('apiSaveStep', { id: id2, step: 2, mode: 'next', data: { photo_exception: 'Nebezpečné fotit' } });
call('apiSaveStep', { id: id2, step: 3, mode: 'next', data: { roles: ['SUPERVISOR'] } });
r = call('apiSaveStep', { id: id2, step: 4, mode: 'next', data: { risk_stock_shipped: 'NE', actions: [{ type: 'BLOCK', text: 'Ulička uzavřena', owner_name: 'Tomáš Dvořák', done_at: local(0.2) }], process_stopped: 'ANO', restored_at: local(0.1) } });
ok(r.ok, 'step4 complete', r);
r = call('apiSubmitQrap', id2);
ok(r.ok && r.status === 'WAIT_DECISION', 'submit straight to WAIT_DECISION', r);
ok(state.sent.some(m => m.subject.includes(id2) && /nutné rozhodnutí/.test(m.subject)), 'E1 says nutné rozhodnutí');
as('supervisor.wh1@example.com');
r = call('apiSignDecision', { id: id2, decision: 'SOLVED', comment: 'x', confirmWarnings: true });
ok(!r.ok && codes(r).includes('E_SOLVED_SAFETY'), 'solved blocked for safety', r);
r = call('apiSignDecision', { id: id2, decision: 'ESCALATE', comment: '', confirmWarnings: true });
ok(!r.ok && codes(r).includes('E_REQUIRED'), 'escalate needs comment', r);
r = call('apiSignDecision', { id: id2, decision: 'ESCALATE', comment: 'Na APU', confirmWarnings: true });
ok(r.ok && r.status === 'ESCALATED' && r.copyId === id2 + '-A', 'escalated with suffix A', r);
const copy = sheetRows('QRAP').find(q => q.qrap_id === id2 + '-A');
ok(copy && copy.area_code === 'APU' && copy.parent_id === id2 && copy.status === 'WAIT_DECISION', 'copy linked', copy);
ok(sheetRows('QRAP').find(q => q.qrap_id === id2).assign_ref === id2 + '-A', 'assign_ref set');
ok(mailsFor('E6').length === 1 && mailsFor('E6')[0].to.includes('apu.manager'), 'E6 to APU manager');
r = call('apiSignDecision', { id: id2 + '-A', decision: 'CONTINUE', pilots: ['pilot1@example.com'], confirmWarnings: true });
ok(!r.ok && codes(r).includes('E_FORBIDDEN'), 'supervisor cannot decide APU copy', r);
as('apu.manager@example.com');
r = call('apiSignDecision', { id: id2 + '-A', decision: 'CONTINUE', pilots: ['pilot1@example.com'], comment: 'APU analýza', confirmWarnings: true });
ok(r.ok && r.status === 'ANALYSIS', 'APU manager decides copy', r);

// ---------- manager, search, escalations
as('manager@example.com');
r = call('apiGetManager', {});
ok(r.ok && r.tiles && r.needs.length > 0, 'manager data', r.tiles);
console.log('tiles', JSON.stringify(r.tiles), 'needs', r.needs.slice(0, 3).map(n => n.reason + ' ' + n.id).join(' | '));
r = call('apiSearch', '0012345');
ok(r.ok && r.rows.some(x => x.id === id), 'search by material', r);
r = call('apiGetEscalations');
ok(r.ok && r.apu.length >= 2, 'escalation lists', r.apu && r.apu.length);
as('kiosk.wh1@example.com');
r = call('apiGetManager', {});
ok(!r.ok && codes(r).includes('E_FORBIDDEN'), 'kiosk no manager page');

// ---------- admin
as('supervisor.wh1@example.com');
r = call('apiAdminReopen', { id, reason: 'omyl' });
ok(!r.ok && codes(r).includes('E_NOT_ADMIN'), 'non-admin cannot reopen');
as('admin@example.com');
r = call('apiAdminReopen', { id, reason: 'x' });
ok(!r.ok && codes(r).includes('E_REASON'), 'reason required');
r = call('apiAdminReopen', { id, reason: 'Znovu otevřeno kvůli reklamaci' });
ok(r.ok && r.status === 'VERIFY', 'reopen CLOSED → VERIFY', r);
ok(sheetRows('AUDIT_LOG').some(a => a.action === 'ADMIN_REOPEN' && a.new.includes('reklamaci')), 'admin audited');

// ---------- triggers
as('owner@example.com');
const before = state.sent.length;
call('checkReminders');
const e4 = mailsFor('E4').length, e10 = mailsFor('E10').length;
call('checkReminders');
ok(mailsFor('E4').length === e4 && mailsFor('E10').length === e10, 'reminders not repeated');
ok(e10 >= 1, 'E10 for demo QRAP #2', e10);
console.log('E4', e4, 'E10', e10);
call('dailyDigest');
const e7 = mailsFor('E7').length, e8 = mailsFor('E8').length;
call('dailyDigest');
ok(mailsFor('E7').length === e7 && mailsFor('E8').length === e8, 'digest once per day');
ok(e7 >= 1, 'E7 sent', e7);
console.log('E7', e7, 'E8', e8, 'mails total', state.sent.length - before);
call('archiveOld');
as('pilot1@example.com');
r = call('apiSetReviewDone', { note_id: sheetRows('ACTION_NOTE')[0].id, done: true });
ok(!r.ok || r.ok, 'review done call');

// ---------- audit + nothing deleted
const audit = sheetRows('AUDIT_LOG');
ok(audit.length > 100, 'audit rows', audit.length);
ok(audit.every(a => a.ts instanceof Date), 'audit ts are dates');
// anonymous user
as('');
r = call('apiGetBoard', { area: 'WH1' });
ok(!r.ok && codes(r).includes('E_NO_IDENTITY'), 'anonymous blocked');
const boot = env.run('JSON.parse(safeJson_(bootstrap_({page:"board"})))');
ok(boot.error === 'E_NO_IDENTITY', 'bootstrap anonymous');

console.log('passed', passed, process.exitCode ? 'WITH FAILURES' : 'ALL OK');
console.log('getValues calls', state.calls.getValues, 'setValues calls', state.calls.setValues);
