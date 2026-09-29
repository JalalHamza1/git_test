/**
 * Qrap.gs – loading a QRAP, the section rules, board chips, "čeká na" and the detail page data.
 */

/** Loads a QRAP row or stops with E_NOT_FOUND. */
function getQrapRow_(id) {
  const key = str_(id, 60);
  const q = key ? dbFirst_('QRAP', r => r.qrap_id === key) : null;
  if (!q) fail_('E_NOT_FOUND', { id: key });
  return q;
}

/** Child rows of one QRAP from a tab (uses the grouped memo). */
function childrenOf_(tab, qrapId) {
  return dbGroup_(tab, 'qrap_id')[qrapId] || [];
}
function activeAlerts_(id) { return childrenOf_('ALERT', id).filter(a => a.removed !== true); }
function activeIA_(id) { return childrenOf_('IMMEDIATE_ACTION', id).filter(a => a.status !== 'REMOVED'); }
function activePhotos_(id) { return childrenOf_('ATTACHMENT', id).filter(a => a.removed !== true); }
function activeActions_(id) { return childrenOf_('DEF_ACTION', id).filter(a => a.status !== 'REMOVED'); }

/** True when both photos exist or a written photo exception is given. */
function photosOk_(q) {
  const kinds = activePhotos_(q.qrap_id).map(p => p.kind);
  return (kinds.indexOf('WRONG') >= 0 && kinds.indexOf('CORRECT') >= 0) || str_(q.photo_exception).length >= 3;
}

/**
 * ③ rule: risk answered; if ANO the check data is filled and not in progress; ≥ 1 action and all
 * actions done; the process restored or not stopped.
 * @return {{complete:boolean, missing:string[]}}
 */
function section3State_(q, ia) {
  const missing = [];
  if (!q.risk_stock_shipped) missing.push('RISK');
  if (q.risk_stock_shipped === 'ANO') {
    if (q.check_in_progress === true) missing.push('CHECK_IN_PROGRESS');
    else if (q.checked_qty === '' || q.wrong_found_qty === '') missing.push('CHECK_DATA');
  }
  if (!ia.length) missing.push('NO_ACTION');
  else if (ia.some(a => !a.done_at)) missing.push('ACTION_OPEN');
  if (!q.process_stopped) missing.push('PROCESS');
  else if (q.process_stopped === 'ANO' && !q.restored_at) missing.push('NOT_RESTORED');
  return { complete: missing.length === 0, missing: missing };
}

/**
 * QR_OPEN → WAIT_DECISION when ③ becomes complete (and back if it becomes incomplete).
 * DRAFT rows are left alone: submit decides for them.
 */
function refreshContainment_(q) {
  const s3 = section3State_(q, activeIA_(q.qrap_id));
  if (q.status === ST.QR_OPEN && s3.complete) {
    dbUpdate_('QRAP', q, { status: ST.WAIT_DECISION, containment_done_at: nowIso_() });
  } else if (q.status === ST.WAIT_DECISION && !s3.complete) {
    dbUpdate_('QRAP', q, { status: ST.QR_OPEN, containment_done_at: '' });
  }
  return s3;
}

/** Current effectiveness round and its 5 slots (derived from the rows, no extra column). */
function effState_(rows) {
  const fails = rows.filter(r => r.result === 'NOT_EFFECTIVE');
  const round = fails.reduce((m, r) => Math.max(m, Number(r.round) || 1), 0) + 1;
  const current = rows.filter(r => Number(r.round) === round);
  const slots = [1, 2, 3, 4, 5].map(n => {
    const s = current.filter(r => Number(r.slot) === n);
    return s.length ? clientRow_(s[s.length - 1]) : null;
  });
  const okKeys = {};
  slots.forEach(s => { if (s && s.result === 'EFFECTIVE') okKeys[s.shift_date + '|' + s.shift_code] = true; });
  const distinctOk = Object.keys(okKeys).length;
  const reopenAt = fails.reduce((m, r) => (r.checked_at > m ? r.checked_at : m), '');
  return { round: round, slots: slots, distinctOk: distinctOk, allOk: distinctOk === 5, reopenAt: reopenAt };
}

/** An open definitive action whose planned day has passed. */
function isActionLate_(a, today) {
  return a.status === 'OPENED' && !!a.planned && a.planned < (today || todayStr_());
}

/**
 * Board chips 1–7. States: done | wait | late | todo | na.
 * @param {Object} q QRAP row
 * @param {{alerts:Array, why:Array, actions:Array, assess:Array}} c child rows (active only)
 * @param {Date} now
 * @return {string[]}
 */
