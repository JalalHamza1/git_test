/**
 * Mail.gs – e-mail rules E1–E11, the HTML template, routing and de-duplication.
 *
 * Mails are queued during a write call (queueMail_) and sent by mailFlush_ after the sheet
 * changes are saved (see withWrite_). Every mail has a key; a key already in MAIL_LOG is never
 * sent again, so "send once" rules are safe to call many times.
 * Recipients always come from SET_ROUTING (or the pilots / finder chosen from SET_PEOPLE).
 */

let MAIL_QUEUE_ = [];
let MAIL_ENABLED_ = true; // seedDemoData() switches e-mails off

const STATUS_CZ = {
  DRAFT: 'Rozpracováno', QR_OPEN: 'Odesláno – opatření probíhají', WAIT_DECISION: 'Čeká na rozhodnutí',
  CLOSED_SOLVED: 'Uzavřeno – vyřešeno bez 5 Proč', ESCALATED: 'Eskalováno na APU', ANALYSIS: 'Analýza 5 Proč',
  ACTIONS_OPEN: 'Konečné akce probíhají', VERIFY: 'Ověření na 5 směnách', CLOSED: 'Uzavřeno'
};
const WAIT_CZ = { OPERATOR: 'operátor (rozpracováno)', TL: 'TL (opatření)', SUPERVISOR: 'supervizor',
  PILOT: 'pilot', VERIFY: 'kontrola 5 směn', APU: 'APU' };

/** Adds a mail to the queue. m = {rule, key, to[], cc[], subject, html, qrapId?, photosOf?} */
function queueMail_(m) {
  if (!MAIL_ENABLED_) return;
  MAIL_QUEUE_.push(m);
}

/**
 * Queues a mail about one QRAP with the standard layout.
 * @param {Object} q QRAP row
 * @param {{rule, key, to:string[], cc:string[], need:string, page:string, button:string,
 *          reason:string, extraHtml?:string, linkId?:string}} o
 */
function queueQrapMail_(q, o) {
  const subject = '[QRAP ' + q.qrap_id + '] ' + o.need + ' · SAFETY: ' + (q.safety === 'ANO' ? 'ano' : 'ne') +
    ' · Opakování: ' + (q.repeat_7d === 'ANO' ? 'ANO' : 'NE');
  queueMail_({
    rule: o.rule, key: o.key, to: o.to || [], cc: o.cc || [], subject: subject, qrapId: q.qrap_id,
    photosOf: q.qrap_id, html: qrapMailHtml_(q, o)
  });
}

