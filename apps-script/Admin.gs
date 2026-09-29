/**
 * Admin.gs – admin-only tools. Settings are edited directly in the SET_* tabs; these functions
 * handle signed data. A reason is always required and written to AUDIT_LOG.
 *
 *  - unlock ①–③ (QR)       : the signed facts can be corrected; status unchanged
 *  - unlock ④ (DECISION)    : decision cleared, back to WAIT_DECISION (only ANALYSIS or CLOSED_SOLVED)
 *  - reopen                 : CLOSED → VERIFY, CLOSED_SOLVED → WAIT_DECISION
 *  - archive / un-archive
 */

/** Common start of every admin call: admin role, QRAP loaded, reason present. */
function adminStart_(p) {
  const u = currentUser_();
  if (!isAdmin_(u)) fail_('E_NOT_ADMIN');
  const q = getQrapRow_(p.id);
  const reason = str_(p.reason, 500);
  if (reason.length < 5) failMany_([{ code: 'E_REASON', field: 'reason' }]);
  return { u: u, q: q, reason: reason };
}

/**
 * Unlocks a signed part.
 * @param {{id:string, part:string, reason:string}} p part: QR | DECISION
 */
function apiAdminUnlock(p) {
  return apiRun_(() => {
    p = p || {};
    const x = adminStart_(p);
    const q = x.q;
    const part = up_(p.part);
    if (part === 'QR') {
      if (!isLocked_(q, 'QR')) fail_('E_NOT_LOCKED');
      if (QR_STATES.indexOf(q.status) < 0) fail_('E_STATE', { status: q.status });
      dbUpdate_('QRAP', q, { locked_parts: removeLock_(q.locked_parts, 'QR') });
    } else if (part === 'DECISION') {
      if (q.status !== ST.ANALYSIS && q.status !== ST.CLOSED_SOLVED) fail_('E_STATE', { status: q.status });
      dbUpdate_('QRAP', q, {
        status: ST.WAIT_DECISION, decision: '', decided_by: '', decided_at: '', closed_by: '', closed_at: '',
        locked_parts: removeLock_(removeLock_(q.locked_parts, 'DECISION'), 'QR')
      });
    } else {
      fail_('E_INVALID', { field: 'part' });
    }
    audit_(q.qrap_id, 'QRAP', q.qrap_id, 'ADMIN_UNLOCK_' + part, 'reason', '', x.reason);
    return { status: q.status };
  }, true);
}

/** Reopens a closed QRAP. @param {{id:string, reason:string}} p */
function apiAdminReopen(p) {
  return apiRun_(() => {
    p = p || {};
    const x = adminStart_(p);
    const q = x.q;
    if (q.status === ST.CLOSED) {
      dbUpdate_('QRAP', q, { status: ST.VERIFY, closed_by: '', closed_at: '', archived: false,
        locked_parts: removeLock_(q.locked_parts, 'ANALYSIS') });
    } else if (q.status === ST.CLOSED_SOLVED) {
      dbUpdate_('QRAP', q, { status: ST.WAIT_DECISION, decision: '', decided_by: '', decided_at: '',
        closed_by: '', closed_at: '', archived: false,
        locked_parts: removeLock_(removeLock_(q.locked_parts, 'DECISION'), 'QR') });
    } else {
      fail_('E_STATE', { status: q.status });
    }
    audit_(q.qrap_id, 'QRAP', q.qrap_id, 'ADMIN_REOPEN', 'reason', '', x.reason);
    return { status: q.status };
  }, true);
}

/** Archives or restores a QRAP. @param {{id:string, archived:boolean, reason:string}} p */
function apiAdminArchive(p) {
  return apiRun_(() => {
    p = p || {};
    const x = adminStart_(p);
    const on = p.archived === true;
    dbUpdate_('QRAP', x.q, { archived: on });
    audit_(x.q.qrap_id, 'QRAP', x.q.qrap_id, on ? 'ADMIN_ARCHIVE' : 'ADMIN_UNARCHIVE', 'reason', '', x.reason);
    return { archived: on };
  }, true);
}
