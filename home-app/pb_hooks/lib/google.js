// Mirrors open, dated tasks into a "Tasks" calendar in the owner's Google Calendar.
// Each event's id is derived from the task id, so a task can never create two events.
// TM_GOOGLE_BASE points every Google URL at a stand-in server (used by the tests only).

const SCOPE = "https://www.googleapis.com/auth/calendar";
const EVENT_MINUTES = 30;
const TIMED_REMINDER_MINUTES = 15;

const base = () => $os.getenv("TM_GOOGLE_BASE") || "";
const AUTH_URL = () => (base() ? base() + "/auth" : "https://accounts.google.com/o/oauth2/v2/auth");
const TOKEN_URL = () => (base() || "https://oauth2.googleapis.com") + "/token";
const API = () => (base() || "https://www.googleapis.com") + "/calendar/v3";

const connected = (user) => !!(user.getString("gRefresh") && user.getString("gCalendarId"));
const pad = (n) => String(n).padStart(2, "0");
const qs = (o) => Object.keys(o).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(o[k])).join("&");

function call(method, url, token, body, form) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  let payload = "";
  if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = qs(form); }
  else if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  return $http.send({ url, method, headers, body: payload, timeout: 10 });
}

function fail(what, res) {
  const msg = res.json && res.json.error && (res.json.error.message || res.json.error_description || res.json.error);
  return new Error(what + " (" + res.statusCode + (msg ? ": " + msg : "") + ")");
}

function accessToken(app, user) {
  const now = Math.floor(Date.now() / 1000);
  if (user.getString("gAccess") && user.getFloat("gAccessExp") - 60 > now) return user.getString("gAccess");
  const res = call("POST", TOKEN_URL(), null, null, {
    client_id: user.getString("gClientId"), client_secret: user.getString("gClientSecret"),
    refresh_token: user.getString("gRefresh"), grant_type: "refresh_token",
  });
  if (res.statusCode !== 200) {
    if (res.json && res.json.error === "invalid_grant") {
      user.set("gRefresh", "");
      user.set("gError", "Google stopped accepting the connection (access was removed or expired). Connect again.");
      app.save(user);
    }
    throw fail("Google sign-in refresh failed", res);
  }
  user.set("gAccess", res.json.access_token);
  user.set("gAccessExp", now + (res.json.expires_in || 3600));
  app.save(user);
  return res.json.access_token;
}

// Google event ids allow only 0-9 and a-v, so the task id is written out in hex.
const eventId = (taskId) => "task" + String(taskId).split("").map((c) => c.charCodeAt(0).toString(16)).join("");

function addMinutes(date, time, minutes) {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi) + minutes * 60000);
  return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate()) + "T" + pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes()) + ":00";
}

// What the Google event should look like, or null when the task shouldn't be on the calendar.
function desired(rec, timeZone) {
  const due = rec.getString("due"), time = rec.getString("time");
  if (rec.getString("archType") || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  const list = rec.getString("list"), high = rec.getString("priority") === "High";
  const ev = {
    summary: (rec.getBool("starred") ? "★ " : "") + rec.getString("title"),
    description: [rec.getString("desc"), "List: " + list + (high ? " · High priority" : "")].filter(Boolean).join("\n\n"),
    status: "confirmed",
    reminders: { useDefault: true },
    extendedProperties: { private: { taskId: rec.id } },
  };
  if (/^\d{2}:\d{2}$/.test(time)) {
    ev.start = { dateTime: due + "T" + time + ":00", timeZone };
    ev.end = { dateTime: addMinutes(due, time, EVENT_MINUTES), timeZone };
  } else {
    ev.start = { date: due };
    ev.end = { date: addMinutes(due, "00:00", 24 * 60).slice(0, 10) };
  }
  return ev;
}

function findMap(app, taskId) {
  try { return app.findFirstRecordByFilter("gcal_map", "task = {:t}", { t: taskId }); } catch (_) { return null; }
}

function deleteEvent(app, user, taskId, map) {
  const res = call("DELETE", API() + "/calendars/" + encodeURIComponent(user.getString("gCalendarId")) + "/events/" + eventId(taskId), accessToken(app, user));
  if (res.statusCode >= 300 && res.statusCode !== 404 && res.statusCode !== 410) throw fail("Couldn't remove the Google event", res);
  if (map) app.delete(map);
}

function syncTask(app, rec) {
  const user = app.findRecordById("users", rec.getString("owner"));
  if (!connected(user)) return "off";
  const want = desired(rec, user.getString("gTimeZone") || "UTC");
  const map = findMap(app, rec.id);
  if (!want) {
    if (map) deleteEvent(app, user, rec.id, map);
    return map ? "removed" : "skip";
  }
  const hash = $security.md5(JSON.stringify(want));
  if (map && map.getString("hash") === hash) return "skip";
  const token = accessToken(app, user);
  const events = API() + "/calendars/" + encodeURIComponent(user.getString("gCalendarId")) + "/events";
  const id = eventId(rec.id);
  let res = call("PUT", events + "/" + id, token, want);
  if (res.statusCode === 404) {
    res = call("POST", events, token, Object.assign({ id }, want));
    if (res.statusCode === 409) res = call("PUT", events + "/" + id, token, want);
  }
  if (res.statusCode >= 300) throw fail("Google Calendar didn't accept the event", res);
  const row = map || new Record(app.findCollectionByNameOrId("gcal_map"));
  row.set("task", rec.id);
  row.set("owner", user.id);
  row.set("hash", hash);
  app.save(row);
  return "saved";
}

function removeTask(app, rec) {
  const map = findMap(app, rec.id);
  if (!map) return;
  const user = app.findRecordById("users", rec.getString("owner"));
  if (connected(user)) deleteEvent(app, user, rec.id, map);
  else app.delete(map);
}

// Brings Google fully in line with the tasks (catches anything missed while offline).
function reconcileUser(app, user) {
  if (!connected(user)) return { ok: false, error: user.getString("gError") || "Not connected." };
  let failed = 0, lastError = "";
  const tasks = app.findRecordsByFilter("tasks", "owner = {:u}", "", 0, 0, { u: user.id });
  const ids = new Set();
  tasks.forEach((t) => {
    ids.add(t.id);
    try { syncTask(app, t); } catch (err) { failed++; lastError = String(err.message || err); }
  });
  app.findRecordsByFilter("gcal_map", "owner = {:u}", "", 0, 0, { u: user.id }).forEach((m) => {
    if (ids.has(m.getString("task"))) return;
    try { deleteEvent(app, user, m.getString("task"), m); } catch (err) { failed++; lastError = String(err.message || err); }
  });
  const fresh = app.findRecordById("users", user.id);
  fresh.set("gError", failed ? lastError : "");
  app.save(fresh);
  return { ok: !failed, failed, error: failed ? lastError : "" };
}

function reconcileAll(app) {
  app.findRecordsByFilter("users", "gRefresh != '' && gCalendarId != ''", "", 0, 0).forEach((u) => {
    try { reconcileUser(app, u); } catch (err) { console.warn("Google Calendar sync failed for " + u.id + ": " + err); }
  });
}

function status(user) {
  return {
    connected: connected(user),
    clientId: user.getString("gClientId"),
    hasSecret: !!user.getString("gClientSecret"),
    error: user.getString("gError"),
  };
}

// Step 1 of connecting: remember the Google project details and send the browser to Google.
function start(app, user, body) {
  const origin = String(body.origin || "");
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) throw new BadRequestError("Missing or invalid app address.");
  const clientId = String(body.clientId || user.getString("gClientId") || "").trim();
  const secret = String(body.clientSecret || user.getString("gClientSecret") || "").trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new BadRequestError("That Client ID doesn't look right. It ends in .apps.googleusercontent.com.");
  if (!secret) throw new BadRequestError("Paste the Client secret too.");
  const state = $security.randomString(32);
  const redirect = origin + "/api/tm/google/callback";
  user.set("gClientId", clientId);
  user.set("gClientSecret", secret);
  user.set("gState", state);
  user.set("gRedirect", redirect);
  user.set("gTimeZone", String(body.timeZone || "UTC").slice(0, 64));
  app.save(user);
  return AUTH_URL() + "?" + qs({
    client_id: clientId, redirect_uri: redirect, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", state,
  });
}

