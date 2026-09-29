/**
 * Wizard.gs – the kiosk wizard: 1 Popis · 2 Fotky · 3 Upozornění · 4 Opatření · 5 Kontrola a odeslání.
 *
 * Every "Další" calls apiSaveStep (mode 'next'): the step is validated on the server and saved.
 * "Dokončí TL později" uses mode 'later'; the idle timeout uses mode 'draft' (no validation for
 * DRAFT rows, so nothing typed is lost). apiSubmitQrap is the "Odeslat" button.
 */

/**
 * Saves one wizard step.
 * @param {{id?:string, area:string, step:number, mode:string, data:Object}} p
 * @return {{ok:boolean, id?:string, state?:Object, warnings?:Array, errors?:Array}}
 */
function apiSaveStep(p) {
  return apiRun_(() => saveStep_(p || {}), true);
}

/** Loads the wizard state of an existing QRAP (for "Pokračovat" and edits). */
function apiGetWizard(id) {
  return apiRun_(() => {
    const q = getQrapRow_(id);
    const u = currentUser_();
    if (!canEditQr_(u, q) && !canEditCheck_(u, q)) fail_('E_FORBIDDEN');
    return { state: wizardState_(q) };
  });
}

/** "Odeslat": DRAFT → QR_OPEN (and at once WAIT_DECISION if ③ is complete). */
function apiSubmitQrap(id) {
  return apiRun_(() => submitQrap_(id), true);
}

function saveStep_(p) {
  const u = currentUser_();
  const step = Number(p.step);
  const mode = ['next', 'later', 'draft'].indexOf(p.mode) >= 0 ? p.mode : 'next';
  const data = p.data || {};
  let q = p.id ? getQrapRow_(p.id) : null;
  let checkOnly = false;
  if (!q) {
    if (step !== 1) fail_('E_NO_ID');
    if (!canCreate_(u, p.area)) fail_('E_FORBIDDEN');
  } else if (!canEditQr_(u, q)) {
    if (step === 4 && canEditCheck_(u, q)) checkOnly = true;
    else fail_(isLocked_(q, 'QR') ? 'E_LOCKED' : 'E_FORBIDDEN');
  }
  // A sent QRAP must always stay valid: the lenient draft mode is only for DRAFT rows.
  const strict = mode !== 'draft' || (q && q.status !== ST.DRAFT);
  let res;
  if (step === 1) res = saveStep1_(q, up_(p.area), data, strict);
  else if (step === 2) res = saveStep2_(q, data, strict);
  else if (step === 3) res = saveStep3_(q, data, strict);
  else if (step === 4) res = saveStep4_(q, data, mode, strict, checkOnly);
  else fail_('E_STEP');
  return { id: res.q.qrap_id, warnings: res.warnings || [], state: wizardState_(res.q) };
}

/** The data the wizard needs to show a QRAP again. */
function wizardState_(q) {
  const u = currentUser_();
  return {
    q: clientRow_(q),
    alerts: activeAlerts_(q.qrap_id).map(clientRow_),
    ia: activeIA_(q.qrap_id).map(clientRow_),
    photos: activePhotos_(q.qrap_id).map(p => ({ file_id: p.file_id, thumb_file_id: p.thumb_file_id, kind: p.kind })),
    s3: section3State_(q, activeIA_(q.qrap_id)),
    can: { editQr: canEditQr_(u, q), editCheck: canEditCheck_(u, q) }
  };
}

// ---------------------------------------------------------------- step 1: ① popis

/** Cleans the step 1 values coming from the browser (types and lengths only). */
function cleanStep1_(d) {
  const how = up_(d.how_found);
  return {
    safety: yesNo_(d.safety),
    what: str_(d.what, 2000),
    how_found: how === 'OTHER' ? 'OTHER:' + str_(d.how_found_other, 200) : how,
    detected_at: isoOrBlank_(d.detected_at),
    zone: str_(d.zone, 100),
    location_code: str_(d.location_code, 100),
    origin_zone: str_(d.origin_zone, 100),
    qty: intOrBlank_(d.qty),
    unit: up_(d.unit),
    nok_situation: d.nok_situation === true,
    repeat_7d: yesNo_(d.repeat_7d),
    repeat_ref: yesNo_(d.repeat_7d) === 'ANO' ? str_(d.repeat_ref, 60) : '',
    finder_name: str_(d.finder_name, 100),
    finder_badge: str_(d.finder_badge, 40),
    material_no: str_(d.material_no, 60),
    hu_or_delivery_no: str_(d.hu_or_delivery_no, 60),
    supplier: str_(d.supplier, 100)
  };
}

/**
 * Server rules of ① (also used again at submit).
 * @param {Object} q merged row values
 * @return {{errors:Array, warnings:Array}}
 */
