/**
 * Task Manager — projects, milestones, notes, status updates and blocking.
 * ---------------------------------------------------------------------------
 * Tasks still live in the "Tasks" sheet and point at their list or project by
 * name (the "List" column), so renaming works the same way for both. Everything
 * else lives in one small sheet per kind, stored as plain text, one row per record.
 */

const PROJECTS_MIGRATED_KEY = 'projectsMigrated';
const PROJECT_STATUSES = ['active', 'blocked', 'planned', 'paused', 'done'];
const NOTE_TYPES = ['meeting', 'decision', 'reference'];
const HEALTHS = ['green', 'amber', 'red'];
const BLOCK_LOG_MAX = 20;
// A Sheets cell holds 50,000 characters. Formatted note text spills into Body 2–4, so a note can be up to 180,000.
const CELL_CHUNK = 45000;
const NOTE_MAX = CELL_CHUNK * 4;

const TABLES = {
  project: {
    sheet: 'Projects',
    fields: ['id', 'name', 'color', 'status', 'priority', 'goal', 'start', 'target', 'order', 'created', 'closed', 'outcome',
      'blockReason', 'blockedBy', 'blockedSince', 'waiting', 'waitingSince', 'blockLog', 'updated'],
    json: { blockLog: [] }, lists: ['blockedBy'], nums: ['priority', 'order'],
  },
  milestone: {
    sheet: 'Milestones',
    fields: ['id', 'projectId', 'name', 'target', 'done', 'order', 'eventId'],
    json: {}, lists: [], nums: ['order'],
  },
  note: {
    sheet: 'Notes',
    fields: ['id', 'projectId', 'type', 'title', 'body', 'pinned', 'created', 'updated', 'made', 'body2', 'body3', 'body4'],
    json: { made: {} }, lists: [], nums: [], bools: ['pinned'], chunks: { body: ['body2', 'body3', 'body4'] },
  },
  update: {
    sheet: 'Updates',
    fields: ['id', 'projectId', 'date', 'health', 'text', 'progress'],
    json: {}, lists: [], nums: ['progress'],
  },
};

/*** ===== TABLE STORAGE ===== ***/
function humanize_(f) {
  return f.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).replace(/\bId\b/g, 'ID');
}

function table_(kind) {
  const key = 'tbl_' + kind;
  if (_cache[key]) return _cache[key];
  const def = TABLES[kind], ss = ss_(), n = def.fields.length;
  let sh = ss.getSheetByName(def.sheet);
  if (!sh) {
    sh = ss.insertSheet(def.sheet);
    if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
    sh.getRange(1, 1, 1, n).setValues([def.fields.map(humanize_)])
      .setFontWeight('bold').setBackground('#0d1117').setFontColor('#58a6ff');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, Math.max(1, sh.getMaxRows() - 1), n).setNumberFormat('@');
  } else if (props_().getProperty('hdr_' + kind) !== String(n)) {
    // Sheets made by an older version get headers for columns added since (e.g. Body 2–4 on Notes).
    if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
    const head = sh.getRange(1, 1, 1, n).getValues()[0], want = def.fields.map(humanize_);
    const clash = head.findIndex((h, i) => h !== '' && h !== want[i]);
    if (clash >= 0) {
      throw new Error(`Column ${colLetter_(clash + 1)} of the "${def.sheet}" sheet holds "${head[clash]}" but Task Manager needs "${want[clash]}" there. ` +
        `Move your own columns past column ${colLetter_(n)}, then reopen Task Manager.`);
    }
    head.forEach((h, i) => { if (h === '') sh.getRange(1, i + 1).setValue(want[i]).setFontWeight('bold').setBackground('#0d1117').setFontColor('#58a6ff'); });
    props_().setProperty('hdr_' + kind, String(n));
  }
  const last = sh.getLastRow();
  const vals = last < 2 ? [] : sh.getRange(2, 1, last - 1, n).getDisplayValues();
  const rows = [];
  vals.forEach((v, i) => { if (String(v[0]).trim()) rows.push({ rec: fromRow_(def, v), row: i + 2 }); });
  return (_cache[key] = { def: def, sh: sh, rows: rows });
}

function chunkFields_(def) {
  const out = new Set();
  Object.keys(def.chunks || {}).forEach(f => { out.add(f); def.chunks[f].forEach(c => out.add(c)); });
  return out;
}

