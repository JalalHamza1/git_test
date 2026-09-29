/**
 * SeedDemo.gs – about 9 demo QRAPs in different states, so the board, the detail pages and the
 * manager page can be tried at once. No e-mails are sent and no photos are used.
 *
 * Runs once. To run it again, delete the script property DEMO_SEEDED
 * (Project Settings → Script properties).
 */

/** Creates the demo QRAPs (run from the editor after setup()). */
function seedDemoData() {
  requireOwnerOrAdmin_();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('DEMO_SEEDED')) {
    Logger.log('Demo data already exists (script property DEMO_SEEDED). Delete the property to seed again.');
    return;
  }
  MAIL_ENABLED_ = false;
  withWrite_(() => seedDemoRows_());
  props.setProperty('DEMO_SEEDED', nowIso_());
  Logger.log('Demo data created. Open ?page=board&area=WH1');
}

/** ISO time `h` hours ago. */
function agoIso_(h) { return new Date(Date.now() - h * 3600000).toISOString(); }
/** 'yyyy-MM-dd' `d` days from today (negative = past). */
function dayRel_(d) { return addDaysStr_(todayStr_(), d); }

/** Inserts a demo row and back-dates its created_at. */
function seedInsert_(table, data, createdAt) {
  const row = dbInsert_(table, data);
  if (createdAt && SCHEMA[table].audit) { row.created_at = createdAt; row.updated_at = createdAt; }
  return row;
}

/** One demo QRAP with ①②③ filled. */
function seedQrap_(area, hoursAgo, f, alerts, ia) {
  const det = agoIso_(hoursAgo);
  const idInfo = nextQrapId_(area);
  const q = seedInsert_('QRAP', Object.assign({
    qrap_id: idInfo.id, area_code: area, level: 'AREA', seq: idInfo.seq, suffix: '', parent_id: '',
    status: ST.QR_OPEN, template_version: TEMPLATE_VERSION, safety: 'NE', detected_at: det,
    repeat_7d: 'NE', nok_situation: false, photo_exception: 'Demo data – bez fotek', s1_done_at: det,
    s2_done_at: det, s3_done_at: det, sent_at: agoIso_(hoursAgo - 0.2), locked_parts: '', archived: false,
    check_in_progress: false
  }, f), det);
  (alerts || []).forEach(code => seedInsert_('ALERT', { qrap_id: q.qrap_id, role_code: code, other_text: '',
    notified_to: ROUTING_KEYS.indexOf(code) >= 0 ? route_(area, code).join(', ') : '', notified_at: det, removed: false }, det));
  (ia || []).forEach(a => seedInsert_('IMMEDIATE_ACTION', { id: newId_('IA'), qrap_id: q.qrap_id, type: a[0], text: a[1],
    owner_name: a[2], owner_email: (personByName_(a[2]) || {}).email || '', done_at: a[3] === null ? '' : agoIso_(a[3]),
    status: a[3] === null ? 'OPEN' : 'DONE' }, det));
  return q;
}

function seedDecide_(q, decision, comment, hoursAgo, by) {
  const at = agoIso_(hoursAgo);
  Object.assign(q, { decision: decision, decision_comment: comment, decided_by: by, decided_at: at,
    locked_parts: 'QR,DECISION' });
}

function seedWhy_(q, chain, texts, root) {
  texts.forEach((t, i) => seedInsert_('WHY_STEP', { qrap_id: q.qrap_id, chain: chain, step: i + 1, text: t,
    is_root: root === i + 1 }));
}

function seedAction_(q, root, text, pilot, planned, done) {
  return seedInsert_('DEF_ACTION', { id: newId_('DA'), qrap_id: q.qrap_id, root_step: root, text: text,
    pilot_email: pilot, planned: planned, planned_first: planned, done: done || '', status: done ? 'CLOSED' : 'OPENED',
    evidence_url: '' });
}

function seedEff_(q, slot, day, shift, result) {
  seedInsert_('EFFECTIVENESS', { qrap_id: q.qrap_id, round: 1, slot: slot, shift_date: dayRel_(day), shift_code: shift,
    result: result, checked_by: 'Tomáš Dvořák', checked_at: agoIso_(-day * 24 + 1) });
}

function seedAssess_(q, who, hoursAgo, c, feedback, type) {
  seedInsert_('ASSESSMENT', { id: newId_('AS'), qrap_id: q.qrap_id, assessor: who, at: agoIso_(hoursAgo),
    c1: c[0], c2: c[1], c3: c[2], c4: c[3], c5: c[4], ojt_with: q.finder_name, feedback: feedback, feedback_type: type });
}

function seedShifts_(q, codes, hoursAgo, by) {
  codes.forEach(c => seedInsert_('SHIFT_INFO', { qrap_id: q.qrap_id, shift_code: c, informed_by: by,
    informed_at: agoIso_(hoursAgo) }));
}