/** The HTML body: key facts, photos placeholder, big button, footer. */
function qrapMailHtml_(q, o) {
  const area = areaByCode_(q.area_code);
  const qty = q.nok_situation === true && !Number(q.qty) ? 'NOK situace bez kusů' :
    (q.qty === '' ? '' : q.qty + ' ' + listLabelCz_('UNIT', q.unit));
  const facts = [
    ['Číslo QRAP', q.qrap_id],
    ['Oblast', q.area_code + (area ? ' – ' + area.name : '')],
    ['Stav', STATUS_CZ[q.status] || q.status],
    ['Čeká na', WAIT_CZ[waitingFor_(q)] || '–'],
    ['CO je za problém?', q.what],
    ['JAK byl objeven?', listLabelCz_('HOW_FOUND', q.how_found)],
    ['KDY?', q.detected_at ? fmt_(new Date(q.detected_at), 'd.M.yyyy HH:mm') : ''],
    ['KDE?', [q.zone, q.location_code].filter(Boolean).join(' / ')],
    ['KOLIK?', qty],
    ['SAFETY', q.safety === 'ANO' ? 'ANO' : 'ne'],
    ['Opakování (7 dní)', q.repeat_7d === 'ANO' ? 'ANO → ' + q.repeat_ref : 'NE'],
    ['Riziko na skladě / expedováno', q.risk_stock_shipped || '–'],
    ['Zkontrolováno / špatně', q.checked_qty === '' ? '' : q.checked_qty + ' / ' + q.wrong_found_qty + ' ks'],
    ['Číslo materiálu', q.material_no],
    ['HU / dodací list', q.hu_or_delivery_no],
    ['Dodavatel', q.supplier],
    ['Nalezl(a)', q.finder_name]
  ].filter(f => f[1] !== '' && f[1] !== undefined && f[1] !== null);
  const rows = facts.map(f => '<tr><td style="padding:6px 10px;border-bottom:1px solid #e3e6ea;color:#57606a;' +
    'white-space:nowrap;vertical-align:top">' + esc_(f[0]) + '</td><td style="padding:6px 10px;' +
    'border-bottom:1px solid #e3e6ea;font-weight:bold">' + esc_(f[1]) + '</td></tr>').join('');
  const link = appUrl_() + '?page=' + o.page + '&id=' + encodeURIComponent(o.linkId || q.qrap_id);
  const safety = q.safety === 'ANO' ? '<p style="background:#C62828;color:#fff;padding:8px 12px;font-weight:bold;' +
    'margin:0 0 12px">SAFETY – bezpečnostní problém</p>' : '';
  return mailFrame_('QRAP ' + q.qrap_id,
    '<p style="font-size:19px;margin:0 0 12px"><b>' + esc_(o.need) + '</b></p>' + safety +
    '<table style="border-collapse:collapse;width:100%;font-size:15px">' + rows + '</table>' +
    (o.extraHtml || '') + '{{PHOTOS}}' + mailButton_(link, o.button), o.reason);
}

/** Common frame for all e-mails. */
function mailFrame_(title, inner, reason) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:660px">' +
    '<div style="background:#1f2d3d;color:#fff;padding:14px 18px;font-size:18px;font-weight:bold">' +
    esc_(title) + '</div><div style="padding:16px 18px;border:1px solid #d0d7de;border-top:0">' + inner +
    '<p style="font-size:12px;color:#57606a;margin-top:22px">Tento e-mail dostáváte, protože jste ' +
    esc_(reason) + '. Odesláno aplikací ' + esc_(cfg_('SENDER_NAME') || APP_NAME) + '.</p></div></div>';
}

function mailButton_(link, text) {
  return '<p style="margin:22px 0"><a href="' + esc_(link) + '" style="display:inline-block;background:#2F6DB5;' +
    'color:#ffffff;padding:16px 28px;border-radius:6px;text-decoration:none;font-size:18px;font-weight:bold">' +
    esc_(text) + '</a></p>';
}

/** Routing e-mails of the person who decides this QRAP (supervisor or APU manager). */
function deciderEmails_(q) { return route_(q.area_code, deciderRole_(q)); }

// ---------------------------------------------------------------- rules

