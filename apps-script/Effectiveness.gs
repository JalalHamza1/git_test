/**
 * Effectiveness.gs – "Efektivita zkontrolována na 5 směnách bez chyb" and the closure signature.
 *
 *  - 5 slots per round. EFFECTIVE slots must be on 5 different shifts (date + shift unique).
 *  - NOT_VERIFIED can be overwritten later. EFFECTIVE is final.
 *  - NOT_EFFECTIVE ends the round: round + 1, back to ANALYSIS, pilots + decider notified (E11).
 *  - Closure (VERIFY → CLOSED) only when closureChecklist_ passes; it locks ⑤⑥ and sends E9.
 */

/**
 * Records one slot.
 * @param {{id:string, slot:number, shift_date:string, shift_code:string, result:string, checked_by?:string}} p
 * @return {{ok, status:string, round:number}}
 */
function apiSaveEffect(p) {
  return apiRun_(() => saveEffect_(p || {}), true);
}

function saveEffect_(p) {
  const u = currentUser_();
  const q = getQrapRow_(p.id);
  if (!canEffect_(u, q)) fail_(q.status !== ST.VERIFY ? 'E_STATE' : 'E_FORBIDDEN', { status: q.status });
  const rows = childrenOf_('EFFECTIVENESS', q.qrap_id);
  const eff = effState_(rows);
  const slot = Number(p.slot);
  const date = dateStr_(p.shift_date);
  const shift = up_(p.shift_code);
  const result = up_(p.result);
  const checkedBy = u.isKiosk ? str_(p.checked_by, 100) : u.name;
  const errors = [];
  if (!(slot >= 1 && slot <= 5)) errors.push({ code: 'E_SLOT' });
  if (!date) errors.push({ code: 'E_REQUIRED', field: 'shift_date' });
  else if (date > todayStr_()) errors.push({ code: 'E_SHIFT_FUTURE', field: 'shift_date' });
  if (!getSettings_().shifts.some(s => s.code === shift)) errors.push({ code: 'E_SHIFT', field: 'shift_code' });
  if (EFF_RESULTS.indexOf(result) < 0) errors.push({ code: 'E_REQUIRED', field: 'result' });
  if (!checkedBy) errors.push({ code: 'E_REQUIRED', field: 'checked_by' });
  const current = eff.slots[slot - 1];
  if (current && current.result === 'EFFECTIVE') errors.push({ code: 'E_SLOT_FINAL' });
  if (result === 'EFFECTIVE' && eff.slots.some((s, i) => s && i !== slot - 1 && s.result === 'EFFECTIVE' &&
      s.shift_date === date && s.shift_code === shift)) {
    errors.push({ code: 'E_SHIFT_DUP' });
  }
  if (errors.length) failMany_(errors);

  const values = { shift_date: date, shift_code: shift, result: result, checked_by: checkedBy, checked_at: nowIso_() };
  const existing = rows.find(r => Number(r.round) === eff.round && Number(r.slot) === slot);
  if (existing) dbUpdate_('EFFECTIVENESS', existing, values); // only NOT_VERIFIED rows reach this point
  else dbInsert_('EFFECTIVENESS', Object.assign({ qrap_id: q.qrap_id, round: eff.round, slot: slot }, values));

  if (result === 'NOT_EFFECTIVE') {
    dbUpdate_('QRAP', q, { status: ST.ANALYSIS });
    mailE11_(q, eff.round);
  }
  return { status: q.status, round: effState_(childrenOf_('EFFECTIVENESS', q.qrap_id)).round };
}

/**
 * Closure signature ("Uzavření QRAP schváleno Supervizorem").
 * @param {{id:string}} p
 */
function apiSignClosure(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (u.isKiosk) fail_('E_KIOSK_SIGN');
    if (!canClose_(u, q)) fail_(q.status !== ST.VERIFY ? 'E_STATE' : 'E_FORBIDDEN', { status: q.status });
    const check = closureChecklist_(q);
    if (!check.ok) {
      failMany_([{ code: 'E_CLOSURE', items: check.items.filter(i => !i.ok).map(i => i.code) }]);
    }
    const now = nowIso_();
    dbUpdate_('QRAP', q, { status: ST.CLOSED, closed_by: u.email, closed_at: now,
      locked_parts: addLock_(q.locked_parts, 'ANALYSIS') });
    mailE9_(q);
    return { status: q.status };
  }, true);
}