function fromRow_(def, v) {
  const o = {}, keepSpaces = chunkFields_(def);
  def.fields.forEach((f, i) => {
    const raw = keepSpaces.has(f) ? String(v[i] == null ? '' : v[i]) : String(v[i] == null ? '' : v[i]).trim();
    if (f in def.json) {
      const parsed = parse_(raw);
      o[f] = parsed && typeof parsed === 'object' ? parsed : JSON.parse(JSON.stringify(def.json[f]));
    } else if (def.lists.includes(f)) o[f] = idList_(raw);
    else if ((def.bools || []).includes(f)) o[f] = truthy_(raw);
    else if (def.nums.includes(f)) o[f] = raw === '' || isNaN(Number(raw)) ? '' : Number(raw);
    else o[f] = raw;
  });
  Object.keys(def.chunks || {}).forEach(f => {
    o[f] = [o[f]].concat(def.chunks[f].map(c => o[c])).join('');
    def.chunks[f].forEach(c => { delete o[c]; });
  });
  return o;
}

function toRow_(def, o) {
  const parts = {};
  Object.keys(def.chunks || {}).forEach(f => {
    const s = String(o[f] == null ? '' : o[f]);
    [f].concat(def.chunks[f]).forEach((c, i) => { parts[c] = s.slice(i * CELL_CHUNK, (i + 1) * CELL_CHUNK); });
  });
  return def.fields.map(f => {
    if (f in parts) return parts[f];
    const v = o[f];
    if (f in def.json) return JSON.stringify(v || def.json[f]);
    if (def.lists.includes(f)) return (v || []).join(',');
    if ((def.bools || []).includes(f)) return v ? 'TRUE' : '';
    return v == null ? '' : String(v);
  });
}

function all_(kind) {
  return table_(kind).rows.map(x => x.rec);
}

function get_(kind, id) {
  const e = table_(kind).rows.find(x => x.rec.id === String(id));
  return e ? e.rec : null;
}

function put_(kind, rec) {
  const t = table_(kind), vals = [toRow_(t.def, rec)];
  let e = t.rows.find(x => x.rec.id === rec.id);
  if (e) e.rec = rec;
  else {
    const used = t.rows.reduce((m, x) => Math.max(m, x.row), t.sh.getLastRow());
    e = { rec: rec, row: used + 1 };
    if (e.row > t.sh.getMaxRows()) t.sh.insertRowsAfter(t.sh.getMaxRows(), 50);
    t.rows.push(e);
  }
  t.sh.getRange(e.row, 1, 1, vals[0].length).setNumberFormat('@').setValues(vals);
  if (kind === 'project') delete _cache.pnames;
  return rec;
}

function drop_(kind, ids) {
  const t = table_(kind), set = new Set(ids.map(String));
  const rows = t.rows.filter(x => set.has(x.rec.id)).map(x => x.row).sort((a, b) => b - a);
  if (!rows.length) return;
  if (rows.length >= t.sh.getMaxRows() - 1) t.sh.insertRowsAfter(t.sh.getMaxRows(), 1);
  rows.forEach(r => t.sh.deleteRow(r));
  delete _cache['tbl_' + kind];
  if (kind === 'project') delete _cache.pnames;
}

function projectData_() {
  return { projects: all_('project'), milestones: all_('milestone'), notes: all_('note'), updates: all_('update') };
}

function projectNames_() {
  return _cache.pnames || (_cache.pnames = new Set(all_('project').map(p => p.name)));
}

function projectByName_(name) {
  return all_('project').find(p => p.name === name) || null;
}

function nameTaken_(name, exceptId) {
  const n = String(name).toLowerCase();
  return all_('project').some(p => p.id !== exceptId && p.name.toLowerCase() === n);
}

function todayIso_() {
  return isoDate_(new Date());
}

function cleanText_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function cleanDate_(v) {
  const s = String(v || '').trim();
  if (s && !validIso_(s)) throw new Error('That date isn\'t valid.');
  return s;
}

function validId_(id, what) {
  id = String(id || '').trim();
  if (!ID_RE.test(id)) throw new Error(`Invalid ${what} id.`);
  return id;
}

