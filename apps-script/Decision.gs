/**
 * Decision.gs – ④ Rozhodnutí OJT on the supervisor's phone.
 *
 *  - "Informace všem směnám během 5' meetingu": one tick per active shift (who + when).
 *  - One decision: CONTINUE (Pokračovat s analýzou a 5 Proč), SOLVED (Problém vyřešen:
 *    ŽÁDNÉ 5 Proč) or ESCALATE (Eskalace na APU QRQC), then the signature.
 *  - The signature stores e-mail + time and locks ①–④.
 */

/**
 * Ticks "shift informed" for one shift.
 * @param {{id:string, shift_code:string}} p
 */
function apiSaveShiftInfo(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (!canShiftInfo_(u, q)) fail_(isLocked_(q, 'DECISION') ? 'E_LOCKED' : 'E_FORBIDDEN');
    const code = up_(p.shift_code);
    if (!getSettings_().shifts.some(s => s.code === code)) fail_('E_SHIFT');
    const exists = childrenOf_('SHIFT_INFO', q.qrap_id).some(r => r.shift_code === code);
    if (!exists) {
      dbInsert_('SHIFT_INFO', { qrap_id: q.qrap_id, shift_code: code, informed_by: u.email, informed_at: nowIso_() });
    }
    return { shiftInfo: childrenOf_('SHIFT_INFO', q.qrap_id).map(clientRow_) };
  }, true);
}

/**
 * Signs the decision.
 * @param {{id:string, decision:string, comment:string, pilots:string[], confirmWarnings:boolean}} p
 * @return {{ok:boolean, status?:string, copyId?:string, needConfirm?:boolean, warnings?:Array}}
 */
function apiSignDecision(p) {
  return apiRun_(() => signDecision_(p || {}), true);
}

function signDecision_(p) {
  const u = currentUser_();
  const q = getQrapRow_(p.id);
  if (u.isKiosk) fail_('E_KIOSK_SIGN');
  if (q.status !== ST.WAIT_DECISION) fail_('E_STATE', { status: q.status });
  if (!canDecide_(u, q)) fail_('E_FORBIDDEN');
  const decision = up_(p.decision);
  const comment = str_(p.comment, 2000);
  const check = decisionGuards_(q, decision, comment, p.pilots || []);
  if (check.errors.length) failMany_(check.errors, check.warnings);
  if (check.warnings.length && p.confirmWarnings !== true) {
    return { ok: false, needConfirm: true, warnings: check.warnings };
  }
  const now = nowIso_();
  const base = {
    decision: decision, decision_comment: comment, decided_by: u.email, decided_at: now,
    locked_parts: addLock_(q.locked_parts, 'QR', 'DECISION')
  };
  let copyId = '';
  if (decision === 'SOLVED') {
    dbUpdate_('QRAP', q, Object.assign(base, { status: ST.CLOSED_SOLVED, closed_by: u.email, closed_at: now }));
    mailE9_(q);
  } else if (decision === 'ESCALATE') {
    const copy = escalateQrap_(q);
    copyId = copy.qrap_id;
    dbUpdate_('QRAP', q, Object.assign(base, { status: ST.ESCALATED, assign_ref: copyId, closed_by: u.email,
      closed_at: now }));
    mailE6_(q, copy);
  } else {
    check.newPilots.forEach(email => {
      dbInsert_('PILOT', { qrap_id: q.qrap_id, email: email, assigned_by: u.email, assigned_at: now });
    });
    dbUpdate_('QRAP', q, Object.assign(base, { status: ST.ANALYSIS }));
    mailE5_(q, childrenOf_('PILOT', q.qrap_id).map(r => r.email), 'E5|' + q.qrap_id + '|' + now);
  }
  return { status: q.status, copyId: copyId };
}

/**
 * Guard rules of ④ (spec section 7).
 * @return {{errors:Array, warnings:Array, newPilots:string[]}}
 */
function decisionGuards_(q, decision, comment, pilots) {
  const errors = [];
  const warnings = [];
  let newPilots = [];
  if (DECISIONS.indexOf(decision) < 0) errors.push({ code: 'E_REQUIRED', field: 'decision' });
  if (!section3State_(q, activeIA_(q.qrap_id)).complete) errors.push({ code: 'E_S3_INCOMPLETE' });
  if (decision === 'SOLVED') {
    if (q.safety === 'ANO') errors.push({ code: 'E_SOLVED_SAFETY' });
    if (!comment) errors.push({ code: 'E_REQUIRED', field: 'decision_comment' });
    if (q.repeat_7d === 'ANO') warnings.push({ code: 'W_SOLVED_REPEAT' });
    if (Number(q.wrong_found_qty) > 0) warnings.push({ code: 'W_SOLVED_WRONG', n: q.wrong_found_qty });
  } else if (decision === 'ESCALATE') {
    if (!comment) errors.push({ code: 'E_REQUIRED', field: 'decision_comment' });
    if (!parentAreaOf_(q.area_code)) errors.push({ code: 'E_NO_PARENT' });
  } else if (decision === 'CONTINUE') {
    const existing = childrenOf_('PILOT', q.qrap_id).map(r => normEmail_(r.email));
    newPilots = uniq_(pilots.map(normEmail_)).filter(e => existing.indexOf(e) < 0);
    newPilots.forEach(e => {
      if (!personByEmail_(e)) errors.push({ code: 'E_PILOT_UNKNOWN', email: e });
    });
    if (existing.length + newPilots.length === 0) errors.push({ code: 'E_PILOT_REQUIRED', field: 'pilots' });
  }
  const informed = childrenOf_('SHIFT_INFO', q.qrap_id).map(r => r.shift_code);
  const missing = getSettings_().shifts.filter(s => informed.indexOf(s.code) < 0).map(s => s.code);
  if (missing.length) warnings.push({ code: 'W_SHIFTS', shifts: missing.join(', ') });
  return { errors: errors, warnings: warnings, newPilots: newPilots };
}
