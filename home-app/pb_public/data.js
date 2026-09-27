/* Task Manager (home) — local-first data layer.
 *
 * Every change is applied to a copy kept on this device (instant, works offline),
 * written to an outbox, and pushed to PocketBase in the background. Changes made
 * on other devices arrive over PocketBase's realtime connection. The task rules
 * mirror the Apps Script version's Code.gs.
 */
(function () {
  'use strict';

  const pb = new PocketBase(location.origin);
  pb.autoCancellation(false);

  const DEFAULT_LIST = 'General';
  const COLORS = ['BLUE', 'GREEN', 'RED', 'ORANGE', 'YELLOW', 'MAUVE', 'CYAN', 'PALE_BLUE', 'PALE_GREEN', 'PALE_RED', 'GRAY'];
  const STATUSES = ['Not started', 'In progress', 'Blocked', 'Done'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const REPEATS = ['', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
  const ID_RE = /^[a-z0-9]{15}$/;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const NOT_FOUND = 'Task not found. It may have been deleted on another device.';

  const fail = msg => { throw new Error(msg); };
  const clone = o => JSON.parse(JSON.stringify(o));
  const pad = n => String(n).padStart(2, '0');
  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  // PocketBase record ids: 15 characters, a–z and 0–9.
  const newId = () => [...crypto.getRandomValues(new Uint8Array(15))].map(x => ALPHABET[x % 36]).join('');

  /* ---------------------------------------------------------------- store */
  let store = null, userId = '';
  const storeKey = () => 'tm.store.' + userId;
  const blank = () => ({ tasks: {}, lists: {}, outbox: {}, remote: {}, seq: 0, lastSync: 0 });
  function loadStore() {
    try { return Object.assign(blank(), JSON.parse(localStorage.getItem(storeKey()) || 'null') || {}); } catch (e) { return blank(); }
  }
  let persistTimer = 0;
  function persist(now) {
    clearTimeout(persistTimer);
    const write = () => { try { localStorage.setItem(storeKey(), JSON.stringify(store)); } catch (e) { console.warn('Could not save on this device', e); } };
    if (now) write(); else persistTimer = setTimeout(write, 150);
  }
  // Outbox entries carry a version so an edit made while an older push is in flight is never dropped.
  function queue(kind, id, op) {
    store.seq += 1;
    store.outbox[kind + ':' + id] = { op, v: store.seq };
    persist();
    Sync.soon();
  }
  const saveTask = t => queue('t', t.id, 'upsert');
  const saveList = l => queue('l', l.id, 'upsert');

  /* ---------------------------------------------------------------- task rules (mirror Code.gs) */
  const all = () => Object.values(store.tasks);
  const live = t => !t.archType;
  const kidsOf = id => all().filter(k => k.parent === id);
  const must = id => store.tasks[id] || fail(NOT_FOUND);
  const norm = t => {
    t.archived = !!t.archType;
    if (t.archType === 'Completed') t.status = 'Done';
    else if (t.status === 'Done' || !STATUSES.includes(t.status)) t.status = 'Not started';
    return t;
  };
  const out = (tasks, extra) => Object.assign({ tasks: [...new Set(tasks)].map(t => clone(norm(t))) }, extra || {});
  const cleanTitle = v => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  function cleanListName(v) {
    const n = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);
    return n || fail('List name required.');
  }
  function validIso(s) {
    if (!ISO_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function hhmm(v) {
    const m = String(v == null ? '' : v).trim().match(TIME_RE);
    return m ? pad(Number(m[1])) + ':' + m[2] : '';
  }
  function setArch(t, type, when) {
    t.archType = type;
    if (type === 'Completed') { t.status = 'Done'; t.completed = when; }
    norm(t);
  }
  function unarchive(t) {
    t.archType = '';
    t.completed = '';
    if (t.status === 'Done' || !STATUSES.includes(t.status)) t.status = 'Not started';
    norm(t);
  }
  function topOrder(list, parent, skipId) {
    let min = Infinity;
    all().forEach(t => { if (t.id !== skipId && live(t) && t.list === list && (t.parent || '') === parent) min = Math.min(min, t.order); });
    return min === Infinity ? 0 : min - 1;
  }
  // Next occurrence after `iso` (or today), never earlier than today.
  function nextDue(iso, rule, today) {
    const base = parseISO(iso || today), floor = parseISO(today), anchor = base.getDate();
    let d = new Date(base), months = 0;
    const step = () => {
      if (rule === 'daily') d.setDate(d.getDate() + 1);
      else if (rule === 'weekly') d.setDate(d.getDate() + 7);
      else if (rule === 'weekdays') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
      else {
        months += rule === 'yearly' ? 12 : 1;
        const t = new Date(base.getFullYear(), base.getMonth() + months, 1);
        t.setDate(Math.min(anchor, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
        d = t;
      }
    };
    step();
    for (let g = 0; d < floor && g < 5000; g++) step();
    return isoOf(d);
  }

  function applyPatch(t, p, changed) {
    if ('title' in p) t.title = cleanTitle(p.title) || fail('Task name is required.');
    if ('desc' in p) t.desc = String(p.desc == null ? '' : p.desc).trim().slice(0, 5000);
    if ('due' in p) {
      const due = String(p.due || '').trim();
      if (due && !validIso(due)) fail('That date isn\'t valid.');
      t.due = due;
      if (!due) t.time = '';
    }
    if ('time' in p) t.time = t.due ? hhmm(p.time) : '';
    if ('status' in p && STATUSES.includes(p.status) && p.status !== 'Done') t.status = p.status;
    if ('priority' in p && PRIORITIES.includes(p.priority)) t.priority = p.priority;
    if ('starred' in p) t.starred = !!p.starred;
    if ('repeat' in p) t.repeat = REPEATS.includes(p.repeat) ? p.repeat : '';
    if ('order' in p && p.order !== '' && p.order !== null && isFinite(Number(p.order))) t.order = Number(p.order);
    if ('list' in p) {
      const list = cleanListName(p.list || DEFAULT_LIST);
      if (t.list !== list) {
        t.list = list;
        if (!('parent' in p) && t.parent) t.parent = '';
        kidsOf(t.id).forEach(k => { k.list = list; changed.push(k); });
      }
    }
    if ('parent' in p) {
      const parent = String(p.parent || '').trim();
      if (parent) {
        const pr = must(parent);
        if (parent === t.id) fail('A task can\'t be its own subtask.');
        if (pr.parent) fail('Subtasks can only go one level deep.');
        if (!live(pr)) fail('That parent task is completed or deleted.');
        if (kidsOf(t.id).some(k => k.archType !== 'Deleted')) fail('A task with subtasks can\'t become a subtask.');
        t.list = pr.list;
      }
      t.parent = parent;
    }
  }

  const listsArr = () => Object.values(store.lists).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const findList = name => listsArr().find(l => l.name === name);
  function ensureList(name, color) {
    if (findList(name)) return;
    const l = { id: newId(), name, color: COLORS.includes(color) ? color : (name === DEFAULT_LIST ? 'GRAY' : 'BLUE'), sort: listsArr().reduce((m, x) => Math.max(m, x.sort), -1) + 1 };
    store.lists[l.id] = l;
    saveList(l);
  }
  const listsOut = () => listsArr().map(l => ({ name: l.name, color: l.color }));

  function purge(ids) {
    const gone = new Set(ids), detached = [];
    all().forEach(t => {
      if (gone.has(t.id) || !ids.includes(t.parent)) return;
      if (t.archType === 'Deleted') gone.add(t.id);
      else { t.parent = ''; detached.push(t); saveTask(t); }
    });
    gone.forEach(id => { delete store.tasks[id]; queue('t', id, 'delete'); });
    return out(detached, { removed: [...gone] });
  }

  const api = {
    getAll() {
      ensureList(DEFAULT_LIST);
      all().forEach(t => { norm(t); if (live(t)) ensureList(t.list); });
      return { tasks: all().map(t => clone(t)), lists: listsOut(), settings: {}, defaultList: DEFAULT_LIST };
    },

    // Updates only the fields present; creates only when `create` is set.
    saveTask(input) {
      const p = input || {};
      const id = String(p.id || '').trim();
      let t = id && store.tasks[id];
      const isNew = !t, changed = [];
      if (isNew) {
        if (!p.create) fail(NOT_FOUND);
        if (!ID_RE.test(id)) fail('Invalid task id.');
        if (!cleanTitle(p.title)) fail('Task name is required.');
        t = { id, title: '', desc: '', due: '', time: '', status: 'Not started', priority: 'Medium', list: DEFAULT_LIST,
          starred: false, parent: '', order: null, repeat: '', created: new Date().toISOString(), completed: '', archType: '' };
      }
      const before = clone(t);
      try { applyPatch(t, p, changed); } catch (e) { Object.assign(t, before); throw e; }
      if (isNew) {
        if (t.order == null) t.order = topOrder(t.list, t.parent, id);
        store.tasks[id] = t;
      }
      ensureList(t.list);
      changed.push(t);
      changed.forEach(saveTask);
      return out(changed);
    },

    completeTask(id, nextId) {
      const t = must(id);
      if (!live(t)) return out([t]);
      const now = new Date().toISOString(), changed = [t];
      setArch(t, 'Completed', now);
      kidsOf(id).forEach(k => { if (live(k)) { setArch(k, 'Completed', now); changed.push(k); } });
      if (t.repeat && !(nextId && store.tasks[nextId])) {
        if (nextId && !ID_RE.test(nextId)) fail('Invalid task id.');
        const parent = store.tasks[t.parent];
        const n = {
          id: nextId || newId(), title: t.title, desc: t.desc, time: t.time, priority: t.priority, list: t.list, starred: t.starred,
          order: t.order, repeat: t.repeat, due: nextDue(t.due, t.repeat, isoOf(new Date())), status: 'Not started',
          created: now, completed: '', archType: '', parent: parent && live(parent) ? t.parent : '',
        };
        store.tasks[n.id] = norm(n);
        changed.push(n);
      }
      changed.forEach(saveTask);
      return out(changed);
    },

    restoreTask(id) {
      const t = must(id), was = t.archType;
      if (!was) return out([t]);
      const stamp = t.completed, changed = [t];
      unarchive(t);
      if (t.parent) {
        const p = store.tasks[t.parent];
        if (!p) t.parent = '';
        else if (p.archType === 'Completed') { unarchive(p); changed.push(p); }
        else if (p.archType) t.parent = '';
      }
      // Only subtasks completed in the same action as the parent share its exact timestamp.
      kidsOf(id).forEach(k => {
        if (k.archType !== was || (was === 'Completed' && k.completed !== stamp)) return;
        unarchive(k);
        changed.push(k);
      });
      changed.forEach(saveTask);
      return out(changed);
    },

    deleteTask(id) {
      const t = must(id), changed = [t];
      [t, ...kidsOf(id)].forEach(x => {
        if (x.archType === 'Deleted') return;
        setArch(x, 'Deleted');
        if (x !== t) changed.push(x);
      });
      changed.forEach(saveTask);
      return out(changed);
    },

    purgeTask(id) { must(id); return purge([id]); },
    emptyTrash() { return purge(all().filter(t => t.archType === 'Deleted').map(t => t.id)); },

    clearCompleted(list) {
      list = cleanListName(list);
      const changed = all().filter(t => t.list === list && t.archType === 'Completed');
      changed.forEach(t => { setArch(t, 'Deleted'); saveTask(t); });
      return out(changed);
    },

    // Sets the full sibling order for one list (or one parent's subtasks).
    reorderTasks(list, parent, ids) {
      list = cleanListName(list || DEFAULT_LIST);
      parent = String(parent || '').trim();
      if (!Array.isArray(ids)) fail('ids must be an array.');
      if (parent) {
        const pr = must(parent);
        if (pr.parent) fail('Subtasks can only go one level deep.');
        if (!live(pr)) fail('That parent task is completed or deleted.');
        list = pr.list;
      }
      const changed = [];
      ids.forEach((id, n) => {
        const t = store.tasks[id];
        if (!t) return;
        if (parent) {
          if (id === parent) fail('A task can\'t be its own subtask.');
          if (kidsOf(id).some(k => k.archType !== 'Deleted')) fail('A task with subtasks can\'t become a subtask.');
        }
        t.order = n;
        t.parent = parent;
        if (t.list !== list) { t.list = list; kidsOf(id).forEach(k => { k.list = list; changed.push(k); }); }
        changed.push(t);
      });
      ensureList(list);
      changed.forEach(saveTask);
      return out(changed);
    },

    createList(name, color) {
      name = cleanListName(name);
      const taken = listsArr().map(l => l.name).concat(all().filter(live).map(t => t.list));
      if (taken.some(n => n.toLowerCase() === name.toLowerCase())) fail('That list already exists.');
      ensureList(name, color);
      return { lists: listsOut() };
    },

    renameList(oldName, newName) {
      oldName = cleanListName(oldName);
      newName = cleanListName(newName);
      if (oldName === DEFAULT_LIST) fail('The default list can\'t be renamed.');
      if (oldName === newName) return { lists: listsOut(), tasks: [] };
      if (listsArr().some(l => l.name !== oldName && l.name.toLowerCase() === newName.toLowerCase())) fail('A list with that name already exists.');
      const l = findList(oldName);
      if (l) { l.name = newName; saveList(l); } else ensureList(newName);
      const changed = all().filter(t => t.list === oldName);
      changed.forEach(t => { t.list = newName; saveTask(t); });
      return out(changed, { lists: listsOut() });
    },

    setListColor(name, color) {
      name = cleanListName(name);
      if (!COLORS.includes(color)) fail('Unknown color.');
      const l = findList(name);
      if (l) { l.color = color; saveList(l); } else ensureList(name, color);
      return { lists: listsOut() };
    },

    deleteList(name) {
      name = cleanListName(name);
      if (name === DEFAULT_LIST) fail('Cannot delete the default list.');
      listsArr().filter(l => l.name === name).forEach(l => { delete store.lists[l.id]; queue('l', l.id, 'delete'); });
      const changed = all().filter(t => t.list === name && t.archType !== 'Deleted');
      changed.forEach(t => { setArch(t, 'Deleted'); saveTask(t); });
      return out(changed, { lists: listsOut() });
    },

    async syncNow() {
      await Sync.run(true);
      return { message: Sync.describe() };
    },
  };

  /* ---------------------------------------------------------------- sync */
  const toRecord = t => ({
    owner: userId, title: t.title, desc: t.desc || '', due: t.due || '', time: t.time || '',
    status: t.archType === 'Completed' ? 'Done' : t.status, priority: t.priority, list: t.list, starred: !!t.starred,
    parent: t.parent || '', position: Number(t.order) || 0, repeat: t.repeat || '', completed: t.completed || '',
    archType: t.archType || '', createdAt: t.created || '',
  });
  const fromRecord = r => norm({
    id: r.id, title: r.title, desc: r.desc || '', due: r.due || '', time: r.time || '', status: r.status || 'Not started',
    priority: r.priority || 'Medium', list: r.list || DEFAULT_LIST, starred: !!r.starred, parent: r.parent || '',
    order: typeof r.position === 'number' ? r.position : 0, repeat: r.repeat || '',
    created: r.createdAt || String(r.created || '').replace(' ', 'T'), completed: r.completed || '', archType: r.archType || '',
  });
  const fromListRecord = r => ({ id: r.id, name: r.name, color: COLORS.includes(r.color) ? r.color : 'GRAY', sort: typeof r.sort === 'number' ? r.sort : 0 });

  const isNetwork = e => !e || e.status === 0 || e.isAbort;
  // A request can hang on flaky mobile data; give up after a while so later syncs aren't stuck behind it.
  // Retrying is safe: a push that did land is simply sent again as an update.
  const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error('The NAS took too long to answer.'), { status: 0 })), ms))]);

  async function pushOne(kind, id, op) {
    const coll = pb.collection(kind === 't' ? 'tasks' : 'lists'), rk = kind + ':' + id;
    if (op === 'delete') {
      try { await coll.delete(id); } catch (e) { if (e.status !== 404) throw e; }
      delete store.remote[rk];
      return;
    }
    const obj = kind === 't' ? store.tasks[id] : store.lists[id];
    if (!obj) return;
    const data = kind === 't' ? toRecord(obj) : { owner: userId, name: obj.name, color: obj.color, sort: obj.sort };
    try {
      if (store.remote[rk]) await coll.update(id, data);
      else await coll.create(Object.assign({ id }, data));
    } catch (e) {
      if (e.status === 404 && store.remote[rk]) await coll.create(Object.assign({ id }, data));
      else if (e.status === 400 && e.response && e.response.data && e.response.data.id) await coll.update(id, data);
      else if (e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status)) {
        // The server will never accept this change; drop it so the rest of the queue can sync.
        console.warn('Change rejected by the server', rk, e.response);
        Sync.rejected += 1;
        return;
      } else throw e;
    }
    store.remote[rk] = true;
  }

  async function pushAll() {
    for (const key of Object.keys(store.outbox)) {
      const entry = store.outbox[key];
      if (!entry) continue;
      await timeout(pushOne(key[0], key.slice(2), entry.op), 20000);
      if (store.outbox[key] && store.outbox[key].v === entry.v) delete store.outbox[key];
      persist();
      Sync.emit();
    }
  }

  function applyRecords(kind, records) {
    const bag = kind === 't' ? store.tasks : store.lists, seen = new Set();
    records.forEach(r => {
      const rk = kind + ':' + r.id;
      seen.add(r.id);
      store.remote[rk] = true;
      if (!store.outbox[rk]) bag[r.id] = kind === 't' ? fromRecord(r) : fromListRecord(r);
    });
    Object.keys(bag).forEach(id => {
      const rk = kind + ':' + id;
      if (seen.has(id) || store.outbox[rk]) return;
      if (store.remote[rk]) { delete bag[id]; delete store.remote[rk]; }   // deleted on another device
      else queue(kind, id, 'upsert');                                    // never reached the server yet
    });
  }

  // Two devices offline at once can both create "General"; keep the first and drop the copies.
  function dedupeLists() {
    const byName = new Map();
    listsArr().forEach(l => {
      if (!byName.has(l.name)) { byName.set(l.name, l); return; }
      delete store.lists[l.id];
      queue('l', l.id, 'delete');
    });
  }

  async function pullAll() {
    const [tasks, lists] = await timeout(Promise.all([
      pb.collection('tasks').getFullList({ batch: 1000 }),
      pb.collection('lists').getFullList({ batch: 500 }),
    ]), 30000);
    applyRecords('t', tasks);
    applyRecords('l', lists);
    dedupeLists();
    persist();
    notifyChanged();
  }

  function onRealtime(kind, e) {
    const r = e.record, rk = kind + ':' + r.id;
    if (!store || store.outbox[rk]) return;
    const bag = kind === 't' ? store.tasks : store.lists;
    if (e.action === 'delete') { delete bag[r.id]; delete store.remote[rk]; }
    else { bag[r.id] = kind === 't' ? fromRecord(r) : fromListRecord(r); store.remote[rk] = true; }
    persist();
    notifyChanged();
  }

  const Sync = {
    state: 'idle', error: '', rejected: 0, running: null, again: false, againPull: false, timer: 0, retry: 0,
    listeners: new Set(),
    pending: () => (store ? Object.keys(store.outbox).length : 0),
    emit() { this.listeners.forEach(fn => fn(this.snapshot())); },
    snapshot() { return { state: this.state, pending: this.pending(), lastSync: store ? store.lastSync : 0, error: this.error }; },
    set(state, error) { this.state = state; this.error = error || ''; this.emit(); },
    soon(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(false), ms == null ? 250 : ms); },
    describe() {
      const n = this.pending();
      if (this.state === 'offline') return n ? `Offline · ${n} change${n > 1 ? 's' : ''} saved on this device` : 'Offline · everything is saved on this device';
      if (this.state === 'error') return 'Sync problem: ' + this.error;
      return n ? `${n} change${n > 1 ? 's' : ''} waiting to sync` : 'Everything is synced';
    },
    run(pull) {
      if (!store || !userId) return Promise.resolve();
      if (this.running) { this.again = true; this.againPull = this.againPull || pull; return this.running; }
      this.running = (async () => {
        // Yield first: a run that fails instantly (offline) must not finish before `running` is assigned,
        // or `running` would stay set forever and block every later sync.
        await null;
        try {
          if (!navigator.onLine) throw Object.assign(new Error('offline'), { status: 0 });
          this.set('syncing');
          await pushAll();
          if (pull) await pullAll();
          store.lastSync = Date.now();
          this.retry = 0;
          persist();
          this.set('idle');
          ensureRealtime();
        } catch (e) {
          if (e && (e.status === 401 || e.status === 403) && !pb.authStore.isValid) { signedOut(); return; }
          if (isNetwork(e)) this.set('offline'); else this.set('error', (e && e.message) || String(e));
          // Back off 5s, 15s, 45s … up to 5 minutes, and retry right away when the network returns.
          this.retry = Math.min(this.retry + 1, 5);
          this.soon(Math.min(5000 * Math.pow(3, this.retry - 1), 300000));
          this.againPull = true;
        } finally {
          this.running = null;
          if (this.again) { const p = this.againPull; this.again = this.againPull = false; this.run(p); }
        }
      })();
      return this.running;
    },
  };

  /* ---------------------------------------------------------------- change notifications for the UI */
  const changeListeners = new Set();
  let changeTimer = 0;
  function notifyChanged() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => changeListeners.forEach(fn => fn()), 120);
  }

  /* ---------------------------------------------------------------- session */
  let signedOutHandler = null;
  function signedOut() {
    pb.realtime.unsubscribe().catch(() => {});
    Sync.set('signed-out');
    if (signedOutHandler) signedOutHandler();
  }

  // Live updates from other devices. Retried after every successful sync, so a
  // subscription that failed while offline comes back once the NAS is reachable.
  let subscribing = null;
  function ensureRealtime() {
    if (subscribing || !store || !navigator.onLine || pb.realtime.isConnected) return;
    subscribing = (async () => {
      try {
        await pb.realtime.subscribe('PB_CONNECT', () => Sync.run(true));
        await pb.collection('tasks').subscribe('*', e => onRealtime('t', e));
        await pb.collection('lists').subscribe('*', e => onRealtime('l', e));
      } catch (e) {
        await pb.realtime.unsubscribe().catch(() => {});
      } finally {
        subscribing = null;
      }
    })();
  }

  async function connect() {
    try {
      if (navigator.onLine) await pb.collection('users').authRefresh();
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) { pb.authStore.clear(); signedOut(); return; }
    }
    Sync.run(true);
  }

  function open(record) {
    userId = record.id;
    store = loadStore();
    Sync.emit();
    connect();
  }

  window.addEventListener('online', () => Sync.run(true));
  window.addEventListener('offline', () => Sync.set('offline'));
  window.addEventListener('pagehide', () => { if (store) persist(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (store) persist(true); return; }
    if (store && Date.now() - store.lastSync > 30000) Sync.run(true);
  });
  setInterval(() => { if (store && document.visibilityState === 'visible') Sync.run(true); }, 5 * 60000);

  window.TM = {
    newId,
    // Runs a task operation on this device and returns what changed, like google.script.run did.
    call(fn, args) {
      return new Promise((resolve, reject) => {
        try {
          if (!store) fail('Not signed in.');
          Promise.resolve(api[fn](...(args || []))).then(resolve, reject);
        } catch (e) { reject(e); }
      });
    },
    onChange(fn) { changeListeners.add(fn); },
    onSync(fn) { Sync.listeners.add(fn); fn(Sync.snapshot()); },
    onSignedOut(fn) { signedOutHandler = fn; },
    syncStatus: () => Sync.describe(),
    syncNow: () => Sync.run(true),
    auth: {
      // Local data opens even when offline or when the saved sign-in has expired;
      // an expired sign-in is renewed as soon as the server can be reached.
      resume() {
        const rec = pb.authStore.record;
        if (!pb.authStore.token || !rec) return null;
        open(rec);
        return { email: rec.email };
      },
      async needsSetup() {
        const r = await pb.send('/api/tm/status', {});
        return !r.hasUser;
      },
      async signIn(email, password) {
        const res = await pb.collection('users').authWithPassword(email, password);
        open(res.record);
        return { email: res.record.email };
      },
      async createAccount(email, password) {
        await pb.collection('users').create({ email, password, passwordConfirm: password });
        return this.signIn(email, password);
      },
      async signOut() {
        if (store && Object.keys(store.outbox).length) await Sync.run(false);
        await pb.realtime.unsubscribe().catch(() => {});
        pb.authStore.clear();
        store = null;
        userId = '';
      },
      email: () => (pb.authStore.record ? pb.authStore.record.email : ''),
    },
    calendar: {
      link: () => pb.send('/api/tm/calendar', {}).then(r => location.origin + r.path),
      reset: () => pb.send('/api/tm/calendar/reset', { method: 'POST' }).then(r => location.origin + r.path),
    },
    google: {
      redirectUri: () => location.origin + '/api/tm/google/callback',
      status: () => pb.send('/api/tm/google', {}),
      // Resolves with Google's sign-in page address; the caller sends the browser there.
      start: (clientId, clientSecret) => pb.send('/api/tm/google/start', {
        method: 'POST',
        body: { clientId, clientSecret, origin: location.origin, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
      }).then(r => r.url),
      sync: () => pb.send('/api/tm/google/sync', { method: 'POST' }),
      disconnect: () => pb.send('/api/tm/google/disconnect', { method: 'POST' }),
    },
  };
})();