/*** ===== MIGRATION: "Project - X" lists become projects ===== ***/
function migrateProjects_() {
  table_('project'); table_('milestone'); table_('note'); table_('update');
  const g = grid_(), stored = storedLists_();
  const names = new Set(stored.map(l => l.name));
  g.forEach(r => { if (isTask_(r)) names.add(listOf_(r)); });
  const taken = new Set([...names].map(n => n.toLowerCase()));
  all_('project').forEach(p => taken.add(p.name.toLowerCase()));
  let order = all_('project').length;
  [...names].filter(n => CONFIG.PROJECT_PREFIX.test(n) && !projectNames_().has(n)).forEach(oldName => {
    let name = oldName.replace(CONFIG.PROJECT_PREFIX, '').trim() || oldName;
    if (name !== oldName && taken.has(name.toLowerCase())) name = oldName;
    taken.add(name.toLowerCase());
    let start = '';
    g.forEach((r, i) => {
      if (!isTask_(r) || listOf_(r) !== oldName) return;
      const c = isoDate_(r[C.CREATED]);
      if (c && (!start || c < start)) start = c;
      if (name !== oldName) { r[C.LIST] = name; touch_(i); }
    });
    const list = stored.find(l => l.name === oldName);
    put_('project', newProject_({
      id: 'p' + Utilities.getUuid().replace(/-/g, '').slice(0, 9), name: name,
      color: (list && list.color) || 'BLUE', start: start || todayIso_(), order: order++,
    }));
  });
  saveLists_(stored.filter(l => !CONFIG.PROJECT_PREFIX.test(l.name) && !projectNames_().has(l.name)));
  flush_();
  props_().setProperty(PROJECTS_MIGRATED_KEY, '1');
}

function newProject_(o) {
  return Object.assign({
    id: '', name: '', color: 'BLUE', status: 'active', priority: 2, goal: '', start: todayIso_(), target: '', order: 0,
    created: new Date().toISOString(), closed: '', outcome: '', blockReason: '', blockedBy: [], blockedSince: '',
    waiting: '', waitingSince: '', blockLog: [], updated: new Date().toISOString(),
  }, o);
}

/*** ===== PROJECTS ===== ***/
// Creates a project when `create` is set; otherwise updates only the fields present.
function saveProject(input) {
  guard_();
  const p = input || {};
  const id = validId_(p.id, 'project');
  return withLock_(() => {
    const cur = get_('project', id);
    if (!cur && !p.create) throw new Error('Project not found. It may have been deleted — refresh to see the latest.');
    const rec = cur ? Object.assign({}, cur) : newProject_({ id: id, order: all_('project').length });
    const changed = [];
    if ('name' in p || !cur) {
      const name = cleanListName_(p.name);
      if (name !== rec.name) {
        if (nameTaken_(name, id) || lists_().some(l => l.name.toLowerCase() === name.toLowerCase())) {
          throw new Error('A list or project already has that name.');
        }
        if (cur) {
          grid_().forEach((r, i) => {
            if (isTask_(r) && listOf_(r) === rec.name) { r[C.LIST] = name; touch_(i); changed.push(i); }
          });
        }
        rec.name = name;
      }
    }
    if ('color' in p && COLORS.includes(p.color)) rec.color = p.color;
    if ('priority' in p && [1, 2, 3].includes(Number(p.priority))) rec.priority = Number(p.priority);
    if ('goal' in p) rec.goal = cleanText_(p.goal, 5000);
    if ('start' in p) rec.start = cleanDate_(p.start);
    if ('target' in p) rec.target = cleanDate_(p.target);
    if ('order' in p && isFinite(Number(p.order))) rec.order = Number(p.order);
    if ('outcome' in p) rec.outcome = cleanText_(p.outcome, 2000);
    const was = rec.status;
    // "blocked" comes from blockProject so it always has a reason; any other status is allowed here.
    if ('status' in p && PROJECT_STATUSES.includes(p.status) && p.status !== 'blocked' && p.status !== was) {
      if (was === 'blocked') clearProjectBlock_(rec, 'Unblocked by hand');
      rec.status = p.status;
      if (p.status === 'done') rec.closed = todayIso_();
      else rec.closed = '';
      if (p.status === 'active' && was === 'planned') rec.start = todayIso_();
    }
    rec.updated = new Date().toISOString();
    put_('project', rec);
    if (rec.status !== was || (cur && rec.name !== cur.name)) {
      all_('milestone').filter(m => m.projectId === id).forEach(syncMilestoneSafe_);
    }
    if (changed.length) calendarAfter_(changed, false);
    flush_();
    return out_(changed, { projects: [rec], milestones: all_('milestone').filter(m => m.projectId === id) });
  });
}

