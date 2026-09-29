/**
 * Escalation.gs – "Eskalace na APU QRQC".
 *
 * The line QRAP is closed (status ESCALATED) and a copy is created at the parent level
 * (SET_AREAS.parent_code). The copy gets the same number plus a suffix letter
 * (WH1-2026-9-14 → WH1-2026-9-14-A), parent_id = original, and the original gets
 * assign_ref = copy ("Assign Sheet #"). ①–③ and the photo links are copied.
 */

/** Fields of ①–③ copied to the escalated QRAP. */
const ESCALATION_COPY_FIELDS = ['safety', 'what', 'how_found', 'detected_at', 'zone', 'location_code',
  'origin_zone', 'qty', 'unit', 'nok_situation', 'repeat_7d', 'repeat_ref', 'finder_name', 'finder_badge',
  'material_no', 'hu_or_delivery_no', 'supplier', 'photo_exception', 'risk_stock_shipped', 'checked_qty',
  'wrong_found_qty', 'check_in_progress', 'process_stopped', 'restored_at', 's1_done_at', 's2_done_at',
  's3_done_at', 'sent_at', 'containment_done_at'];

/**
 * Creates the APU (or PLANT) copy of a QRAP. Runs inside withWrite_.
 * @param {Object} q the line-level QRAP row
 * @return {Object} the new QRAP row (status WAIT_DECISION)
 */
function escalateQrap_(q) {
  const parent = parentAreaOf_(q.area_code);
  if (!parent) fail_('E_NO_PARENT');
  const base = baseId_(q);
  const suffix = nextSuffix_(base);
  const data = {};
  ESCALATION_COPY_FIELDS.forEach(f => { data[f] = q[f]; });
  const copy = dbInsert_('QRAP', Object.assign(data, {
    qrap_id: base + '-' + suffix, area_code: parent.code, level: parent.level, seq: q.seq, suffix: suffix,
    parent_id: q.qrap_id, status: ST.WAIT_DECISION, template_version: q.template_version || TEMPLATE_VERSION,
    locked_parts: 'QR', archived: false
  }));
  activeAlerts_(q.qrap_id).forEach(a => dbInsert_('ALERT', {
    qrap_id: copy.qrap_id, role_code: a.role_code, other_text: a.other_text, notified_to: a.notified_to,
    notified_at: a.notified_at, removed: false
  }));
  activeIA_(q.qrap_id).forEach(a => dbInsert_('IMMEDIATE_ACTION', {
    id: newId_('IA'), qrap_id: copy.qrap_id, type: a.type, text: a.text, owner_name: a.owner_name,
    owner_email: a.owner_email, done_at: a.done_at, status: a.status
  }));
  activePhotos_(q.qrap_id).forEach(ph => dbInsert_('ATTACHMENT', {
    file_id: ph.file_id, thumb_file_id: ph.thumb_file_id, qrap_id: copy.qrap_id, kind: ph.kind,
    uploaded_by: ph.uploaded_by, uploaded_at: ph.uploaded_at, removed: false
  }));
  return copy;
}

/** Number without the suffix letter: WH1-2026-9-14-A → WH1-2026-9-14. */
function baseId_(q) {
  return q.suffix ? q.qrap_id.slice(0, q.qrap_id.length - String(q.suffix).length - 1) : q.qrap_id;
}

/** Next free suffix letter for a base number (A, B, C …). */
function nextSuffix_(base) {
  let max = 64; // char code before 'A'
  dbWhere_('QRAP', r => r.suffix && r.qrap_id.indexOf(base + '-') === 0).forEach(r => {
    const c = String(r.suffix).toUpperCase().charCodeAt(0);
    if (c > max) max = c;
  });
  if (max >= 90) fail_('E_SUFFIX');
  return String.fromCharCode(max + 1);
}

/**
 * Lists for the "Eskalace" page: APU-level and PLANT-level QRAPs and the escalated line QRAPs.
 * @return {{apu:Object[], plant:Object[], escalated:Object[]}}
 */
function apiGetEscalations() {
  return apiRun_(() => {
    const qs = dbWhere_('QRAP', q => q.archived !== true && (q.level !== 'AREA' || q.status === ST.ESCALATED));
    const rows = buildBoardRows_(qs);
    return {
      apu: rows.filter(r => r.level === 'APU'),
      plant: rows.filter(r => r.level === 'PLANT'),
      escalated: rows.filter(r => r.level === 'AREA' || !r.level)
    };
  });
}
