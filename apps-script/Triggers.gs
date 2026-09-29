/**
 * Triggers.gs – time-driven jobs.
 *
 *  checkReminders  hourly            → E4 (no decision by next shift), E10 (③ open 24 h after KDY)
 *  dailyDigest     daily DIGEST_TIME → E7 (overdue actions per pilot), E8 (manager summary, Mon–Fri)
 *  archiveOld      Sunday 23:00      → archived = TRUE for QRAPs closed > ARCHIVE_AFTER_DAYS ago
 *
 * Run installTriggers() once from the editor (and again after changing DIGEST_TIME).
 */

const TRIGGER_HANDLERS = ['checkReminders', 'dailyDigest', 'archiveOld'];

/** Creates the three triggers (old ones of this app are removed first). */
function installTriggers() {
  requireOwnerOrAdmin_();
  removeTriggers();
  const t = hhmm_(cfg_('DIGEST_TIME') || '06:30');
  ScriptApp.newTrigger('checkReminders').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyDigest').timeBased().atHour(t.h).nearMinute(t.m).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('archiveOld').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(23).inTimezone(TZ).create();
  Logger.log('Triggers installed: checkReminders (hourly), dailyDigest (%s:%s), archiveOld (Sunday 23:00).',
    t.h, ('0' + t.m).slice(-2));
}

/** Deletes the triggers of this app. */
function removeTriggers() {
  requireOwnerOrAdmin_();
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (TRIGGER_HANDLERS.indexOf(tr.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(tr); n++; }
  });
  Logger.log('Removed %s trigger(s).', n);
}

/** Hourly: E4 and E10 (each is sent only once per QRAP thanks to the MAIL_LOG key). */
function checkReminders() {
  if (!triggerCallerOk_()) throw new Error('Not allowed.');
  withWrite_(() => {
    const now = new Date();
    dbTable_('QRAP').rows.forEach(q => {
      if (q.archived === true) return;
      if (q.status === ST.WAIT_DECISION && !q.decision && q.containment_done_at) {
        const due = nextShiftStart_(new Date(q.containment_done_at));
        if (due && now > due) mailE4_(q);
      }
      if ((q.status === ST.DRAFT || q.status === ST.QR_OPEN) && q.detected_at &&
          now.getTime() - new Date(q.detected_at).getTime() > 24 * 3600000) {
        mailE10_(q);
      }
    });
  });
}

/** Daily: E7 every day, E8 on working days. The date in the key prevents a second run. */
function dailyDigest() {
  if (!triggerCallerOk_()) throw new Error('Not allowed.');
  withWrite_(() => {
    queueDigestE7_();
    if (localParts_(new Date()).dow <= 5) queueDigestE8_();
  });
}

/** Weekly: archive QRAPs closed more than ARCHIVE_AFTER_DAYS ago. */
function archiveOld() {
  if (!triggerCallerOk_()) throw new Error('Not allowed.');
  withWrite_(() => {
    const limit = Date.now() - cfgNum_('ARCHIVE_AFTER_DAYS') * 24 * 3600000;
    let n = 0;
    dbTable_('QRAP').rows.forEach(q => {
      const closed = q.closed_at || q.decided_at;
      if (q.archived !== true && FINAL_STATES.indexOf(q.status) >= 0 && closed && new Date(closed).getTime() < limit) {
        dbUpdate_('QRAP', q, { archived: true });
        n++;
      }
    });
    console.log('archiveOld: ' + n + ' QRAP(s) archived.');
  });
}

// ---------------------------------------------------------------- digests

/** E7 – one e-mail per pilot with overdue actions and due reviews; cc N+1 after OVERDUE_N1_DAYS. */
function queueDigestE7_() {
  const today = todayStr_();
  const n1Limit = addDaysStr_(today, -cfgNum_('OVERDUE_N1_DAYS'));
  const qraps = dbGroup_('QRAP', 'qrap_id');
  const actions = {};
  const byPilot = {};
  const bucket = email => (byPilot[email] = byPilot[email] || { late: [], reviews: [] });
  dbTable_('DEF_ACTION').rows.forEach(a => {
    const q = (qraps[a.qrap_id] || [])[0];
    if (!q || q.archived === true) return;
    actions[a.id] = { a: a, q: q };
    if (isActionLate_(a, today)) bucket(normEmail_(a.pilot_email)).late.push({ a: a, q: q });
  });
  dbTable_('ACTION_NOTE').rows.forEach(n => {
    const x = actions[n.action_id];
    if (x && x.a.status === 'OPENED' && n.review_date && n.review_date <= today && n.review_done !== true) {
      bucket(normEmail_(x.a.pilot_email)).reviews.push({ n: n, a: x.a, q: x.q });
    }
  });
  Object.keys(byPilot).forEach(email => {
    if (!email) return;
    const d = byPilot[email];
    const person = personByEmail_(email);
    const cc = d.late.some(x => x.a.planned <= n1Limit) && person && person.n1 ? [person.n1] : [];
    const lateRows = d.late.map(x => [x.q.qrap_id, x.a.text, fmtDay_(x.a.planned),
      '+' + daysBetween_(x.a.planned, today) + ' d']);
    const reviewRows = d.reviews.map(x => [x.q.qrap_id, x.a.text, x.n.note, fmtDay_(x.n.review_date)]);
    const html = mailFrame_('Moje akce – ' + fmtDay_(today),
      (lateRows.length ? '<h3 style="color:#C62828">Akce po termínu</h3>' +
        mailTable_(['QRAP', 'Akce', 'Plán', 'Zpoždění'], lateRows) : '') +
      (reviewRows.length ? '<h3>Revize k provedení</h3>' + mailTable_(['QRAP', 'Akce', 'Poznámka', 'Revize'], reviewRows) : '') +
      mailButton_(appUrl_() + '?page=actions', 'Otevřít Moje akce'),
      'pilot těchto konečných akcí' + (cc.length ? ' (kopie: vedoucí N+1 – akce je po termínu déle než ' +
        cfgNum_('OVERDUE_N1_DAYS') + ' dny)' : ''));
    queueMail_({ rule: 'E7', key: 'E7|' + email + '|' + today, to: [email], cc: cc, qrapId: '',
      subject: '[eQRAP] Akce po termínu – ' + fmtDay_(today), html: html });
  });
}

