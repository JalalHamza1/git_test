/**
 * Assessment.gs – ⑦ Hodnocení QRQC.
 *
 * Five criteria, each OK / NOK / NA:
 *  1 RED BOX · 2 ROZDĚLENÍ · 3 POROVNÁNÍ · 4 POUČENÍ A SDÍLENÍ · 5 ON JOB TRAINING
 * plus "OJT s kým", feedback text and type. The assessor and time are automatic.
 * Every assessment is kept (the detail page shows the latest first).
 */

/**
 * Saves a new assessment.
 * @param {{id:string, c1:string, c2:string, c3:string, c4:string, c5:string,
 *          ojt_with:string, feedback:string, feedback_type:string}} p
 */
function apiSaveAssessment(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.id);
    if (!canAssess_(u, q)) fail_(q.status === ST.DRAFT ? 'E_STATE' : 'E_FORBIDDEN', { status: q.status });
    const errors = [];
    const values = {};
    ['c1', 'c2', 'c3', 'c4', 'c5'].forEach(c => {
      values[c] = up_(p[c]);
      if (ASSESS_VALUES.indexOf(values[c]) < 0) errors.push({ code: 'E_CRITERIA', field: c });
    });
    const type = up_(p.feedback_type);
    if (type && FEEDBACK_TYPES.indexOf(type) < 0) errors.push({ code: 'E_INVALID', field: 'feedback_type' });
    const feedback = str_(p.feedback, 2000);
    if (!feedback) errors.push({ code: 'E_REQUIRED', field: 'feedback' });
    if (errors.length) failMany_(errors);
    const row = dbInsert_('ASSESSMENT', Object.assign(values, {
      id: newId_('AS'), qrap_id: q.qrap_id, assessor: u.email, at: nowIso_(),
      ojt_with: str_(p.ojt_with, 100), feedback: feedback, feedback_type: type
    }));
    return { assessment: clientRow_(row) };
  }, true);
}