/** E1 – QRAP sent (Odeslat): supervisor of area + shift, cc manager. Once. */
function mailE1_(q) {
  const ready = q.status === ST.WAIT_DECISION;
  queueQrapMail_(q, { rule: 'E1', key: 'E1|' + q.qrap_id, to: deciderEmails_(q), cc: route_(q.area_code, 'MANAGER'),
    need: ready ? 'Nový QRAP – nutné rozhodnutí' : 'Nový QRAP – opatření probíhají', page: 'decide',
    button: 'Otevřít rozhodnutí', reason: 'supervizor oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E2 – SAFETY = ano: EHS + supervisor, cc manager. Immediately at step 1. */
function mailE2_(q) {
  queueQrapMail_(q, { rule: 'E2', key: 'E2|' + q.qrap_id,
    to: route_(q.area_code, 'EHS').concat(deciderEmails_(q)), cc: route_(q.area_code, 'MANAGER'),
    need: 'SAFETY – bezpečnostní problém', page: 'qrap', button: 'Otevřít QRAP',
    reason: 'EHS nebo supervizor oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E3 – risk on stock / shipped = ANO: Quality, cc supervisor. */
function mailE3_(q) {
  queueQrapMail_(q, { rule: 'E3', key: 'E3|' + q.qrap_id, to: route_(q.area_code, 'QUALITY'), cc: deciderEmails_(q),
    need: 'Riziko u zboží na skladě / expedovaného – Kvalita', page: 'qrap', button: 'Otevřít QRAP',
    reason: 'Kvalita pro oblast ' + q.area_code + ' (kopie: supervizor)' });
}

/** E4 – no decision by the next shift start: supervisor, cc manager. Once. */
function mailE4_(q) {
  queueQrapMail_(q, { rule: 'E4', key: 'E4|' + q.qrap_id, to: deciderEmails_(q), cc: route_(q.area_code, 'MANAGER'),
    need: 'Chybí rozhodnutí – začala další směna', page: 'decide', button: 'Rozhodnout',
    reason: 'rozhodujete QRAPy oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E5 – decision "Pokračovat": pilots, cc supervisor. */
function mailE5_(q, pilots, key) {
  queueQrapMail_(q, { rule: 'E5', key: key, to: pilots, cc: deciderEmails_(q),
    need: 'Jste pilot – analýza 5 Proč a konečné akce', page: 'analysis', button: 'Otevřít analýzu',
    reason: 'byl(a) jste určen(a) jako pilot tohoto QRAP',
    extraHtml: q.decision_comment ? '<p><b>Komentář supervizora:</b> ' + esc_(q.decision_comment) + '</p>' : '' });
}

/** E5b – new definitive action assigned: the action pilot (with due date). */
function mailE5b_(q, a) {
  const planned = a.planned ? fmt_(parseDateTime_(a.planned + 'T12:00'), 'd.M.yyyy') : '';
  queueQrapMail_(q, { rule: 'E5b', key: 'E5b|' + a.id + '|' + normEmail_(a.pilot_email), to: [a.pilot_email], cc: [],
    need: 'Nová konečná akce – termín ' + planned, page: 'actions', button: 'Moje akce',
    reason: 'jste pilot této konečné akce',
    extraHtml: '<p style="background:#f3eefb;padding:10px 12px;border-left:4px solid #7B4FB8"><b>Akce:</b> ' +
      esc_(a.text) + '<br><b>Plán:</b> ' + esc_(planned) + '</p>' });
}

/** E6 – decision "Eskalace": APU manager of the parent area, cc supervisor. */
function mailE6_(q, copy) {
  queueQrapMail_(copy, { rule: 'E6', key: 'E6|' + q.qrap_id, to: route_(copy.area_code, 'APU_MANAGER'),
    cc: deciderEmails_(q), need: 'Eskalace na APU QRQC – nutné rozhodnutí', page: 'decide',
    button: 'Otevřít rozhodnutí APU', reason: 'APU manažer pro oblast ' + copy.area_code + ' (kopie: supervizor)',
    extraHtml: '<p><b>Eskalováno z:</b> ' + esc_(q.qrap_id) + '<br><b>Komentář:</b> ' + esc_(q.decision_comment) + '</p>' });
}

/** E9 – QRAP closed: finder (if e-mail) + supervisor. */
function mailE9_(q) {
  const finder = personByName_(q.finder_name);
  queueQrapMail_(q, { rule: 'E9', key: 'E9|' + q.qrap_id + '|' + q.closed_at,
    to: (finder && finder.email ? [finder.email] : []).concat(deciderEmails_(q)), cc: [],
    need: 'QRAP uzavřen', page: 'qrap', button: 'Zobrazit QRAP',
    reason: 'jste nálezce problému nebo supervizor oblasti ' + q.area_code });
}

/** E10 – ③ not complete 24 h after KDY: TL + supervisor, cc manager. Once. */
function mailE10_(q) {
  queueQrapMail_(q, { rule: 'E10', key: 'E10|' + q.qrap_id,
    to: route_(q.area_code, 'TL').concat(deciderEmails_(q)), cc: route_(q.area_code, 'MANAGER'),
    need: 'Okamžitá opatření nejsou hotová do 24 h', page: 'qrap', button: 'Doplnit opatření',
    reason: 'TL nebo supervizor oblasti ' + q.area_code + ' (kopie: vedoucí logistiky)' });
}

/** E11 – an effectiveness slot is NOT_EFFECTIVE: pilots, cc supervisor. */
function mailE11_(q, round) {
  queueQrapMail_(q, { rule: 'E11', key: 'E11|' + q.qrap_id + '|' + round,
    to: childrenOf_('PILOT', q.qrap_id).map(p => p.email), cc: deciderEmails_(q),
    need: 'Efektivita nepotvrzena – analýza znovu otevřena', page: 'analysis', button: 'Otevřít analýzu',
    reason: 'jste pilot nebo supervizor tohoto QRAP' });
}

// ---------------------------------------------------------------- sending

/**
 * Sends the queued mails (called by withWrite_ after the sheet is saved).
 * Skips keys already in MAIL_LOG, respects the daily quota and logs every mail.
 */
function mailFlush_() {
  if (!MAIL_QUEUE_.length) return;
  const queue = MAIL_QUEUE_;
  MAIL_QUEUE_ = [];
  const sent = {};
  readLogColumn_('MAIL_LOG', 'key').forEach(k => { if (k) sent[k] = true; });
  const sender = cfg_('SENDER_NAME') || APP_NAME;
  const log = [];
  queue.forEach(m => {
    if (m.key && sent[m.key]) return;
    const to = uniq_(m.to.map(normEmail_));
    const cc = uniq_((m.cc || []).map(normEmail_)).filter(e => to.indexOf(e) < 0);
    const base = { ts: new Date(), rule: m.rule, qrap_id: m.qrapId || '', to: to.join(', '), cc: cc.join(', ') };
    if (!to.length) {
      console.warn('Mail ' + m.rule + ' for ' + (m.qrapId || '-') + ' has no recipient (check SET_ROUTING).');
      return;
    }
    if (MailApp.getRemainingDailyQuota() < to.length + cc.length) {
      log.push(Object.assign(base, { rule: m.rule + '_QUOTA', subject: m.subject, key: '' }));
      return;
    }
    try {
      const opts = { to: to.join(','), subject: m.subject, name: sender };
      if (cc.length) opts.cc = cc.join(',');
      const photos = m.photosOf ? photoBlobsForMail_(m.photosOf) : {};
      opts.inlineImages = photos;
      opts.htmlBody = m.html.replace('{{PHOTOS}}', photosHtml_(photos));
      MailApp.sendEmail(opts);
      if (m.key) sent[m.key] = true;
      log.push(Object.assign(base, { subject: m.subject, key: m.key || '' }));
    } catch (e) {
      console.error('Mail ' + m.rule + ' failed: ' + e);
      log.push(Object.assign(base, { rule: m.rule + '_ERROR', subject: truncate_(String(e.message || e), 200), key: '' }));
    }
  });
  appendByHeader_('MAIL_LOG', log);
}

/** <img> tags for the inline photo blobs. */
function photosHtml_(photos) {
  const cell = (cid, label, color) => '<td style="padding:4px 8px 4px 0;vertical-align:top">' +
    '<div style="font-weight:bold;color:' + color + '">' + label + '</div>' +
    '<img src="cid:' + cid + '" width="220" style="border:3px solid ' + color + ';max-width:220px"></td>';
  let html = '';
  if (photos.wrong) html += cell('wrong', 'ŠPATNĚ', '#C62828');
  if (photos.correct) html += cell('correct', 'SPRÁVNĚ', '#3B8A1E');
  return html ? '<table style="margin-top:14px"><tr>' + html + '</tr></table>' : '';
}