// Its tasks go to Trash (like deleting a list); milestones, notes and updates are removed.
function deleteProject(id) {
  guard_();
  id = validId_(id, 'project');
  return withLock_(() => {
    const p = get_('project', id);
    if (!p) return { gone: { projects: [id] } };
    const changed = [];
    grid_().forEach((r, i) => {
      if (isTask_(r) && listOf_(r) === p.name && arch_(r) !== 'Deleted') { r[C.ARCH] = 'Deleted'; touch_(i); changed.push(i); }
    });
    const ms = all_('milestone').filter(m => m.projectId === id);
    ms.forEach(m => { if (m.eventId) { try { deleteEvent_(getCalendar_(), m.eventId); } catch (e) {} } });
    const notes = all_('note').filter(n => n.projectId === id).map(n => n.id);
    const ups = all_('update').filter(u => u.projectId === id).map(u => u.id);
    drop_('milestone', ms.map(m => m.id));
    drop_('note', notes);
    drop_('update', ups);
    drop_('project', [id]);
    calendarAfter_(changed, true);
    flush_();
    return out_(changed, { gone: { projects: [id], milestones: ms.map(m => m.id), notes: notes, updates: ups } });
  });
}

// Turns an existing list into a project. Tasks keep pointing at the same name.
function convertListToProject(name, id) {
  guard_();
  name = cleanListName_(name);
  id = validId_(id, 'project');
  if (name === CONFIG.DEFAULT_LIST) throw new Error('The default list can\'t become a project.');
  return withLock_(() => {
    if (projectNames_().has(name)) throw new Error('That is already a project.');
    if (get_('project', id)) throw new Error('That project id is already used.');
    const stored = storedLists_(), list = stored.find(l => l.name === name);
    let start = '';
    grid_().forEach(r => {
      if (!isTask_(r) || listOf_(r) !== name) return;
      const c = isoDate_(r[C.CREATED]);
      if (c && (!start || c < start)) start = c;
    });
    const rec = put_('project', newProject_({
      id: id, name: name, color: (list && list.color) || CONFIG.LIST_COLORS[name] || 'BLUE',
      start: start || todayIso_(), order: all_('project').length,
    }));
    saveLists_(stored.filter(l => l.name !== name));
    return { projects: [rec], lists: lists_() };
  });
}

/*** ===== MILESTONES ===== ***/
function saveMilestone(input) {
  guard_();
  const p = input || {};
  const id = validId_(p.id, 'milestone');
  return withLock_(() => {
    const cur = get_('milestone', id);
    if (!cur && !p.create) throw new Error('Milestone not found. Refresh to see the latest.');
    const m = cur ? Object.assign({}, cur) : { id: id, projectId: '', name: '', target: '', done: '', order: 0, eventId: '' };
    if (!cur) {
      const pid = validId_(p.projectId, 'project');
      if (!get_('project', pid)) throw new Error('That project no longer exists.');
      m.projectId = pid;
      m.order = all_('milestone').filter(x => x.projectId === pid).length;
    }
    if ('name' in p || !cur) {
      m.name = cleanTitle_(p.name).slice(0, 120);
      if (!m.name) throw new Error('Milestone name is required.');
    }
    if ('target' in p) m.target = cleanDate_(p.target);
    if ('done' in p) m.done = cleanDate_(p.done);
    if ('order' in p && isFinite(Number(p.order))) m.order = Number(p.order);
    put_('milestone', m);
    syncMilestoneSafe_(m);
    return { milestones: [m] };
  });
}

function deleteMilestone(id) {
  guard_();
  id = validId_(id, 'milestone');
  return withLock_(() => {
    const m = get_('milestone', id);
    if (!m) return { gone: { milestones: [id] } };
    const changed = [];
    grid_().forEach((r, i) => { if (str_(r[C.MILESTONE]) === id) { r[C.MILESTONE] = ''; touch_(i); changed.push(i); } });
    if (m.eventId) { try { deleteEvent_(getCalendar_(), m.eventId); } catch (e) {} }
    drop_('milestone', [id]);
    flush_();
    return out_(changed, { gone: { milestones: [id] } });
  });
}