function validateStep1_(q) {
  const errors = [];
  const warnings = [];
  const req = field => errors.push({ code: 'E_REQUIRED', field: field });
  const now = Date.now();
  if (!q.safety) req('safety');
  if (!q.what) req('what');
  else if (q.what.length < 10) warnings.push({ code: 'W_WHAT_SHORT' });
  const how = String(q.how_found || '');
  if (!how) req('how_found');
  else if (how.indexOf('OTHER:') === 0) { if (how.length < 7) req('how_found_other'); }
  else if (listCodes_('HOW_FOUND').indexOf(how) < 0) errors.push({ code: 'E_INVALID', field: 'how_found' });
  if (!q.detected_at) req('detected_at');
  else {
    const det = new Date(q.detected_at).getTime();
    if (det > now + 5 * 60000) errors.push({ code: 'E_FUTURE', field: 'detected_at' });
    else if (det < now - 24 * 3600000) warnings.push({ code: 'W_OLD_DETECTION' });
  }
  if (!q.zone) req('zone');
  if (!q.location_code) req('location_code');
  if (q.qty === '' || q.qty === undefined) req('qty');
  else if (Number(q.qty) === 0 && q.nok_situation !== true) errors.push({ code: 'E_QTY_ZERO', field: 'qty' });
  if (Number(q.qty) > 0 && listCodes_('UNIT').indexOf(q.unit) < 0) req('unit');
  if (!q.repeat_7d) req('repeat_7d');
  else if (q.repeat_7d === 'ANO' && !repeatRefValid_(q)) errors.push({ code: 'E_REPEAT_REF', field: 'repeat_ref' });
  if (!q.finder_name && !q.finder_badge) req('finder_name');
  return { errors: errors, warnings: warnings };
}

/** The referenced QRAP must exist in the same area, within the 7 days before KDY. */
function repeatRefValid_(q) {
  const ref = str_(q.repeat_ref);
  if (!ref || ref === q.qrap_id) return false;
  const r = dbFirst_('QRAP', x => x.qrap_id === ref);
  if (!r || r.area_code !== q.area_code || !r.detected_at) return false;
  const det = q.detected_at ? new Date(q.detected_at).getTime() : Date.now();
  const refDet = new Date(r.detected_at).getTime();
  return refDet <= det + 60000 && refDet >= det - 7 * 24 * 3600000;
}

function saveStep1_(q, area, d, strict) {
  const v = cleanStep1_(d);
  if (!v.finder_name && v.finder_badge) {
    const p = personByBadge_(v.finder_badge);
    if (p) v.finder_name = p.name;
  }
  const merged = Object.assign({}, q || {}, v, { area_code: q ? q.area_code : area, qrap_id: q ? q.qrap_id : '' });
  const check = validateStep1_(merged);
  if (strict && check.errors.length) failMany_(check.errors, check.warnings);
  const valid = check.errors.length === 0;
  if (!q) {
    const idInfo = nextQrapId_(area);
    q = dbInsert_('QRAP', Object.assign({
      qrap_id: idInfo.id, area_code: area, level: 'AREA', seq: idInfo.seq, suffix: '', parent_id: '',
      status: ST.DRAFT, template_version: TEMPLATE_VERSION, locked_parts: '', archived: false
    }, v));
  } else {
    dbUpdate_('QRAP', q, v);
  }
  dbUpdate_('QRAP', q, { s1_done_at: valid ? (q.s1_done_at || nowIso_()) : '' });
  if (q.safety === 'ANO') mailE2_(q); // does not wait for "Odeslat"
  return { q: q, warnings: check.warnings };
}

// ---------------------------------------------------------------- step 2: fotky

function saveStep2_(q, d, strict) {
  const exception = str_(d.photo_exception, 500);
  dbUpdate_('QRAP', q, { photo_exception: exception });
  if (strict && !photosOk_(q)) failMany_([{ code: 'E_PHOTOS' }]);
  return { q: q };
}

// ---------------------------------------------------------------- step 3: ② kdo byl upozorněn

function saveStep3_(q, d, strict) {
  const valid = listCodes_('ALERT_ROLE');
  let roles = uniq_((d.roles || []).map(up_)).filter(r => valid.indexOf(r) >= 0);
  if (q.risk_stock_shipped === 'ANO' && roles.indexOf('QUALITY') < 0) roles.push('QUALITY');
  const otherText = str_(d.other_text, 200);
  if (strict) {
    const errors = [];
    if (!roles.length) errors.push({ code: 'E_ALERT_NONE' });
    if (roles.indexOf('OTHER') >= 0 && !otherText) errors.push({ code: 'E_REQUIRED', field: 'alert_other' });
    if (errors.length) failMany_(errors);
  }
  setAlerts_(q, roles, otherText);
  dbUpdate_('QRAP', q, { s2_done_at: roles.length ? (q.s2_done_at || nowIso_()) : '' });
  return { q: q };
}