/** E8 – daily summary for every manager in SET_ROUTING (their areas together). */
function queueDigestE8_() {
  const now = new Date();
  const today = todayStr_(now);
  const yesterday = addDaysStr_(today, -1);
  const managers = {};
  getSettings_().routing.filter(r => r.role === 'MANAGER').forEach(r => {
    managers[r.email] = managers[r.email] || [];
    if (managers[r.email].indexOf(r.area) < 0) managers[r.email].push(r.area);
  });
  const all = dbTable_('QRAP').rows.filter(q => q.archived !== true);
  const assessments = dbTable_('ASSESSMENT').rows.filter(a => a.at && todayStr_(new Date(a.at)) === yesterday);
  Object.keys(managers).forEach(email => {
    const areas = managers[email];
    const qs = all.filter(q => areas.indexOf(q.area_code) >= 0);
    const s = managerSets_(qs, now);
    const qRow = q => [q.qrap_id, truncate_(q.what, 70), q.safety === 'ANO' ? 'ANO' : '', STATUS_CZ[q.status] || q.status];
    const section = (title, list) => '<h3>' + esc_(title) + ' (' + list.length + ')</h3>' +
      (list.length ? mailTable_(['QRAP', 'Co', 'Safety', 'Stav'], list.map(qRow)) : '<p style="color:#57606a">–</p>');
    const newYesterday = qs.filter(q => q.sent_at && todayStr_(new Date(q.sent_at)) === yesterday);
    const perAssessor = {};
    assessments.filter(a => qs.some(q => q.qrap_id === a.qrap_id))
      .forEach(a => { perAssessor[a.assessor] = (perAssessor[a.assessor] || 0) + 1; });
    const html = mailFrame_('Denní souhrn – ' + areas.join(', ') + ' – ' + fmtDay_(today),
      section('Nové včera', newYesterday) +
      section('Čeká na rozhodnutí', s.waitDecision) +
      section('Opatření ③ déle než 24 h', s.s3Late) +
      '<h3>Akce po termínu (' + s.lateActions.length + ')</h3>' +
      (s.lateActions.length ? mailTable_(['QRAP', 'Akce', 'Pilot', 'Plán'], s.lateActions.map(a =>
        [a.qrap_id, truncate_(a.text, 70), personName_(a.pilot_email), fmtDay_(a.planned)])) : '<p>–</p>') +
      section('Bezpečnost tento týden', s.safetyWeek) +
      section('Opakování (7 dní)', s.repeat7) +
      '<h3>Hodnocení QRQC včera</h3>' + (Object.keys(perAssessor).length ? mailTable_(['Hodnotitel', 'Počet'],
        Object.keys(perAssessor).map(k => [personName_(k), perAssessor[k]])) : '<p style="color:#C62828">Žádné hodnocení.</p>') +
      mailButton_(appUrl_() + '?page=manager', 'Otevřít stránku manažera'),
      'vedoucí logistiky pro oblasti ' + areas.join(', ') + ' (SET_ROUTING)');
    queueMail_({ rule: 'E8', key: 'E8|' + email + '|' + today, to: [email], cc: [], qrapId: '',
      subject: '[eQRAP] Denní souhrn ' + fmtDay_(today) + ' – ' + areas.join(', '), html: html });
  });
}

/** Simple HTML table for digests (all cells escaped). */
function mailTable_(headers, rows) {
  const th = headers.map(h => '<th style="text-align:left;padding:6px 8px;background:#eef1f4">' + esc_(h) + '</th>').join('');
  const tr = rows.map(r => '<tr>' + r.map(c => '<td style="padding:6px 8px;border-bottom:1px solid #e3e6ea">' +
    esc_(c) + '</td>').join('') + '</tr>').join('');
  return '<table style="border-collapse:collapse;width:100%;font-size:14px"><tr>' + th + '</tr>' + tr + '</table>';
}

/** 'yyyy-MM-dd' → 'd.M.yyyy'. */
function fmtDay_(day) {
  const d = parseDateTime_(String(day || '') + 'T12:00');
  return d ? fmt_(d, 'd.M.yyyy') : '';
}

/** Whole days from day a to day b ('yyyy-MM-dd'). */
function daysBetween_(a, b) {
  return Math.round((parseDateTime_(b + 'T12:00').getTime() - parseDateTime_(a + 'T12:00').getTime()) / 86400000);
}