/*** ===== NOTES & STATUS UPDATES ===== ***/
function saveNote(input) {
  guard_();
  const p = input || {};
  const id = validId_(p.id, 'note');
  return withLock_(() => {
    const cur = get_('note', id);
    if (!cur && !p.create) throw new Error('Note not found. It may have been deleted — refresh to see the latest.');
    const now = new Date().toISOString();
    const n = cur ? Object.assign({}, cur) : { id: id, projectId: '', type: 'reference', title: '', body: '', pinned: false, created: now, updated: now, made: {} };
    if (!cur) {
      n.projectId = validId_(p.projectId, 'project');
      if (!get_('project', n.projectId)) throw new Error('That project no longer exists.');
    }
    if ('type' in p && NOTE_TYPES.includes(p.type)) n.type = p.type;
    if ('title' in p) n.title = cleanTitle_(p.title).slice(0, 200);
    if ('body' in p) {
      const body = String(p.body == null ? '' : p.body);
      // Formatted notes are stored as JSON, so cutting them short would break them: refuse instead.
      if (body.length > NOTE_MAX) throw new Error('This note is too long to save. Split it into two notes.');
      n.body = body;
    }
    if ('pinned' in p) n.pinned = !!p.pinned;
    if ('made' in p && p.made && typeof p.made === 'object') {
      const made = {};
      Object.keys(p.made).slice(0, 200).forEach(k => { if (/^\d+$/.test(k) && ID_RE.test(String(p.made[k]))) made[k] = String(p.made[k]); });
      n.made = made;
    }
    n.updated = now;
    put_('note', n);
    return { notes: [n] };
  });
}

function deleteNote(id) {
  guard_();
  id = validId_(id, 'note');
  return withLock_(() => { drop_('note', [id]); return { gone: { notes: [id] } }; });
}

function postUpdate(input) {
  guard_();
  const p = input || {};
  const id = validId_(p.id, 'update'), pid = validId_(p.projectId, 'project');
  const text = cleanText_(p.text, 2000);
  if (!text) throw new Error('Write a sentence or two for the update.');
  if (!HEALTHS.includes(p.health)) throw new Error('Pick a health for the update.');
  return withLock_(() => {
    if (!get_('project', pid)) throw new Error('That project no longer exists.');
    const u = { id: id, projectId: pid, date: todayIso_(), health: p.health, text: text,
      progress: isFinite(Number(p.progress)) ? Math.max(0, Math.min(100, Math.round(Number(p.progress)))) : '' };
    put_('update', u);
    return { updates: [u] };
  });
}

/*** ===== BLOCKING ===== ***/
// spec: { reason, waiting, blockers: [task ids], create: [{ id, title }], milestone }
function cleanBlockSpec_(spec) {
  spec = spec || {};
  const reason = cleanText_(spec.reason, 500);
  if (!reason) throw new Error('Say why it\'s blocked.');
  const create = (Array.isArray(spec.create) ? spec.create : []).slice(0, 10).map(c => ({
    id: validId_(c && c.id, 'task'), title: cleanTitle_(c && c.title),
  })).filter(c => c.title);
  return {
    reason: reason, waiting: cleanText_(spec.waiting, 100), create: create,
    blockers: (Array.isArray(spec.blockers) ? spec.blockers : []).map(String).filter(x => ID_RE.test(x)),
    milestone: cleanText_(spec.milestone, 40),
  };
}

// Would `target` waiting on `blocker` make a loop (the blocker already waits on target)?
function wouldLoop_(target, blocker) {
  const g = grid_(), seen = new Set(), stack = [blocker];
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const i = find_(id);
    if (i >= 0) stack.push(...idList_(g[i][C.BLOCKED_BY]));
  }
  return false;
}

function addUnblockTasks_(spec, list, milestone, order, priority) {
  const ids = [], idxs = [], now = new Date();
  spec.create.forEach((c, n) => {
    if (find_(c.id) >= 0) throw new Error('That task id is already used.');
    const row = blankRow_();
    row[C.ID] = c.id;
    row[C.TITLE] = c.title;
    row[C.STATUS] = 'Not started';
    row[C.PRIORITY] = priority || 'Medium';
    row[C.LIST] = list;
    row[C.MILESTONE] = milestone || '';
    row[C.ORDER] = order - (spec.create.length - n) * 0.01;
    row[C.CREATED] = now;
    row[C.UPDATED] = now;
    row[C.SIZE] = 1;
    idxs.push(appendRow_(row));
    ids.push(c.id);
  });
  return { ids: ids, idxs: idxs };
}

