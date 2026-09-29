/**
 * Actions.gs – ⑥ Konečné akce (definitive actions), notes / review dates and "Moje akce".
 *
 * Status: OPENED → CLOSED (a done date closes the action) · REMOVED (never deleted).
 * planned_first keeps the first planned date; every later change is in AUDIT_LOG.
 */

/**
 * Creates or updates a definitive action.
 * @param {{id?:string, qrap_id?:string, text:string, root_step:string, pilot_email:string,
 *          planned:string, done:string, evidence_url:string}} p
 * @return {{ok, action:Object, status:string}}
 */
function apiSaveDefAction(p) {
  return apiRun_(() => saveDefAction_(p || {}), true);
}

function saveDefAction_(p) {
  const u = currentUser_();
  const a = p.id ? dbFirst_('DEF_ACTION', r => r.id === p.id) : null;
  if (p.id && !a) fail_('E_NOT_FOUND', { id: p.id });
  const q = getQrapRow_(a ? a.qrap_id : p.qrap_id);
  const pilots = childrenOf_('PILOT', q.qrap_id);
  const full = canAnalyze_(u, q, pilots); // may change every field
  if (a ? !canEditAction_(u, q, a, pilots) : !full) fail_(isLocked_(q, 'ANALYSIS') ? 'E_LOCKED' : 'E_FORBIDDEN');
  if (a && a.status === 'REMOVED') fail_('E_ACTION_REMOVED');

  // A field that is not sent keeps its current value (e.g. "Hotovo" in Moje akce sends only the done date).
  const pick = (k, clean) => (p[k] === undefined && a ? a[k] : clean(p[k]));
  const v = {
    text: pick('text', x => str_(x, 1000)),
    root_step: pick('root_step', up_),
    pilot_email: pick('pilot_email', normEmail_),
    planned: pick('planned', dateStr_),
    done: pick('done', dateStr_),
    evidence_url: pick('evidence_url', x => str_(x, 500))
  };
  if (a && a.root_step === 'STD') v.root_step = 'STD';
  if (!full) { // the action owner only closes the action and adds evidence
    ['text', 'root_step', 'pilot_email', 'planned'].forEach(k => { v[k] = a[k]; });
  }
  const errors = validateDefAction_(q, a, v);
  if (errors.length) failMany_(errors);

  v.status = v.done ? 'CLOSED' : 'OPENED';
  let action = a;
  if (!a) {
    action = dbInsert_('DEF_ACTION', Object.assign({ id: newId_('DA'), qrap_id: q.qrap_id, planned_first: v.planned }, v));
    mailE5b_(q, action);
  } else {
    const pilotChanged = normEmail_(a.pilot_email) !== v.pilot_email;
    dbUpdate_('DEF_ACTION', a, v);
    if (pilotChanged) mailE5b_(q, a);
  }
  recomputeAnalysisStatus_(q);
  return { action: clientRow_(action), status: q.status };
}

/** Rules of one action row. */
function validateDefAction_(q, a, v) {
  const errors = [];
  const today = todayStr_();
  if (!v.text) errors.push({ code: 'E_REQUIRED', field: 'action_text' });
  if (v.root_step !== 'STD') {
    const m = v.root_step.match(/^([ON])([1-5])$/);
    const chain = m && m[1] === 'O' ? 'OCCURRENCE' : 'NON_DETECTION';
    const ok = m && childrenOf_('WHY_STEP', q.qrap_id).some(w => w.chain === chain && Number(w.step) === Number(m[2]) && w.text);
    if (!ok) errors.push({ code: 'E_ROOT_STEP', field: 'root_step' });
  }
  const person = personByEmail_(v.pilot_email);
  if (!person) errors.push({ code: 'E_PILOT_UNKNOWN', field: 'pilot_email', email: v.pilot_email });
  if (!v.planned) errors.push({ code: 'E_REQUIRED', field: 'planned' });
  else if (!a && v.planned < today) errors.push({ code: 'E_PLANNED_PAST', field: 'planned' });
  if (v.done && v.done > today) errors.push({ code: 'E_DONE_FUTURE', field: 'done' });
  if (v.evidence_url && !/^https:\/\//i.test(v.evidence_url)) errors.push({ code: 'E_URL', field: 'evidence_url' });
  return errors;
}

/** "Odebrat": status REMOVED (the row stays). */
function apiRemoveDefAction(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const a = dbFirst_('DEF_ACTION', r => r.id === p.id);
    if (!a) fail_('E_NOT_FOUND', { id: p.id });
    const q = getQrapRow_(a.qrap_id);
    if (!canAnalyze_(u, q, childrenOf_('PILOT', q.qrap_id))) fail_('E_FORBIDDEN');
    dbUpdate_('DEF_ACTION', a, { status: 'REMOVED' });
    if (a.root_step === 'STD' && q.std_update === 'ANO') {
      dbUpdate_('QRAP', q, { std_update: '', std_update_ref: '' }); // the question must be answered again
    }
    recomputeAnalysisStatus_(q);
    return { status: q.status };
  }, true);
}

