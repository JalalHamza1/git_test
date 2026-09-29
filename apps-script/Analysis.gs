/**
 * Analysis.gs – ⑤ PŘÍČINA 5 Proč? and the single fields of ⑥ (lesson, standard question).
 *
 * WHY_STEP rows: chain OCCURRENCE ("Proč to vzniklo?") and optional NON_DETECTION
 * ("Proč to nebylo zachyceno?"), steps 1–5, one step per chain may be the root cause.
 * The status moves automatically (recomputeAnalysisStatus_):
 *   ANALYSIS → ACTIONS_OPEN (root cause + ≥ 1 action) → VERIFY (all actions CLOSED).
 */

const WHY_CHAINS = ['OCCURRENCE', 'NON_DETECTION'];

/**
 * Saves ⑤ and the lesson / standard fields of ⑥.
 * @param {{id:string, why:{OCCURRENCE:string[], NON_DETECTION:string[]},
 *          root:{OCCURRENCE:number, NON_DETECTION:number}, learned:string,
 *          std_update:string, std_update_ref:string}} p
 * @return {{ok, warnings:Array, status:string}}
 */
function apiSaveAnalysis(p) {
  return apiRun_(() => saveAnalysis_(p || {}), true);
}

function saveAnalysis_(p) {
  const u = currentUser_();
  const q = getQrapRow_(p.id);
  if (!canAnalyze_(u, q, childrenOf_('PILOT', q.qrap_id))) fail_(isLocked_(q, 'ANALYSIS') ? 'E_LOCKED' : 'E_FORBIDDEN');
  const errors = [];
  const warnings = [];
  const chains = {};
  const roots = {};
  WHY_CHAINS.forEach(chain => {
    const texts = ((p.why || {})[chain] || []).slice(0, 5).map(t => str_(t, 1000));
    while (texts.length < 5) texts.push('');
    const lastFilled = texts.reduce((m, t, i) => (t ? i + 1 : m), 0);
    for (let i = 0; i < lastFilled; i++) {
      if (!texts[i]) errors.push({ code: 'E_WHY_GAP', chain: chain, step: i + 1 });
    }
    const root = Number((p.root || {})[chain]) || 0;
    if (root && (root < 1 || root > 5 || !texts[root - 1])) errors.push({ code: 'E_ROOT_INVALID', chain: chain });
    chains[chain] = texts;
    roots[chain] = root;
  });
  const std = yesNo_(p.std_update);
  const stdRef = std === 'ANO' ? str_(p.std_update_ref, 300) : '';
  if (std === 'ANO' && !stdRef) errors.push({ code: 'E_REQUIRED', field: 'std_update_ref' });
  if (errors.length) failMany_(errors);

  saveWhySteps_(q, chains, roots);
  dbUpdate_('QRAP', q, { learned: str_(p.learned, 2000), std_update: std, std_update_ref: stdRef });
  syncStdAction_(q, u);
  recomputeAnalysisStatus_(q);

  const filled = chains.OCCURRENCE.filter(Boolean).length;
  if (filled < 3) warnings.push({ code: 'W_FEW_WHYS', n: filled });
  if (!roots.OCCURRENCE && !roots.NON_DETECTION) warnings.push({ code: 'W_NO_ROOT' });
  if (!q.learned) warnings.push({ code: 'W_LEARNED_EMPTY' });
  return { warnings: warnings, status: q.status };
}

/** Upserts the WHY_STEP rows (rows are never deleted; an empty text clears a step). */
function saveWhySteps_(q, chains, roots) {
  const existing = childrenOf_('WHY_STEP', q.qrap_id);
  WHY_CHAINS.forEach(chain => {
    for (let step = 1; step <= 5; step++) {
      const text = chains[chain][step - 1];
      const isRoot = roots[chain] === step;
      const row = existing.find(r => r.chain === chain && Number(r.step) === step);
      if (row) dbUpdate_('WHY_STEP', row, { text: text, is_root: isRoot });
      else if (text) dbInsert_('WHY_STEP', { qrap_id: q.qrap_id, chain: chain, step: step, text: text, is_root: isRoot });
    }
  });
}

/**
 * "Příležitost k aktualizaci STANDARDU?" = ANO creates the action "Aktualizovat standard"
 * (root_step STD). Changing the answer to NE removes it while it is still open.
 */
function syncStdAction_(q, u) {
  const std = activeActions_(q.qrap_id).find(a => a.root_step === 'STD');
  if (q.std_update === 'ANO') {
    const text = 'Aktualizovat standard: ' + q.std_update_ref;
    if (!std) {
      const pilot = (childrenOf_('PILOT', q.qrap_id)[0] || {}).email || u.email;
      const planned = addDaysStr_(todayStr_(), 7);
      const a = dbInsert_('DEF_ACTION', {
        id: newId_('DA'), qrap_id: q.qrap_id, root_step: 'STD', text: text, pilot_email: pilot,
        planned: planned, planned_first: planned, done: '', status: 'OPENED', evidence_url: ''
      });
      mailE5b_(q, a);
    } else if (std.status === 'OPENED') {
      dbUpdate_('DEF_ACTION', std, { text: text });
    }
  } else if (std && std.status === 'OPENED') {
    dbUpdate_('DEF_ACTION', std, { status: 'REMOVED' });
  }
}

/**
 * Moves the status between ANALYSIS, ACTIONS_OPEN and VERIFY from the data.
 * After a NOT_EFFECTIVE round, only actions created after that moment count for leaving ANALYSIS.
 */
function recomputeAnalysisStatus_(q) {
  if (ANALYSIS_STATES.indexOf(q.status) < 0) return;
  const id = q.qrap_id;
  const hasRoot = childrenOf_('WHY_STEP', id).some(w => w.is_root === true && w.text);
  const acts = activeActions_(id);
  const eff = effState_(childrenOf_('EFFECTIVENESS', id));
  const roundActs = eff.reopenAt ? acts.filter(a => a.created_at > eff.reopenAt) : acts;
  let next = ST.ANALYSIS;
  if (hasRoot && (q.status !== ST.ANALYSIS || roundActs.length) && acts.length) {
    next = acts.every(a => a.status === 'CLOSED') ? ST.VERIFY : ST.ACTIONS_OPEN;
  }
  if (!hasRoot || !acts.length) next = ST.ANALYSIS;
  if (next !== q.status) dbUpdate_('QRAP', q, { status: next });
}

/**
 * A decider adds a pilot during the analysis (a saved pilot can't be removed).
 * @param {{id:string, email:string}} p
 */
function apiAddPilot(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (ANALYSIS_STATES.indexOf(q.status) < 0 || !(isDecider_(u, q) || isAdmin_(u))) fail_('E_FORBIDDEN');
    const email = normEmail_(p.email);
    if (!personByEmail_(email)) fail_('E_PILOT_UNKNOWN', { email: email });
    const exists = childrenOf_('PILOT', q.qrap_id).some(r => normEmail_(r.email) === email);
    if (!exists) {
      dbInsert_('PILOT', { qrap_id: q.qrap_id, email: email, assigned_by: u.email, assigned_at: nowIso_() });
      mailE5_(q, [email], 'E5|' + q.qrap_id + '|' + email);
    }
    return { pilots: childrenOf_('PILOT', q.qrap_id).map(r => ({ email: r.email, name: personName_(r.email) })) };
  }, true);
}