function blockTask(id, specIn) {
  guard_();
  const spec = cleanBlockSpec_(specIn);
  return withLock_(() => {
    const g = grid_(), i = must_(id), r = g[i];
    if (arch_(r)) throw new Error('Completed or deleted tasks can\'t be blocked.');
    const made = addUnblockTasks_(spec, listOf_(r), str_(r[C.MILESTONE]), orderOf_(r, i), r[C.PRIORITY]);
    const blockers = [...new Set(spec.blockers.concat(made.ids))].filter(b => b !== id && find_(b) >= 0 && !wouldLoop_(id, b));
    applyBlock_(r, spec, blockers);
    touch_(i);
    calendarAfter_([i], false);
    flush_();
    return out_([i].concat(made.idxs));
  });
}

function applyBlock_(r, spec, blockers) {
  const now = new Date();
  if (r[C.STATUS] !== 'Blocked') r[C.BLOCKED_SINCE] = now;
  r[C.STATUS] = 'Blocked';
  r[C.BLOCK_REASON] = spec.reason;
  r[C.BLOCKED_BY] = blockers.join(',');
  if (spec.waiting !== str_(r[C.WAITING])) r[C.WAIT_SINCE] = spec.waiting ? now : '';
  r[C.WAITING] = spec.waiting;
  r[C.UPDATED] = now;
}

function blockProject(id, specIn) {
  guard_();
  const spec = cleanBlockSpec_(specIn);
  id = validId_(id, 'project');
  return withLock_(() => {
    const rec = Object.assign({}, get_('project', id) || {});
    if (!rec.id) throw new Error('Project not found. It may have been deleted — refresh to see the latest.');
    if (rec.status === 'done') throw new Error('Reopen the project before marking it blocked.');
    const made = addUnblockTasks_(spec, rec.name, spec.milestone, topOrder_(rec.name, '', -1), 'High');
    const blockers = [...new Set(spec.blockers.concat(made.ids))].filter(b => find_(b) >= 0);
    const now = new Date().toISOString();
    if (rec.status !== 'blocked') rec.blockedSince = now;
    rec.status = 'blocked';
    rec.blockReason = spec.reason;
    rec.blockedBy = blockers;
    if (spec.waiting !== rec.waiting) rec.waitingSince = spec.waiting ? now : '';
    rec.waiting = spec.waiting;
    rec.updated = now;
    put_('project', rec);
    flush_();
    return out_(made.idxs, { projects: [rec] });
  });
}

function logBlock_(log, reason, since, how) {
  const out = (Array.isArray(log) ? log : []).concat({ reason: reason, from: since, to: new Date().toISOString(), how: how });
  return out.slice(-BLOCK_LOG_MAX);
}

// Moves the current block into the task's history and clears it. The caller sets the new status.
function clearBlock_(r, how) {
  if (!str_(r[C.BLOCK_REASON]) && !str_(r[C.BLOCKED_BY]) && !str_(r[C.WAITING])) return;
  r[C.BLOCK_LOG] = JSON.stringify(logBlock_(parse_(r[C.BLOCK_LOG]), str_(r[C.BLOCK_REASON]), stamp_(r[C.BLOCKED_SINCE]), how));
  [C.BLOCK_REASON, C.BLOCKED_BY, C.BLOCKED_SINCE, C.WAITING, C.WAIT_SINCE].forEach(c => { r[c] = ''; });
}

function clearProjectBlock_(rec, how) {
  rec.blockLog = logBlock_(rec.blockLog, rec.blockReason, rec.blockedSince, how);
  rec.blockReason = ''; rec.blockedBy = []; rec.blockedSince = ''; rec.waiting = ''; rec.waitingSince = '';
  rec.status = 'active';
}

function blockersCleared_(ids) {
  const g = grid_();
  return ids.every(b => { const k = find_(b); return k < 0 || !!arch_(g[k]); });
}

function unblockTask(id) {
  guard_();
  return withLock_(() => {
    const g = grid_(), i = must_(id), r = g[i];
    if (r[C.STATUS] === 'Blocked') {
      clearBlock_(r, 'Unblocked by hand');
      r[C.STATUS] = 'Not started';
      r[C.UPDATED] = new Date();
      touch_(i);
      calendarAfter_([i], false);
      flush_();
    }
    return out_([i]);
  });
}