// Step 2: Google sends the browser back here with a one-time code.
function callback(app, query) {
  const state = String(query.state || "");
  if (!/^[A-Za-z0-9]{32}$/.test(state)) throw new BadRequestError("This link has expired. Start again from Settings.");
  let user;
  try { user = app.findFirstRecordByData("users", "gState", state); } catch (_) { throw new BadRequestError("This link has expired. Start again from Settings."); }
  const home = user.getString("gRedirect").replace(/\/api\/tm\/google\/callback$/, "");
  const back = (params) => home + "/?" + qs(params);
  user.set("gState", "");
  if (query.error) { app.save(user); return back({ google: "error", msg: "Google said: " + query.error }); }
  try {
    const res = call("POST", TOKEN_URL(), null, null, {
      code: String(query.code || ""), client_id: user.getString("gClientId"), client_secret: user.getString("gClientSecret"),
      redirect_uri: user.getString("gRedirect"), grant_type: "authorization_code",
    });
    if (res.statusCode !== 200 || !res.json.refresh_token) throw fail("Google didn't hand over access", res);
    user.set("gRefresh", res.json.refresh_token);
    user.set("gAccess", res.json.access_token);
    user.set("gAccessExp", Math.floor(Date.now() / 1000) + (res.json.expires_in || 3600));
    user.set("gError", "");
    ensureCalendar(user);
    app.save(user);
    const result = reconcileUser(app, user);
    return back(result.ok ? { google: "connected" } : { google: "error", msg: result.error });
  } catch (err) {
    app.save(user);
    return back({ google: "error", msg: String(err.message || err) });
  }
}

function ensureCalendar(user) {
  const token = user.getString("gAccess"), tz = user.getString("gTimeZone") || "UTC";
  const existing = user.getString("gCalendarId");
  if (existing && call("GET", API() + "/calendars/" + encodeURIComponent(existing), token).statusCode === 200) return;
  const res = call("POST", API() + "/calendars", token, { summary: "Tasks", timeZone: tz, description: "Tasks from your Task Manager app. Edit tasks in the app, not here." });
  if (res.statusCode >= 300) throw fail("Couldn't create the Tasks calendar", res);
  user.set("gCalendarId", res.json.id);
  call("PATCH", API() + "/users/me/calendarList/" + encodeURIComponent(res.json.id), token,
    { defaultReminders: [{ method: "popup", minutes: TIMED_REMINDER_MINUTES }] });
}

// Stops syncing; the Tasks calendar and its events stay in Google.
function disconnect(app, user) {
  ["gRefresh", "gAccess", "gState", "gError"].forEach((f) => user.set(f, ""));
  user.set("gAccessExp", 0);
  app.save(user);
  app.findRecordsByFilter("gcal_map", "owner = {:u}", "", 0, 0, { u: user.id }).forEach((m) => app.delete(m));
}

module.exports = { syncTask, removeTask, reconcileUser, reconcileAll, status, start, callback, disconnect, eventId, desired };
