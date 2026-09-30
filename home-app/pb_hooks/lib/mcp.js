// Claude connector: a small MCP server (JSON-RPC over HTTP POST) that lets Claude read and
// change one person's tasks. The same rules as the app apply (see data.js): completing a
// repeating task creates the next one, subtasks go one level deep, deleting moves to Trash.

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_LIST = "General";
const COLORS = ["BLUE", "GREEN", "RED", "ORANGE", "YELLOW", "MAUVE", "CYAN", "PALE_BLUE", "PALE_GREEN", "PALE_RED", "GRAY"];
const STATUSES = ["Not started", "In progress", "Blocked"];
const PRIORITIES = ["High", "Medium", "Low"];
const REPEATS = ["daily", "weekdays", "weekly", "monthly", "yearly"];

/* ---------------------------------------------------------------- dates (the NAS's own time zone) */
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parseISO = (s) => { const p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const today = () => isoOf(new Date());
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const weekday = (iso) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][parseISO(iso).getDay()];

function validIso(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split("-").map(Number), d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}
function toDate(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  if (s === "today") return today();
  if (s === "tomorrow") return addDays(today(), 1);
  if (!validIso(s)) fail("Dates must be YYYY-MM-DD (or 'today' / 'tomorrow'). Got: " + v);
  return s;
}
function toTime(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fail("Times must be 24-hour HH:MM, like 18:30. Got: " + v);
  return pad(Number(m[1])) + ":" + m[2];
}
// Next occurrence after `iso` (or today), never earlier than today. Mirrors the app.
function nextDue(iso, rule) {
  const base = parseISO(iso || today()), floor = parseISO(today()), anchor = base.getDate();
  let d = new Date(base.getTime()), months = 0;
  const step = () => {
    if (rule === "daily") d.setDate(d.getDate() + 1);
    else if (rule === "weekly") d.setDate(d.getDate() + 7);
    else if (rule === "weekdays") { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else {
      months += rule === "yearly" ? 12 : 1;
      const t = new Date(base.getFullYear(), base.getMonth() + months, 1);
      t.setDate(Math.min(anchor, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
      d = t;
    }
  };
  step();
  for (let g = 0; d < floor && g < 5000; g++) step();
  return isoOf(d);
}

/* ---------------------------------------------------------------- data helpers */
function fail(msg) { throw new Error(msg); }

function ctx(app, user) {
  const uid = user.id;
  const tasks = () => app.findRecordsByFilter("tasks", "owner = {:u}", "", 0, 0, { u: uid });
  const lists = () => app.findRecordsByFilter("lists", "owner = {:u}", "sort", 0, 0, { u: uid });
  const task = (id) => {
    let r = null;
    try { r = app.findRecordById("tasks", String(id || "")); } catch (_) {}
    if (!r || r.getString("owner") !== uid) fail("No task with id " + id + ". Use list_tasks to find ids.");
    return r;
  };
  const live = (r) => !r.getString("archType");
  const kidsOf = (id) => tasks().filter((k) => k.getString("parent") === id);
  const topPosition = (list, parent) => {
    let min = Infinity;
    tasks().forEach((t) => { if (live(t) && t.getString("list") === list && t.getString("parent") === parent) min = Math.min(min, t.getFloat("position")); });
    return min === Infinity ? 0 : min - 1;
  };
  // Finds a list by name, ignoring case; creates it when asked to.
  const listName = (name, create) => {
    const n = String(name == null ? "" : name).replace(/\s+/g, " ").trim().slice(0, 60) || DEFAULT_LIST;
    const all = lists();
    const hit = all.find((l) => l.getString("name").toLowerCase() === n.toLowerCase());
    if (hit) return hit.getString("name");
    const used = tasks().find((t) => live(t) && t.getString("list").toLowerCase() === n.toLowerCase());
    if (used) return used.getString("list");
    if (!create) fail("There is no list called \"" + n + "\". Lists: " + all.map((l) => l.getString("name")).join(", "));
    ensureList(n);
    return n;
  };
  const ensureList = (name, color) => {
    if (lists().some((l) => l.getString("name") === name)) return;
    const r = new Record(app.findCollectionByNameOrId("lists"));
    r.set("owner", uid);
    r.set("name", name);
    r.set("color", COLORS.includes(color) ? color : name === DEFAULT_LIST ? "GRAY" : COLORS[lists().length % COLORS.length]);
    r.set("sort", lists().reduce((m, l) => Math.max(m, l.getFloat("sort")), -1) + 1);
    app.save(r);
  };
  return { uid, tasks, lists, task, live, kidsOf, topPosition, listName, ensureList };
}

function show(r) {
  const o = { id: r.id, title: r.getString("title"), list: r.getString("list") };
  const arch = r.getString("archType");
  o.state = arch === "Completed" ? "completed" : arch === "Deleted" ? "in trash" : "open";
  if (r.getString("due")) o.due = r.getString("due");
  if (r.getString("time")) o.time = r.getString("time");
  if (r.getString("priority") && r.getString("priority") !== "Medium") o.priority = r.getString("priority");
  if (r.getBool("starred")) o.starred = true;
  if (r.getString("repeat")) o.repeat = r.getString("repeat");
  if (!arch && r.getString("status") && r.getString("status") !== "Not started") o.status = r.getString("status");
  if (r.getString("desc")) o.notes = r.getString("desc");
  if (r.getString("parent")) o.parent_id = r.getString("parent");
  if (arch === "Completed" && r.getString("completed")) o.completed_at = r.getString("completed");
  return o;
}

// Claude may write "high" or "in progress"; match the app's spelling.
const pick = (v, options) => options.find((o) => o.toLowerCase() === String(v == null ? "" : v).trim().toLowerCase());

function applyFields(c, r, a, isNew) {
  if ("title" in a) {
    const t = String(a.title == null ? "" : a.title).replace(/[\r\n]+/g, " ").trim().slice(0, 500);
    if (!t) fail("A task needs a title.");
    r.set("title", t);
  }
  if ("notes" in a) r.set("desc", String(a.notes == null ? "" : a.notes).trim().slice(0, 5000));
  if ("due" in a) {
    const d = toDate(a.due);
    r.set("due", d);
    if (!d) r.set("time", "");
  }
  if ("time" in a) {
    const t = toTime(a.time);
    if (t && !r.getString("due")) r.set("due", today());
    r.set("time", t);
  }
  if ("priority" in a) {
    const v = pick(a.priority, PRIORITIES);
    if (!v) fail("priority must be High, Medium or Low.");
    r.set("priority", v);
  }
  if ("status" in a) {
    const v = pick(a.status, STATUSES);
    if (!v) fail("status must be 'Not started', 'In progress' or 'Blocked'. Use complete_task to finish a task.");
    r.set("status", v);
  }
  if ("starred" in a) r.set("starred", !!a.starred);
  if ("repeat" in a) {
    const rep = String(a.repeat == null ? "" : a.repeat).toLowerCase();
    if (rep && rep !== "none" && !REPEATS.includes(rep)) fail("repeat must be one of: " + REPEATS.join(", ") + " (or empty for none).");
    r.set("repeat", REPEATS.includes(rep) ? rep : "");
    if (r.getString("repeat") && !r.getString("due")) r.set("due", today());
  }
  if ("list" in a && a.list) {
    const name = c.listName(a.list, true);
    if (name !== r.getString("list")) {
      r.set("list", name);
      if (!("parent_id" in a)) r.set("parent", "");
      if (!isNew) c.kidsOf(r.id).forEach((k) => { k.set("list", name); c.save(k); });
    }
  }
  if ("parent_id" in a) {
    const pid = String(a.parent_id || "").trim();
    if (pid) {
      const p = c.task(pid);
      if (pid === r.id) fail("A task can't be its own subtask.");
      if (p.getString("parent")) fail("Subtasks can only go one level deep.");
      if (!c.live(p)) fail("That parent task is completed or in the trash.");
      if (!isNew && c.kidsOf(r.id).some((k) => k.getString("archType") !== "Deleted")) fail("A task with subtasks can't become a subtask.");
      r.set("list", p.getString("list"));
    }
    r.set("parent", pid);
  }
}

/* ---------------------------------------------------------------- tools */
const S = (type, description, extra) => Object.assign({ type, description }, extra || {});
const TASK_FIELDS = {
  title: S("string", "What the task is."),
  list: S("string", "List name. Created if it doesn't exist. Defaults to General."),
  due: S("string", "Due date YYYY-MM-DD, or 'today' / 'tomorrow'. Empty string removes the date."),
  time: S("string", "Due time, 24-hour HH:MM. Sets the date to today if the task has none. Empty string removes it."),
  priority: S("string", "High, Medium or Low.", { enum: PRIORITIES }),
  notes: S("string", "Details / description."),
  starred: S("boolean", "Star the task."),
  repeat: S("string", "Repeat rule: daily, weekdays, weekly, monthly, yearly, or empty for none."),
  parent_id: S("string", "Make it a subtask of this task id (one level deep only). Empty string makes it a normal task."),
};

const TOOLS = [
  {
    name: "list_tasks",
    description: "List tasks. By default returns open tasks from every list, soonest due first. Also returns today's date and weekday so you can work out dates.",
    inputSchema: { type: "object", properties: {
      list: S("string", "Only this list."),
      state: S("string", "open (default), completed, trash or all.", { enum: ["open", "completed", "trash", "all"] }),
      due: S("string", "overdue, today (due today or earlier), upcoming (after today), no_date, or any (default).", { enum: ["overdue", "today", "upcoming", "no_date", "any"] }),
      starred: S("boolean", "Only starred tasks."),
      search: S("string", "Text to look for in titles and notes."),
      limit: S("number", "Most tasks to return (default 100)."),
    } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_lists",
    description: "List the task lists with how many open tasks each has.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_task",
    description: "Add a task. It appears in the app within seconds (and in Google Calendar if connected and it has a date).",
    inputSchema: { type: "object", properties: TASK_FIELDS, required: ["title"] },
  },
  {
    name: "update_task",
    description: "Change a task: pass its id and only the fields to change.",
    inputSchema: { type: "object", properties: Object.assign({ id: S("string", "Task id from list_tasks."),
      status: S("string", "Not started, In progress or Blocked.", { enum: STATUSES }) }, TASK_FIELDS), required: ["id"] },
  },
  {
    name: "complete_task",
    description: "Mark a task done (its open subtasks too). A repeating task gets its next occurrence created automatically.",
    inputSchema: { type: "object", properties: { id: S("string", "Task id.") }, required: ["id"] },
  },
  {
    name: "reopen_task",
    description: "Bring back a completed task, or restore one from the trash.",
    inputSchema: { type: "object", properties: { id: S("string", "Task id.") }, required: ["id"] },
  },
  {
    name: "delete_task",
    description: "Move a task (and its subtasks) to the trash. It can be restored with reopen_task.",
    inputSchema: { type: "object", properties: { id: S("string", "Task id.") }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "create_list",
    description: "Create a new task list.",
    inputSchema: { type: "object", properties: {
      name: S("string", "List name."),
      color: S("string", "Color.", { enum: COLORS }),
    }, required: ["name"] },
  },
];

function run(app, user, name, a) {
  const c = ctx(app, user);
  c.save = (r) => app.save(r);
  const now = new Date().toISOString();

  if (name === "list_tasks") {
    const state = a.state || "open", due = a.due || "any", t0 = today();
    const q = String(a.search || "").toLowerCase();
    const list = a.list ? c.listName(a.list, false) : "";
    let rows = c.tasks().filter((r) => {
      const arch = r.getString("archType"), d = r.getString("due");
      if (state === "open" && arch) return false;
      if (state === "completed" && arch !== "Completed") return false;
      if (state === "trash" && arch !== "Deleted") return false;
      if (list && r.getString("list") !== list) return false;
      if (a.starred && !r.getBool("starred")) return false;
      if (due === "overdue" && !(d && d < t0)) return false;
      if (due === "today" && !(d && d <= t0)) return false;
      if (due === "upcoming" && !(d && d > t0)) return false;
      if (due === "no_date" && d) return false;
      if (q && (r.getString("title") + " " + r.getString("desc")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    rows.sort((x, y) => (x.getString("due") || "9999").localeCompare(y.getString("due") || "9999")
      || (x.getString("time") || "99").localeCompare(y.getString("time") || "99")
      || x.getFloat("position") - y.getFloat("position"));
    const limit = Math.max(1, Math.min(500, Number(a.limit) || 100));
    return { today: t0, weekday: weekday(t0), total: rows.length, tasks: rows.slice(0, limit).map(show) };
  }

  if (name === "list_lists") {
    const open = {};
    c.tasks().forEach((t) => { if (c.live(t)) open[t.getString("list")] = (open[t.getString("list")] || 0) + 1; });
    return { lists: c.lists().map((l) => ({ name: l.getString("name"), color: l.getString("color"), open_tasks: open[l.getString("name")] || 0 })) };
  }

  if (name === "create_task") {
    const r = new Record(app.findCollectionByNameOrId("tasks"));
    r.set("owner", c.uid);
    r.set("status", "Not started");
    r.set("priority", "Medium");
    r.set("list", c.listName(DEFAULT_LIST, true));
    r.set("createdAt", now);
    applyFields(c, r, Object.assign({ title: a.title }, a), true);
    r.set("position", c.topPosition(r.getString("list"), r.getString("parent")));
    c.ensureList(r.getString("list"));
    app.save(r);
    return { created: show(r) };
  }

  if (name === "update_task") {
    const r = c.task(a.id);
    const fields = Object.assign({}, a);
    delete fields.id;
    if (!Object.keys(fields).length) fail("Say what to change (title, due, time, list, priority, notes, starred, repeat, status, parent_id).");
    applyFields(c, r, fields, false);
    app.save(r);
    return { updated: show(r) };
  }

  if (name === "complete_task") {
    const r = c.task(a.id);
    if (!c.live(r)) return { note: "Already " + show(r).state + ".", task: show(r) };
    const done = [r].concat(c.kidsOf(r.id).filter(c.live));
    done.forEach((x) => { x.set("archType", "Completed"); x.set("status", "Done"); x.set("completed", now); app.save(x); });
    const out = { completed: show(r) };
    if (done.length > 1) out.subtasks_completed = done.length - 1;
    if (r.getString("repeat")) {
      const n = new Record(app.findCollectionByNameOrId("tasks"));
      ["owner", "title", "desc", "time", "priority", "list", "repeat"].forEach((f) => n.set(f, r.get(f)));
      n.set("starred", r.getBool("starred"));
      n.set("position", r.getFloat("position"));
      n.set("due", nextDue(r.getString("due"), r.getString("repeat")));
      n.set("status", "Not started");
      n.set("createdAt", now);
      const p = r.getString("parent") ? (() => { try { return c.task(r.getString("parent")); } catch (_) { return null; } })() : null;
      n.set("parent", p && c.live(p) ? p.id : "");
      app.save(n);
      out.next_occurrence = show(n);
    }
    return out;
  }

  if (name === "reopen_task") {
    const r = c.task(a.id), was = r.getString("archType");
    if (!was) return { note: "It's already open.", task: show(r) };
    const stamp = r.getString("completed");
    const reopen = (x) => {
      x.set("archType", "");
      x.set("completed", "");
      if (!STATUSES.includes(x.getString("status"))) x.set("status", "Not started");
      app.save(x);
    };
    reopen(r);
    const pid = r.getString("parent");
    if (pid) {
      let p = null;
      try { p = c.task(pid); } catch (_) {}
      if (!p) { r.set("parent", ""); app.save(r); }
      else if (p.getString("archType") === "Completed") reopen(p);
      else if (p.getString("archType")) { r.set("parent", ""); app.save(r); }
    }
    c.kidsOf(r.id).forEach((k) => {
      if (k.getString("archType") !== was || (was === "Completed" && k.getString("completed") !== stamp)) return;
      reopen(k);
    });
    return { reopened: show(r) };
  }

  if (name === "delete_task") {
    const r = c.task(a.id);
    [r].concat(c.kidsOf(r.id)).forEach((x) => {
      if (x.getString("archType") === "Deleted") return;
      x.set("archType", "Deleted");
      app.save(x);
    });
    return { moved_to_trash: show(r) };
  }

  if (name === "create_list") {
    const n = String(a.name == null ? "" : a.name).replace(/\s+/g, " ").trim().slice(0, 60);
    if (!n) fail("The list needs a name.");
    if (c.lists().some((l) => l.getString("name").toLowerCase() === n.toLowerCase())) fail("A list called \"" + n + "\" already exists.");
    if (a.color) a.color = pick(a.color, COLORS) || fail("color must be one of: " + COLORS.join(", "));
    c.ensureList(n, a.color);
    return { created_list: n };
  }

  fail("Unknown tool: " + name);
}

/* ---------------------------------------------------------------- JSON-RPC */
function handle(app, user, msg) {
  const id = msg.id;
  const isRequest = id !== undefined && id !== null && typeof msg.method === "string";
  if (!isRequest) return null; // notifications and responses need no answer
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize": {
      const t0 = today();
      return ok({
        protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "tasks-home", title: "Tasks (home)", version: "1.0.0" },
        instructions: "These are the user's personal tasks from their Tasks app. Today is " + weekday(t0) + " " + t0 +
          " (the NAS's time zone). Dates are YYYY-MM-DD and times 24-hour HH:MM. Use list_tasks to find task ids before " +
          "changing tasks. Deleting moves tasks to the trash; nothing is removed for good.",
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      if (!TOOLS.some((t) => t.name === p.name)) return err(-32602, "Unknown tool: " + p.name);
      try {
        const result = run(app, user, p.name, p.arguments || {});
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result });
      } catch (e) {
        return ok({ content: [{ type: "text", text: String((e && e.message) || e) }], isError: true });
      }
    }
    default: return err(-32601, "Method not found: " + msg.method);
  }
}

// One HTTP request: a single JSON-RPC message or a batch. Returns [status, body|null].
function serve(app, user, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return [400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]; }
  if (Array.isArray(msg)) {
    const out = msg.map((m) => handle(app, user, m || {})).filter(Boolean);
    return out.length ? [200, out] : [202, null];
  }
  const out = handle(app, user, msg || {});
  return out ? [200, out] : [202, null];
}

function userForKey(app, key) {
  if (!/^[A-Za-z0-9]{40}$/.test(String(key || ""))) return null;
  try { return app.findFirstRecordByData("users", "mcpKey", key); } catch (_) { return null; }
}

/* ---------------------------------------------------------------- HTTP */
function httpPost(e) {
  const user = userForKey(e.app, e.request.pathValue("key"));
  if (!user) throw new NotFoundError("Not found.");
  const res = serve(e.app, user, toString(e.request.body, 1048576));
  if (!res[1]) return e.noContent(res[0]);
  return e.json(res[0], res[1]);
}

function httpGet(e) {
  if (!userForKey(e.app, e.request.pathValue("key"))) throw new NotFoundError("Not found.");
  // Claude may ask for an event stream here; this server answers every request directly instead.
  if (String(e.request.header.get("Accept")).indexOf("text/event-stream") >= 0) {
    e.response.header().set("Allow", "POST");
    return e.noContent(405);
  }
  return e.json(200, { ok: true, message: "Your Claude connector is working. Paste this address into Claude." });
}

const info = (user) => {
  const key = user.getString("mcpKey");
  return { enabled: !!key, path: key ? "/mcp/" + key : "" };
};

// Settings: turn on (keeps an existing key), make a new key, or turn off.
function setKey(app, user, action) {
  if (action === "disable") user.set("mcpKey", "");
  else if (action === "reset" || !user.getString("mcpKey")) user.set("mcpKey", $security.randomString(40));
  app.save(user);
  return info(user);
}

module.exports = { httpPost, httpGet, info, setKey, serve, userForKey, TOOLS, nextDue };