/** Makes the active ALERT rows equal to `roles` (un-ticked rows get removed = TRUE). */
function setAlerts_(q, roles, otherText) {
  const current = activeAlerts_(q.qrap_id);
  current.forEach(a => {
    if (roles.indexOf(a.role_code) < 0) dbUpdate_('ALERT', a, { removed: true });
    else if (a.role_code === 'OTHER') dbUpdate_('ALERT', a, { other_text: otherText });
  });
  roles.forEach(code => {
    if (current.some(a => a.role_code === code)) return;
    dbInsert_('ALERT', {
      qrap_id: q.qrap_id, role_code: code, other_text: code === 'OTHER' ? otherText : '',
      notified_to: ROUTING_KEYS.indexOf(code) >= 0 ? route_(q.area_code, code).join(', ') : '',
      notified_at: nowIso_(), removed: false
    });
  });
}

// ---------------------------------------------------------------- step 4: ③ okamžitá opatření

function cleanStep4_(d) {
  return {
    risk_stock_shipped: yesNo_(d.risk_stock_shipped),
    checked_qty: intOrBlank_(d.checked_qty),
    wrong_found_qty: intOrBlank_(d.wrong_found_qty),
    check_in_progress: d.check_in_progress === true,
    process_stopped: yesNo_(d.process_stopped),
    restored_at: yesNo_(d.process_stopped) === 'ANO' ? isoOrBlank_(d.restored_at) : ''
  };
}

function cleanIaRows_(rows) {
  return (rows || []).slice(0, 30).map(r => ({
    id: str_(r.id, 40), type: up_(r.type), text: str_(r.text, 500), owner_name: str_(r.owner_name, 100),
    done_at: isoOrBlank_(r.done_at), remove: r.remove === true
  }));
}

/** Consistency rules of ③ (always checked unless the idle draft mode is used). */
function validateStep4_(q, v, rows) {
  const errors = [];
  if (!v.risk_stock_shipped) errors.push({ code: 'E_REQUIRED', field: 'risk_stock_shipped' });
  if (v.checked_qty !== '' && v.wrong_found_qty !== '' && v.wrong_found_qty > v.checked_qty) {
    errors.push({ code: 'E_WRONG_GT_CHECKED', field: 'wrong_found_qty' });
  }
  const det = q.detected_at ? new Date(q.detected_at).getTime() : 0;
  if (v.restored_at && det && new Date(v.restored_at).getTime() < det) {
    errors.push({ code: 'E_RESTORED_BEFORE', field: 'restored_at' });
  }
  const types = listCodes_('ACTION_TYPE');
  rows.filter(r => !r.remove).forEach((r, i) => {
    if (types.indexOf(r.type) < 0) errors.push({ code: 'E_IA_ROW', row: i + 1, field: 'type' });
    if (!r.text) errors.push({ code: 'E_IA_ROW', row: i + 1, field: 'text' });
    if (!r.owner_name) errors.push({ code: 'E_IA_ROW', row: i + 1, field: 'owner_name' });
    if (r.done_at) {
      const t = new Date(r.done_at).getTime();
      if (t > Date.now() + 5 * 60000) errors.push({ code: 'E_IA_DONE_FUTURE', row: i + 1 });
      else if (det && t < det) errors.push({ code: 'E_IA_DONE_BEFORE', row: i + 1 });
    }
  });
  return errors;
}

function saveStep4_(q, d, mode, strict, checkOnly) {
  let v = cleanStep4_(d);
  let rows = cleanIaRows_(d.actions);
  if (checkOnly) { // Quality: only the check data
    v = { checked_qty: v.checked_qty, wrong_found_qty: v.wrong_found_qty, check_in_progress: v.check_in_progress };
    rows = null;
  }
  if (strict) {
    const full = Object.assign({ risk_stock_shipped: q.risk_stock_shipped }, v);
    const errors = validateStep4_(q, full, rows || []);
    if (mode === 'next' && !errors.length && !checkOnly) {
      const preview = Object.assign({}, q, v);
      const iaPreview = rows.filter(r => !r.remove);
      const s3 = section3State_(preview, iaPreview);
      if (!s3.complete) errors.push({ code: 'E_S3_INCOMPLETE', missing: s3.missing });
    }
    if (errors.length) failMany_(errors);
  }
  dbUpdate_('QRAP', q, v);
  if (rows) saveIaRows_(q, rows);
  if (q.risk_stock_shipped && !q.s3_done_at) dbUpdate_('QRAP', q, { s3_done_at: nowIso_() });
  if (q.risk_stock_shipped === 'ANO') {
    const roles = activeAlerts_(q.qrap_id).map(a => a.role_code);
    if (roles.indexOf('QUALITY') < 0) {
      const other = (activeAlerts_(q.qrap_id).find(a => a.role_code === 'OTHER') || {}).other_text || '';
      setAlerts_(q, roles.concat(['QUALITY']), other);
    }
    mailE3_(q);
  }
  refreshContainment_(q);
  return { q: q };
}