function unblockProject(id) {
  guard_();
  id = validId_(id, 'project');
  return withLock_(() => {
    const rec = Object.assign({}, get_('project', id) || {});
    if (!rec.id) throw new Error('Project not found.');
    if (rec.status === 'blocked') { clearProjectBlock_(rec, 'Unblocked by hand'); rec.updated = new Date().toISOString(); put_('project', rec); }
    return { projects: [rec] };
  });
}

// "It arrived": stop waiting on a person. Unblocks when nothing else is still open.
function clearWaiting(kind, id) {
  guard_();
  return withLock_(() => {
    if (kind === 'project') {
      const rec = Object.assign({}, get_('project', validId_(id, 'project')) || {});
      if (!rec.id) throw new Error('Project not found.');
      const who = rec.waiting;
      rec.waiting = ''; rec.waitingSince = '';
      if (rec.status === 'blocked' && who && blockersCleared_(rec.blockedBy)) clearProjectBlock_(rec, `${who} came through`);
      rec.updated = new Date().toISOString();
      put_('project', rec);
      return { projects: [rec] };
    }
    const g = grid_(), i = must_(id), r = g[i], who = str_(r[C.WAITING]);
    r[C.WAITING] = ''; r[C.WAIT_SINCE] = '';
    if (r[C.STATUS] === 'Blocked' && who && blockersCleared_(idList_(r[C.BLOCKED_BY]))) {
      r[C.WAITING] = who;
      clearBlock_(r, `${who} came through`);
      r[C.STATUS] = 'Not started';
    }
    r[C.UPDATED] = new Date();
    touch_(i);
    calendarAfter_([i], false);
    flush_();
    return out_([i]);
  });
}

// "I followed up": restarts the waiting clock.
function followUp(kind, id) {
  guard_();
  return withLock_(() => {
    const now = new Date();
    if (kind === 'project') {
      const rec = Object.assign({}, get_('project', validId_(id, 'project')) || {});
      if (!rec.id) throw new Error('Project not found.');
      if (rec.waiting) rec.waitingSince = now.toISOString();
      put_('project', rec);
      return { projects: [rec] };
    }
    const g = grid_(), i = must_(id), r = g[i];
    if (r[C.WAITING]) { r[C.WAIT_SINCE] = now; r[C.UPDATED] = now; touch_(i); flush_(); }
    return out_([i]);
  });
}

/*** ===== WHAT HAPPENS WHEN TASKS FINISH OR COME BACK ===== ***/
// `finished` are row indexes just completed or deleted. Unblocks whatever was waiting on them
// (tasks and projects) and marks a milestone reached when its last task is completed.
// Adds changed task rows to `changed` and returns the projects/milestones it touched.
function afterFinished_(finished, changed) {
  const g = grid_(), extra = { projects: [], milestones: [] };
  if (!finished.length) return extra;
  const fin = new Set(finished.map(i => str_(g[i][C.ID])));
  g.forEach((r, k) => {
    if (!isTask_(r) || arch_(r) || r[C.STATUS] !== 'Blocked' || r[C.WAITING]) return;
    const ids = idList_(r[C.BLOCKED_BY]);
    if (!ids.some(x => fin.has(x)) || !blockersCleared_(ids)) return;
    clearBlock_(r, 'Unblocked when its tasks were done');
    r[C.STATUS] = 'Not started';
    r[C.UPDATED] = new Date();
    touch_(k);
    changed.push(k);
  });
  all_('project').forEach(p0 => {
    if (p0.status !== 'blocked' || p0.waiting || !p0.blockedBy.some(x => fin.has(x)) || !blockersCleared_(p0.blockedBy)) return;
    const p = Object.assign({}, p0);
    clearProjectBlock_(p, 'Unblocked when its tasks were done');
    p.updated = new Date().toISOString();
    put_('project', p);
    extra.projects.push(p);
  });
  const ms = all_('milestone');
  finished.forEach(i => {
    const r = g[i], mid = str_(r[C.MILESTONE]);
    if (!mid || arch_(r) !== 'Completed') return;
    const m0 = ms.find(x => x.id === mid);
    if (!m0 || m0.done) return;
    if (g.some(x => isTask_(x) && str_(x[C.MILESTONE]) === mid && !arch_(x))) return;
    const m = Object.assign({}, m0, { done: todayIso_() });
    put_('milestone', m);
    syncMilestoneSafe_(m);
    m0.done = m.done;
    extra.milestones.push(m);
  });
  return extra;
}