function computeChips_(q, c, now) {
  const st = q.status;
  const t = now.getTime();
  const noAnalysis = st === ST.CLOSED_SOLVED || st === ST.ESCALATED;
  const inAnalysis = ANALYSIS_STATES.indexOf(st) >= 0 || st === ST.CLOSED;
  const chips = [];
  chips.push(q.s1_done_at ? 'done' : 'wait');
  chips.push(c.alerts.length ? 'done' : (q.s1_done_at ? 'wait' : 'todo'));
  if (q.containment_done_at) chips.push('done');
  else if (q.s1_done_at || st !== ST.DRAFT) {
    const det = q.detected_at ? new Date(q.detected_at).getTime() : 0;
    chips.push(det && t > det + 24 * 3600000 ? 'late' : 'wait');
  } else chips.push('todo');
  if (q.decision) chips.push('done');
  else if (st === ST.WAIT_DECISION) {
    const due = q.containment_done_at ? nextShiftStart_(new Date(q.containment_done_at)) : null;
    chips.push(due && now > due ? 'late' : 'wait');
  } else chips.push('todo');
  if (noAnalysis) chips.push('na');
  else if (inAnalysis) chips.push(c.why.some(w => w.is_root === true && w.text) ? 'done' : 'wait');
  else chips.push('todo');
  if (noAnalysis) chips.push('na');
  else if (st === ST.CLOSED) chips.push('done');
  else if (ANALYSIS_STATES.indexOf(st) >= 0) {
    const today = todayStr_(now);
    if (c.actions.some(a => isActionLate_(a, today))) chips.push('late');
    else chips.push(c.actions.length || st === ST.VERIFY ? 'wait' : 'todo');
  } else chips.push('todo');
  chips.push(c.assess.length ? 'done' : 'todo');
  return chips;
}

/** "Čeká na" code for the board (translated in the client). */
function waitingFor_(q) {
  switch (q.status) {
    case ST.DRAFT: return 'OPERATOR';
    case ST.QR_OPEN: return 'TL';
    case ST.WAIT_DECISION: return q.level && q.level !== 'AREA' ? 'APU' : 'SUPERVISOR';
    case ST.ANALYSIS:
    case ST.ACTIONS_OPEN: return 'PILOT';
    case ST.VERIFY: return 'VERIFY';
    case ST.ESCALATED: return 'APU';
    default: return '';
  }
}

/**
 * Closure checklist (VERIFY → CLOSED guards).
 * @return {{ok:boolean, items:{code:string, ok:boolean}[]}}
 */
function closureChecklist_(q) {
  const id = q.qrap_id;
  const acts = activeActions_(id);
  const eff = effState_(childrenOf_('EFFECTIVENESS', id));
  const items = [
    { code: 'C_STATUS', ok: q.status === ST.VERIFY },
    { code: 'C_ROOT', ok: childrenOf_('WHY_STEP', id).some(w => w.is_root === true && w.text) },
    { code: 'C_ACTIONS', ok: acts.length > 0 && acts.every(a => a.status === 'CLOSED') },
    { code: 'C_STD', ok: q.std_update === 'NE' || (q.std_update === 'ANO' && !!q.std_update_ref) },
    { code: 'C_EFF', ok: eff.allOk },
    { code: 'C_LEARNED', ok: !!str_(q.learned) }
  ];
  return { ok: items.every(i => i.ok), items: items, eff: eff };
}

/** The e-mail link to a page of this QRAP. */
function qrapLink_(page, id) {
  return appUrl_() + '?page=' + page + '&id=' + encodeURIComponent(id);
}

// ---------------------------------------------------------------- detail API

/**
 * Everything the detail, decision, analysis, effectiveness and assessment pages need.
 * @param {string} id QRAP number
 */
function apiGetQrap(id) {
  return apiRun_(() => ({ detail: qrapDetail_(id) }));
}

/** Builds the detail object (plain values only). */
function qrapDetail_(id) {
  const u = currentUser_();
  const q = getQrapRow_(id);
  const qid = q.qrap_id;
  const alerts = activeAlerts_(qid);
  const ia = activeIA_(qid);
  const pilots = childrenOf_('PILOT', qid);
  const why = childrenOf_('WHY_STEP', qid);
  const actions = childrenOf_('DEF_ACTION', qid);
  const notes = dbGroup_('ACTION_NOTE', 'action_id');
  const effRows = childrenOf_('EFFECTIVENESS', qid);
  const assess = childrenOf_('ASSESSMENT', qid).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  const today = todayStr_();
  const active = actions.filter(a => a.status !== 'REMOVED');
  const closure = closureChecklist_(q);
  return {
    q: clientRow_(q),
    alerts: alerts.map(clientRow_),
    ia: ia.map(clientRow_),
    photos: activePhotos_(qid).map(p => ({ file_id: p.file_id, thumb_file_id: p.thumb_file_id, kind: p.kind,
      uploaded_by: p.uploaded_by, uploaded_at: p.uploaded_at })),
    shiftInfo: childrenOf_('SHIFT_INFO', qid).map(clientRow_),
    pilots: pilots.map(p => ({ email: p.email, name: personName_(p.email), assigned_at: p.assigned_at })),
    why: why.map(clientRow_),
    actions: actions.map(a => Object.assign(clientRow_(a), {
      pilot_name: personName_(a.pilot_email),
      late: isActionLate_(a, today),
      canEdit: canEditAction_(u, q, a, pilots),
      canNote: canNoteAction_(u, q, a, pilots),
      notes: (notes[a.id] || []).map(clientRow_)
    })),
    eff: { round: closure.eff.round, slots: closure.eff.slots, distinctOk: closure.eff.distinctOk,
      history: effRows.map(clientRow_) },
    assess: assess.map(clientRow_),
    chips: computeChips_(q, { alerts: alerts, why: why, actions: active, assess: assess }, new Date()),
    waiting: waitingFor_(q),
    s3: section3State_(q, ia),
    photosOk: photosOk_(q),
    closure: { ok: closure.ok, items: closure.items },
    can: permissionsFor_(u, q, pilots),
    parentArea: (parentAreaOf_(q.area_code) || {}).code || '',
    links: { decide: qrapLink_('decide', qid), detail: qrapLink_('qrap', qid) }
  };
}
