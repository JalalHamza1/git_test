/**
 * Board.gs – the kiosk board: one row per QRAP, sorted by KDY ascending (newest at the bottom).
 *
 * All rows of an area are computed once and kept in CacheService for 60 seconds. Every write
 * (withWrite_) changes the global board version, which makes the cached rows invisible.
 */

const BOARD_TTL_SECONDS = 60;
const BOARD_FILTERS = ['open', 'today', 'safety', 'all'];

/**
 * Board rows for an area.
 * @param {{area:string, filter?:string, before?:string, limit?:number}} p
 *   before = key of the oldest row already shown (to load older rows when scrolling up)
 * @return {{ok, rows:Object[], hasMore:boolean, total:number, pending:number, area:string, at:string}}
 */
function apiGetBoard(p) {
  return apiRun_(() => {
    p = p || {};
    const area = up_(p.area);
    if (!areaByCode_(area)) fail_('E_AREA', { area: area });
    const filter = BOARD_FILTERS.indexOf(p.filter) >= 0 ? p.filter : 'open';
    const all = boardRowsCached_(area);
    let rows = all.filter(r => boardFilterMatch_(r, filter));
    const total = rows.length;
    if (p.before) rows = rows.filter(r => r.key < String(p.before));
    const limit = Math.min(Math.max(Number(p.limit) || 40, 5), 200);
    const hasMore = rows.length > limit;
    rows = rows.slice(-limit);
    const pending = all.filter(r => r.st === ST.DRAFT || r.st === ST.QR_OPEN).length;
    return { rows: rows, hasMore: hasMore, total: total, pending: pending, area: area, at: nowIso_() };
  });
}

function boardFilterMatch_(r, filter) {
  if (filter === 'today') return r.today;
  if (filter === 'safety') return r.safety;
  if (filter === 'all') return true;
  return r.open || r.recent; // 'open' = open + closed in the last BOARD_CLOSED_DAYS
}

/** Cached list of all non-archived board rows of an area. */
function boardRowsCached_(area) {
  const cache = CacheService.getScriptCache();
  const ver = cache.get('board_ver') || '0';
  const key = 'board_' + ver + '_' + area;
  const cached = cacheGetBig_(key);
  if (cached) return cached;
  const rows = buildBoardRows_(dbWhere_('QRAP', q => q.area_code === area && q.archived !== true));
  cachePutBig_(key, rows, BOARD_TTL_SECONDS);
  return rows;
}

/** Called after every write: old cached boards are no longer used. */
function invalidateBoardCache_() {
  try {
    CacheService.getScriptCache().put('board_ver', String(Date.now()), 21600);
  } catch (e) {
    console.warn('board cache invalidation failed: ' + e);
  }
}

/**
 * Builds board rows for a list of QRAP rows (bulk: every child tab is read once).
 * @param {Object[]} qraps
 * @return {Object[]} sorted by key (KDY, then number)
 */
function buildBoardRows_(qraps) {
  const g = {
    alerts: dbGroup_('ALERT', 'qrap_id'),
    why: dbGroup_('WHY_STEP', 'qrap_id'),
    actions: dbGroup_('DEF_ACTION', 'qrap_id'),
    assess: dbGroup_('ASSESSMENT', 'qrap_id')
  };
  const now = new Date();
  const ctx = {
    now: now,
    today: todayStr_(now),
    closedSince: now.getTime() - cfgNum_('BOARD_CLOSED_DAYS') * 24 * 3600000
  };
  return qraps.map(q => boardRow_(q, g, ctx)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One board row (short, plain values only). */
function boardRow_(q, g, ctx) {
  const id = q.qrap_id;
  const c = {
    alerts: (g.alerts[id] || []).filter(a => a.removed !== true),
    why: g.why[id] || [],
    actions: (g.actions[id] || []).filter(a => a.status !== 'REMOVED'),
    assess: g.assess[id] || []
  };
  const chips = computeChips_(q, c, ctx.now);
  const when = q.detected_at || q.created_at || '';
  const final = FINAL_STATES.indexOf(q.status) >= 0;
  return {
    id: id,
    key: when + '|' + id,
    area: q.area_code,
    level: q.level,
    what: truncate_(q.what, 110),
    zone: q.zone,
    loc: q.location_code,
    det: q.detected_at,
    st: q.status,
    safety: q.safety === 'ANO',
    rep: q.repeat_7d === 'ANO',
    chips: chips,
    wait: waitingFor_(q),
    late: chips.indexOf('late') >= 0,
    open: !final,
    recent: final && !!q.closed_at && new Date(q.closed_at).getTime() >= ctx.closedSince,
    today: !!when && todayStr_(new Date(when)) === ctx.today,
    parent: q.parent_id,
    copy: q.assign_ref
  };
}