// A restored task reopens its milestone if that milestone was marked reached.
function reopenMilestones_(idxs) {
  const g = grid_(), extra = { milestones: [] };
  idxs.forEach(i => {
    const mid = str_(g[i][C.MILESTONE]);
    if (!mid || arch_(g[i])) return;
    const m0 = get_('milestone', mid);
    if (!m0 || !m0.done) return;
    const m = Object.assign({}, m0, { done: '' });
    put_('milestone', m);
    syncMilestoneSafe_(m);
    extra.milestones.push(m);
  });
  return extra;
}

/*** ===== MILESTONES ON THE CALENDAR ===== ***/
function syncMilestone_(m) {
  const p = get_('project', m.projectId);
  const want = p && (p.status === 'active' || p.status === 'blocked') && validIso_(m.target) && !m.done;
  const cal = getCalendar_();
  if (!want) {
    if (!m.eventId) return '';
    deleteEvent_(cal, m.eventId);
    m.eventId = '';
    return 'removed';
  }
  const day = new Date(m.target + 'T12:00:00'), title = `◆ [${p.name}] ${m.name}`;
  let ev = null;
  if (m.eventId) { try { ev = cal.getEventById(m.eventId); } catch (e) { ev = null; } }
  if (ev) {
    const same = ev.getTitle() === title && isoDate_(ev.getAllDayStartDate()) === m.target;
    if (same) return 'unchanged';
    if (ev.getTitle() !== title) ev.setTitle(title);
    ev.setAllDayDate(day);
    return 'updated';
  }
  ev = cal.createAllDayEvent(title, day, { description: `Milestone of ${p.name}.\nManaged by Task Manager — edit in the app, not here.` });
  ev.setTag(CONFIG.TAG_KEY, m.id);
  ev.addPopupReminder(CONFIG.ALLDAY_REMINDER_MINUTES);
  try { ev.setColor(colorFor_(p.name)); } catch (e) {}
  m.eventId = ev.getId();
  return 'created';
}

// Keeps existing milestone events current; creates new ones only when auto-sync is on.
function syncMilestoneSafe_(m) {
  if (!m.eventId && !userSettings_().autoSync) return;
  try {
    const before = m.eventId;
    syncMilestone_(m);
    if (m.eventId !== before) put_('milestone', m);
  } catch (e) { console.warn('Calendar sync failed for milestone ' + m.id + ': ' + e); }
}

function syncAllMilestones_() {
  const res = { created: 0, updated: 0, removed: 0, failed: 0 };
  all_('milestone').forEach(m0 => {
    const m = Object.assign({}, m0);
    try {
      const kind = syncMilestone_(m);
      if (kind && kind !== 'unchanged') { res[kind]++; put_('milestone', m); }
    } catch (e) {
      res.failed++;
      console.warn('Sync failed for milestone ' + m.id + ': ' + e);
    }
  });
  return res;
}

/*** ===== DIGEST: projects that need a look ===== ***/
function projectAttention_(active, today) {
  const out = [], days = s => s ? Math.floor((new Date(today + 'T12:00:00') - new Date(s)) / 864e5) : 0;
  const ms = all_('milestone');
  all_('project').filter(p => p.status === 'active' || p.status === 'blocked').forEach(p => {
    const add = (level, text) => out.push({ project: p.name, level: level, text: text });
    if (p.status === 'blocked') add(days(p.blockedSince) > 7 ? 'red' : 'amber', `Blocked: ${p.blockReason || 'no reason given'}`);
    ms.filter(m => m.projectId === p.id && !m.done && m.target && m.target < today).forEach(m => add('red', `Milestone “${m.name}” was due ${m.target}`));
    const mine = active.filter(t => t.list === p.name);
    const od = mine.filter(t => t.due && t.due < today).length;
    if (od) add('amber', `${od} overdue task${od === 1 ? '' : 's'}`);
    mine.filter(t => t.waiting && days(t.waitingSince) >= 5).forEach(t => add('amber', `Waiting on ${t.waiting} for ${days(t.waitingSince)} days: ${t.title}`));
    if (p.waiting && days(p.waitingSince) >= 5) add('amber', `Waiting on ${p.waiting} for ${days(p.waitingSince)} days`);
  });
  return out.sort((a, b) => (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1));
}
