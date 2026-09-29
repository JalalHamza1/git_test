/**
 * Manager.gs – manager page (tiles, "Potřebuje vás", filtered list) and search.
 * managerSets_ is shared with the daily summary e-mail (E8).
 */

/**
 * Manager page data.
 * @param {{area?:string, from?:string, to?:string, status?:string}} f
 */
function apiGetManager(f) {
  return apiRun_(() => {
    f = f || {};
    const u = currentUser_();
    if (!canManager_(u)) fail_('E_FORBIDDEN');
    const area = up_(f.area);
    const now = new Date();
    const qs = dbWhere_('QRAP', q => q.archived !== true && (!area || q.area_code === area));
    const sets = managerSets_(qs, now);
    const tiles = {
      newToday: sets.newToday.length,
      waitDecision: sets.waitDecision.length,
      s3Late: sets.s3Late.length,
      actionsLate: sets.lateActions.length,
      safetyWeek: sets.safetyWeek.length,
      repeat7: sets.repeat7.length
    };
    let list = qs;
    if (f.from) list = list.filter(q => q.detected_at && todayStr_(new Date(q.detected_at)) >= f.from);
    if (f.to) list = list.filter(q => q.detected_at && todayStr_(new Date(q.detected_at)) <= f.to);
    if (f.status === 'open') list = list.filter(q => FINAL_STATES.indexOf(q.status) < 0);
    else if (f.status === 'closed') list = list.filter(q => FINAL_STATES.indexOf(q.status) >= 0);
    else if (ST[f.status]) list = list.filter(q => q.status === f.status);
    const rows = buildBoardRows_(list).reverse();
    return {
      tiles: tiles,
      assessToday: assessPerSupervisor_(area, todayStr_(now)),
      needs: needsYou_(sets, now).slice(0, 60),
      rows: rows.slice(0, 300),
      total: rows.length
    };
  });
}

/**
 * Groups of QRAPs / actions used by the tiles, "Potřebuje vás" and the daily summary.
 * @param {Object[]} qs QRAP rows (already filtered by area, not archived)
 * @param {Date} now
 */
function managerSets_(qs, now) {
  const today = todayStr_(now);
  const t = now.getTime();
  const weekStart = weekStart_(now).getTime();
  const det = q => (q.detected_at ? new Date(q.detected_at).getTime() : 0);
  const qById = {};
  qs.forEach(q => { qById[q.qrap_id] = q; });
  const waitDecision = qs.filter(q => q.status === ST.WAIT_DECISION);
  return {
    qById: qById,
    newToday: qs.filter(q => q.status !== ST.DRAFT && det(q) && todayStr_(new Date(det(q))) === today),
    waitDecision: waitDecision,
    decisionLate: waitDecision.filter(q => {
      const due = q.containment_done_at ? nextShiftStart_(new Date(q.containment_done_at)) : null;
      return due && now > due;
    }),
    s3Late: qs.filter(q => (q.status === ST.DRAFT || q.status === ST.QR_OPEN) && det(q) && t - det(q) > 24 * 3600000),
    lateActions: dbWhere_('DEF_ACTION', a => !!qById[a.qrap_id] && isActionLate_(a, today)),
    safetyWeek: qs.filter(q => q.safety === 'ANO' && det(q) >= weekStart),
    repeat7: qs.filter(q => q.repeat_7d === 'ANO' && det(q) && t - det(q) <= 7 * 24 * 3600000)
  };
}

/** "Potřebuje vás": everything that is late or waiting, most urgent first. */
function needsYou_(sets, now) {
  const items = [];
  const seen = {};
  const add = (q, reason, urgency, extra) => {
    items.push({ id: q.qrap_id, what: truncate_(q.what, 90), area: q.area_code, reason: reason,
      urgency: urgency + (q.safety === 'ANO' ? 20 : 0), since: q.detected_at || q.created_at,
      safety: q.safety === 'ANO', extra: extra || '' });
    seen[q.qrap_id] = true;
  };
  sets.decisionLate.forEach(q => add(q, 'DECISION_LATE', 90));
  sets.s3Late.forEach(q => add(q, 'S3_LATE', 80));
  const today = todayStr_(now);
  sets.lateActions.forEach(a => {
    const q = sets.qById[a.qrap_id];
    const days = daysBetween_(a.planned, today);
    add(q, 'ACTION_LATE', 60 + Math.min(days, 30), truncate_(a.text, 80) + ' · ' + personName_(a.pilot_email) +
      ' · +' + days + ' d');
  });
  sets.waitDecision.forEach(q => { if (sets.decisionLate.indexOf(q) < 0) add(q, 'WAIT_DECISION', 50); });
  Object.keys(sets.qById).forEach(id => {
    const q = sets.qById[id];
    if (q.safety === 'ANO' && FINAL_STATES.indexOf(q.status) < 0 && !seen[id]) add(q, 'SAFETY_OPEN', 30);
  });
  items.sort((a, b) => b.urgency - a.urgency || (a.since < b.since ? -1 : 1));
  return items;
}

/**
 * "Hodnocení dnes per supervisor": every supervisor of the area (0 included) plus other assessors.
 * @return {{name:string, email:string, count:number, supervisor:boolean}[]}
 */
function assessPerSupervisor_(area, day) {
  const counts = {};
  dbTable_('ASSESSMENT').rows.forEach(a => {
    if (a.at && todayStr_(new Date(a.at)) === day) counts[a.assessor] = (counts[a.assessor] || 0) + 1;
  });
  const out = [];
  getSettings_().people.forEach(p => {
    if (!p.email || p.roles.indexOf('SUPERVISOR') < 0) return;
    if (area && p.areas.indexOf('*') < 0 && p.areas.indexOf(area) < 0) return;
    out.push({ name: p.name, email: p.email, count: counts[p.email] || 0, supervisor: true });
  });
  Object.keys(counts).forEach(email => {
    if (!out.some(o => o.email === email)) out.push({ name: personName_(email), email: email, count: counts[email], supervisor: false });
  });
  out.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
  return out;
}

/**
 * Search by number, text, material number, HU / delivery note or supplier (archived included).
 * @param {string} text at least 2 characters
 */
function apiSearch(text) {
  return apiRun_(() => {
    const s = str_(text, 100).toLowerCase();
    if (s.length < 2) fail_('E_SEARCH_SHORT');
    const fields = ['qrap_id', 'what', 'material_no', 'hu_or_delivery_no', 'supplier'];
    const hits = dbWhere_('QRAP', q => fields.some(f => String(q[f] || '').toLowerCase().indexOf(s) >= 0));
    const rows = buildBoardRows_(hits).reverse().slice(0, 50);
    rows.forEach(r => { r.archived = (hits.find(q => q.qrap_id === r.id) || {}).archived === true; });
    return { rows: rows, total: hits.length };
  });
}