/** The demo QRAPs themselves. */
function seedDemoRows_() {
  const sup1 = 'supervisor.wh1@example.com';
  const sup2 = 'supervisor.wh2@example.com';
  const TL1 = 'Tomáš Dvořák';

  // 1 · DRAFT – only step 1 saved
  seedQrap_('WH1', 0.3, { status: ST.DRAFT, what: 'Poškozená krabice na paletě při příjmu – promáčknutý roh',
    how_found: 'RECEIVING', zone: 'Příjem', location_code: 'P-01', qty: 2, unit: 'BOX', finder_name: 'Jan Novák',
    s2_done_at: '', s3_done_at: '', sent_at: '' });

  // 2 · QR_OPEN – ③ still open after 30 h (red chip 3)
  seedQrap_('WH1', 30, { what: 'Chybějící etiketa HU na paletě v regálu S-A02', how_found: 'STORAGE', zone: 'Sklad',
    location_code: 'S-A02', qty: 1, unit: 'PAL', finder_name: 'Petra Svobodová', material_no: '4711-123',
    risk_stock_shipped: 'ANO', check_in_progress: true, process_stopped: 'NE' }, ['TL', 'QUALITY'],
  [['BLOCK', 'Paleta zablokována ve WMS', TL1, 29], ['RELABEL', 'Přeetiketovat HU podle dodacího listu', TL1, null]]);

  // 3 · WAIT_DECISION – SAFETY
  const q3 = seedQrap_('WH1', 5, { what: 'Uvolněná stretch fólie na paletě ve 4. úrovni regálu – hrozí pád zboží',
    how_found: 'STORAGE', safety: 'ANO', zone: 'Sklad', location_code: 'S-B01', qty: 1, unit: 'PAL',
    finder_name: 'Jan Novák', risk_stock_shipped: 'NE', process_stopped: 'ANO', restored_at: agoIso_(3.9),
    status: ST.WAIT_DECISION, containment_done_at: agoIso_(3.9) }, ['TL', 'SUPERVISOR', 'MAINTENANCE'],
  [['BLOCK', 'Uzavřít uličku, paletu sundat VZV', TL1, 4.5], ['REPACK', 'Paletu přebalit a zajistit fólií', TL1, 4]]);
  seedShifts_(q3, ['R'], 3.5, sup1);

  // 4 · CLOSED_SOLVED
  const q4 = seedQrap_('WH1', 72, { what: 'Propíchnutá krabice vidlemi VZV při nakládce na rampě R-01',
    how_found: 'SHIP_CHECK', zone: 'Expedice / Rampa', location_code: 'R-01', qty: 1, unit: 'BOX',
    finder_name: 'Petra Svobodová', risk_stock_shipped: 'NE', process_stopped: 'NE', containment_done_at: agoIso_(71) },
  ['TL', 'SUPERVISOR'], [['REPACK', 'Zboží přebaleno do nové krabice', TL1, 71.5]]);
  seedDecide_(q4, 'SOLVED', 'Jednorázová chyba řidiče VZV, OJT provedeno na místě.', 70, sup1);
  Object.assign(q4, { status: ST.CLOSED_SOLVED, closed_by: sup1, closed_at: agoIso_(70) });
  seedShifts_(q4, ['R', 'O', 'N'], 70, sup1);
  seedAssess_(q4, sup1, 69, ['OK', 'OK', 'NOK', 'OK', 'OK'], 'Rychlé opatření. Příště nechat dobrý díl na tabuli.', 'IMPROVE');

  // 5 · ESCALATED + APU copy waiting for the APU manager
  const q5 = seedQrap_('WH1', 48, { what: 'Dodavatel dodal 3 palety s nesprávným počtem kusů (deklarováno 480, skutečně 440)',
    how_found: 'SUPPLIER_DELIVERY', zone: 'Příjem', location_code: 'P-02', qty: 3, unit: 'PAL', finder_name: 'Jan Novák',
    supplier: 'Dodavatel Příklad s.r.o.', hu_or_delivery_no: 'DL-2026-5512', material_no: '6600-410',
    risk_stock_shipped: 'ANO', checked_qty: 1320, wrong_found_qty: 120, process_stopped: 'NE',
    containment_done_at: agoIso_(46) }, ['TL', 'SUPERVISOR', 'QUALITY', 'PURCHASING'],
  [['BLOCK', 'Palety zablokovány v karanténě', TL1, 47], ['INFORM', 'Informován nákup a dodavatel', TL1, 46.5]]);
  const copy = escalateQrap_(q5);
  seedDecide_(q5, 'ESCALATE', 'Opakované problémy dodavatele, řešit na úrovni APU s nákupem.', 45, sup1);
  Object.assign(q5, { status: ST.ESCALATED, assign_ref: copy.qrap_id, closed_by: sup1, closed_at: agoIso_(45) });
  seedShifts_(q5, ['R', 'O', 'N'], 45, sup1);

  // 6 · ANALYSIS – repeat of #4, only 2 whys so far
  const q6 = seedQrap_('WH1', 24, { what: 'Znovu propíchnuté krabice při nakládce na rampě R-02 (4 ks)',
    how_found: 'SHIP_CHECK', zone: 'Expedice / Rampa', location_code: 'R-02', qty: 4, unit: 'BOX',
    finder_name: 'Petra Svobodová', repeat_7d: 'ANO', repeat_ref: q4.qrap_id, risk_stock_shipped: 'ANO',
    checked_qty: 36, wrong_found_qty: 4, process_stopped: 'ANO', restored_at: agoIso_(23), containment_done_at: agoIso_(23) },
  ['TL', 'SUPERVISOR', 'QUALITY'],
  [['HOLD_SHIP', 'Pozdržena expedice kamionu 2 hodiny', TL1, 23.5], ['REPACK', 'Přebaleno 4 krabice', TL1, 23.2]]);
  seedDecide_(q6, 'CONTINUE', 'Druhý případ za 3 dny + 4 NOK při kontrole.', 20, sup1);
  q6.status = ST.ANALYSIS;
  seedShifts_(q6, ['R', 'O', 'N'], 21, sup1);
  seedInsert_('PILOT', { qrap_id: q6.qrap_id, email: 'pilot1@example.com', assigned_by: sup1, assigned_at: agoIso_(20) });
  seedWhy_(q6, 'OCCURRENCE', ['Vidle VZV zajely do krabic ve spodní vrstvě palety.',
    'Řidič najížděl na paletu šikmo kvůli úzkému prostoru u rampy R-02.'], 0);

  // 7 · ACTIONS_OPEN – one action overdue, standard update = ANO
  const q7 = seedQrap_('WH1', 6 * 24, { what: 'Chybně naskladněné palety – lokace ve WMS neodpovídá fyzickému umístění',
    how_found: 'INVENTORY', zone: 'Sklad', location_code: 'S-A01', qty: 5, unit: 'PAL', finder_name: 'Jan Novák',
    material_no: '5520-300', risk_stock_shipped: 'ANO', checked_qty: 120, wrong_found_qty: 5, process_stopped: 'NE',
    containment_done_at: agoIso_(6 * 24 - 3), learned: '', std_update: 'ANO',
    std_update_ref: 'Pracovní instrukce WI-SKL-012 Naskladnění' }, ['TL', 'SUPERVISOR', 'QUALITY'],
  [['OTHER', 'Fyzická inventura uličky A', TL1, 6 * 24 - 2]]);
  seedDecide_(q7, 'CONTINUE', 'Systémový problém, nutná analýza.', 6 * 24 - 5, sup1);
  q7.status = ST.ACTIONS_OPEN;
  seedShifts_(q7, ['R', 'O', 'N'], 6 * 24 - 6, sup1);
  seedInsert_('PILOT', { qrap_id: q7.qrap_id, email: 'pilot2@example.com', assigned_by: sup1, assigned_at: agoIso_(140) });
  seedWhy_(q7, 'OCCURRENCE', ['Palety byly položeny na jinou lokaci, než potvrdil skener.',
    'Skladník potvrdil lokaci ze vzdálenosti bez skenu štítku lokace.',
    'WMS nevyžaduje sken štítku lokace při naskladnění.'], 3);
  seedWhy_(q7, 'NON_DETECTION', ['Chyba se projeví až při vychystávání nebo inventuře.',
    'Neexistuje denní kontrola obsazenosti lokací.'], 2);
  const a1 = seedAction_(q7, 'O3', 'Zapnout povinný sken štítku lokace při naskladnění ve WMS', 'pilot2@example.com', dayRel_(-3));
  seedAction_(q7, 'N2', 'Zavést denní namátkovou kontrolu 10 lokací', 'pilot1@example.com', dayRel_(5));
  seedAction_(q7, 'STD', 'Aktualizovat standard: Pracovní instrukce WI-SKL-012 Naskladnění', 'pilot2@example.com', dayRel_(10));
  seedInsert_('ACTION_NOTE', { id: newId_('AN'), action_id: a1.id, note: 'Čekáme na úpravu nastavení skenerů od IT.',
    review_date: dayRel_(0), review_done: false, author: 'pilot2@example.com', at: agoIso_(30) });
  seedAssess_(q7, 'manager@example.com', 2, ['OK', 'OK', 'NA', 'OK', 'NOK'], 'Dobrá analýza, chybí OJT se skladníkem.', 'IMPROVE');

  // 8 · VERIFY (WH2) – 3 of 5 shifts effective
  const q8 = seedQrap_('WH2', 10 * 24, { what: 'Nesprávné balení – chybí proložka mezi vrstvami, poškrábané díly',
    how_found: 'PACKING', zone: 'Balení', location_code: 'B-01', qty: 12, unit: 'PCS', finder_name: 'Milan Horák',
    material_no: '7788-001', risk_stock_shipped: 'ANO', checked_qty: 240, wrong_found_qty: 12, process_stopped: 'NE',
    containment_done_at: agoIso_(10 * 24 - 2), learned: 'Balicí předpis nebyl u balicího stolu B-01 vyvěšen.',
    std_update: 'NE' }, ['TL', 'SUPERVISOR', 'QUALITY'],
  [['REPACK', 'Přebaleno 240 ks s proložkou', 'Irena Malá', 10 * 24 - 1]]);
  seedDecide_(q8, 'CONTINUE', 'Riziko u zákazníka, nutná analýza.', 9 * 24, sup2);
  q8.status = ST.VERIFY;
  seedShifts_(q8, ['R', 'O', 'N'], 9 * 24, sup2);
  seedInsert_('PILOT', { qrap_id: q8.qrap_id, email: 'pilot2@example.com', assigned_by: sup2, assigned_at: agoIso_(9 * 24) });
  seedWhy_(q8, 'OCCURRENCE', ['Balič nevložil proložku mezi vrstvy.', 'Nevěděl, že materiál 7788-001 proložku vyžaduje.',
    'Balicí předpis nebyl u stolu B-01 k dispozici.'], 3);
  seedAction_(q8, 'O3', 'Vyvěsit balicí předpisy u všech balicích stolů', 'pilot2@example.com', dayRel_(-6), dayRel_(-5));
  seedEff_(q8, 1, -3, 'R', 'EFFECTIVE');
  seedEff_(q8, 2, -3, 'O', 'EFFECTIVE');
  seedEff_(q8, 3, -2, 'R', 'EFFECTIVE');

  // 9 · CLOSED (WH2) – full cycle
  const q9 = seedQrap_('WH2', 14 * 24, { what: 'Záměna materiálu při vychystávání – 4711-200 místo 4711-020',
    how_found: 'PICKING', zone: 'Vychystávání', location_code: 'V-02', qty: 6, unit: 'PCS', finder_name: 'Milan Horák',
    material_no: '4711-020', risk_stock_shipped: 'ANO', checked_qty: 60, wrong_found_qty: 0, process_stopped: 'NE',
    containment_done_at: agoIso_(14 * 24 - 2), learned: 'Podobná čísla materiálu v sousedních lokacích.',
    std_update: 'ANO', std_update_ref: 'WI-VYCH-004 Rozmístění materiálu' }, ['TL', 'SUPERVISOR', 'QUALITY'],
  [['OTHER', 'Zboží vyměněno před expedicí', 'Irena Malá', 14 * 24 - 1]]);
  seedDecide_(q9, 'CONTINUE', 'Riziko záměny u dalších materiálů.', 13 * 24, sup2);
  Object.assign(q9, { status: ST.CLOSED, closed_by: sup2, closed_at: agoIso_(24), locked_parts: 'QR,DECISION,ANALYSIS' });
  seedShifts_(q9, ['R', 'O', 'N'], 13 * 24, sup2);
  seedInsert_('PILOT', { qrap_id: q9.qrap_id, email: 'pilot1@example.com', assigned_by: sup2, assigned_at: agoIso_(13 * 24) });
  seedWhy_(q9, 'OCCURRENCE', ['Picker vzal materiál ze sousední lokace.', 'Materiály 4711-200 a 4711-020 leží vedle sebe.',
    'Rozmístění nebere ohled na podobná čísla materiálu.'], 3);
  seedAction_(q9, 'O3', 'Rozdělit podobná čísla materiálu do různých uliček', 'pilot1@example.com', dayRel_(-10), dayRel_(-9));
  seedAction_(q9, 'STD', 'Aktualizovat standard: WI-VYCH-004 Rozmístění materiálu', 'pilot1@example.com', dayRel_(-8), dayRel_(-8));
  [[-7, 'R'], [-7, 'O'], [-6, 'N'], [-5, 'R'], [-4, 'O']].forEach((x, i) => seedEff_(q9, i + 1, x[0], x[1], 'EFFECTIVE'));
  seedAssess_(q9, sup2, 13 * 24 - 2, ['OK', 'OK', 'OK', 'OK', 'OK'], 'Vzorový QRAP, sdílet na WH1.', 'PRAISE');
  seedAssess_(q9, 'manager@example.com', 20, ['OK', 'OK', 'OK', 'OK', 'OK'], 'Silná analýza rozmístění.', 'STRENGTH');
}