/** Inserts / updates the immediate action rows ("removing" = status REMOVED). */
function saveIaRows_(q, rows) {
  const existing = childrenOf_('IMMEDIATE_ACTION', q.qrap_id);
  rows.forEach(r => {
    const owner = personByName_(r.owner_name);
    const values = {
      type: r.type, text: r.text, owner_name: r.owner_name, owner_email: owner ? owner.email : '',
      done_at: r.done_at, status: r.remove ? 'REMOVED' : (r.done_at ? 'DONE' : 'OPEN')
    };
    const row = r.id ? existing.find(x => x.id === r.id) : null;
    if (row) dbUpdate_('IMMEDIATE_ACTION', row, values);
    else if (!r.remove && (r.text || r.type)) {
      dbInsert_('IMMEDIATE_ACTION', Object.assign({ id: newId_('IA'), qrap_id: q.qrap_id }, values));
    }
  });
}

// ---------------------------------------------------------------- step 5: odeslat

function submitQrap_(id) {
  const u = currentUser_();
  const q = getQrapRow_(id);
  if (q.status !== ST.DRAFT) fail_('E_ALREADY_SENT');
  if (!canEditQr_(u, q)) fail_('E_FORBIDDEN');
  const errors = validateStep1_(q).errors.slice();
  if (!photosOk_(q)) errors.push({ code: 'E_PHOTOS' });
  if (!activeAlerts_(q.qrap_id).length) errors.push({ code: 'E_ALERT_NONE' });
  // ③ values saved by the idle draft mode were not validated yet: check them now.
  validateStep4_(q, q, activeIA_(q.qrap_id)).forEach(e => errors.push(e));
  if (errors.length) failMany_(errors);
  const now = nowIso_();
  dbUpdate_('QRAP', q, { status: ST.QR_OPEN, sent_at: now, s1_done_at: q.s1_done_at || now,
    s2_done_at: q.s2_done_at || now });
  refreshContainment_(q);
  mailE1_(q);
  if (q.safety === 'ANO') mailE2_(q);            // only if not sent yet (dedupe key)
  if (q.risk_stock_shipped === 'ANO') mailE3_(q); // only if not sent yet (dedupe key)
  return { id: q.qrap_id, status: q.status };
}

// ---------------------------------------------------------------- drafts and repeats

/** DRAFTs and QR_OPEN QRAPs of an area ("Pokračovat v rozpracovaném"). */
function apiGetDrafts(area) {
  return apiRun_(() => {
    const code = up_(area);
    const rows = dbWhere_('QRAP', q => q.area_code === code && q.archived !== true &&
      (q.status === ST.DRAFT || q.status === ST.QR_OPEN));
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { drafts: rows.map(q => ({ id: q.qrap_id, what: truncate_(q.what, 90), status: q.status,
      detected_at: q.detected_at, created_at: q.created_at, s1: !!q.s1_done_at, s2: !!q.s2_done_at,
      photos: photosOk_(q), risk: q.risk_stock_shipped })) };
  });
}

/**
 * Suggests QRAPs of the last 7 days in the same area that may be the same problem.
 * @param {{area:string, id?:string, material_no?:string, zone?:string, what?:string, detected_at?:string}} p
 */
function apiSuggestRepeats(p) {
  return apiRun_(() => {
    p = p || {};
    const area = up_(p.area);
    const det = parseDateTime_(p.detected_at) || new Date();
    const from = det.getTime() - 7 * 24 * 3600000;
    const words = str_(p.what, 500).toLowerCase().split(/[^a-zá-ž0-9]+/i).filter(w => w.length >= 4);
    const mat = str_(p.material_no).toLowerCase();
    const list = dbWhere_('QRAP', q => q.area_code === area && q.qrap_id !== p.id && q.detected_at &&
      new Date(q.detected_at).getTime() >= from && new Date(q.detected_at).getTime() <= det.getTime() + 60000)
      .map(q => {
        let score = 0;
        if (mat && String(q.material_no).toLowerCase() === mat) score += 3;
        if (p.zone && q.zone === p.zone) score += 1;
        const text = String(q.what).toLowerCase();
        words.forEach(w => { if (text.indexOf(w) >= 0) score += 1; });
        return { id: q.qrap_id, what: truncate_(q.what, 90), zone: q.zone, material_no: q.material_no,
          detected_at: q.detected_at, score: score };
      });
    list.sort((a, b) => b.score - a.score || (a.detected_at < b.detected_at ? 1 : -1));
    return { items: list.slice(0, 10) };
  });
}