/**
 * Adds a note to an action, optionally with a review date.
 * @param {{action_id:string, note:string, review_date?:string}} p
 */
function apiAddActionNote(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const a = dbFirst_('DEF_ACTION', r => r.id === p.action_id);
    if (!a) fail_('E_NOT_FOUND', { id: p.action_id });
    const q = getQrapRow_(a.qrap_id);
    if (!canNoteAction_(u, q, a, childrenOf_('PILOT', q.qrap_id))) fail_('E_FORBIDDEN');
    const note = str_(p.note, 1000);
    if (!note) failMany_([{ code: 'E_REQUIRED', field: 'note' }]);
    // qrap_id is not a column of ACTION_NOTE; it is only used to label the audit log entry.
    const row = dbInsert_('ACTION_NOTE', { id: newId_('AN'), action_id: a.id, note: note,
      review_date: dateStr_(p.review_date), review_done: false, author: u.email, at: nowIso_(), qrap_id: a.qrap_id });
    return { note: clientRow_(row) };
  }, true);
}

/** Marks a review as done (or not done). */
function apiSetReviewDone(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const n = dbFirst_('ACTION_NOTE', r => r.id === p.note_id);
    if (!n) fail_('E_NOT_FOUND', { id: p.note_id });
    const a = dbFirst_('DEF_ACTION', r => r.id === n.action_id);
    const q = getQrapRow_(a.qrap_id);
    if (!canNoteAction_(u, q, a, childrenOf_('PILOT', q.qrap_id))) fail_('E_FORBIDDEN');
    dbUpdate_('ACTION_NOTE', n, { review_done: p.done === true });
    return { note: clientRow_(n) };
  }, true);
}

/**
 * "Moje akce": the user's actions (scope mine) or the actions of the people whose N+1 the user is
 * (scope team).
 * @param {{scope:string, status:string, due:string}} f  status: OPENED|CLOSED|REMOVED|ALL; due: all|late|week
 */
function apiGetMyActions(f) {
  return apiRun_(() => {
    f = f || {};
    const u = currentUser_();
    const team = getSettings_().people.filter(p => p.n1 === u.email).map(p => p.email).filter(Boolean);
    const scope = f.scope === 'team' ? 'team' : 'mine';
    const owners = scope === 'team' ? team : [u.email];
    const today = todayStr_();
    const weekEnd = addDaysStr_(today, 7);
    const status = ['OPENED', 'CLOSED', 'REMOVED', 'ALL'].indexOf(f.status) >= 0 ? f.status : 'OPENED';
    const notes = dbGroup_('ACTION_NOTE', 'action_id');
    const qraps = dbGroup_('QRAP', 'qrap_id');
    const list = dbWhere_('DEF_ACTION', a => owners.indexOf(normEmail_(a.pilot_email)) >= 0)
      .filter(a => status === 'ALL' || a.status === status)
      .filter(a => f.due === 'late' ? isActionLate_(a, today) : f.due === 'week' ? (a.status === 'OPENED' && a.planned <= weekEnd) : true)
      .map(a => {
        const q = (qraps[a.qrap_id] || [])[0] || {};
        const pilots = q.qrap_id ? childrenOf_('PILOT', q.qrap_id) : [];
        return Object.assign(clientRow_(a), {
          pilot_name: personName_(a.pilot_email),
          late: isActionLate_(a, today),
          qrap: { id: q.qrap_id, what: truncate_(q.what, 90), status: q.status, area: q.area_code },
          canEdit: q.qrap_id ? canEditAction_(u, q, a, pilots) : false,
          canNote: q.qrap_id ? canNoteAction_(u, q, a, pilots) : false,
          notes: (notes[a.id] || []).map(clientRow_)
        });
      });
    list.sort((x, y) => (x.planned < y.planned ? -1 : 1));
    return { actions: list, hasTeam: team.length > 0, scope: scope };
  });
}
