/// <reference path="../pb_data/types.d.ts" />
// Each handler runs in its own sandbox, so shared code is loaded with require() inside it.

// The first account can be created from the app. After that, sign-up is closed
// (more people can still be added from the PocketBase dashboard).
onRecordCreateRequest((e) => {
  if (!e.hasSuperuserAuth() && e.app.countRecords("users") > 0) {
    throw new ForbiddenError("Sign-up is closed. Add more people from the PocketBase dashboard.");
  }
  e.next();
}, "users");

// App files: browsers must check for a newer version instead of guessing, so an update
// never runs a new page with an old script.
routerUse((e) => {
  if (!/^\/(api|_)\//.test(e.request.url.path)) e.response.header().set("Cache-Control", "no-cache");
  return e.next();
});

routerAdd("GET", "/api/tm/status", (e) => {
  return e.json(200, { hasUser: e.app.countRecords("users") > 0 });
});

// Returns the private calendar feed path, creating its secret token on first use.
routerAdd("GET", "/api/tm/calendar", (e) => {
  const user = e.auth;
  let token = user.getString("calToken");
  if (!token) {
    token = $security.randomString(32);
    user.set("calToken", token);
    e.app.save(user);
  }
  return e.json(200, { path: "/cal/" + token + ".ics" });
}, $apis.requireAuth("users"));

// Invalidates the old feed link (for when it was shared by mistake).
routerAdd("POST", "/api/tm/calendar/reset", (e) => {
  const user = e.auth;
  const token = $security.randomString(32);
  user.set("calToken", token);
  e.app.save(user);
  return e.json(200, { path: "/cal/" + token + ".ics" });
}, $apis.requireAuth("users"));

routerAdd("GET", "/cal/{file}", (e) => {
  const token = String(e.request.pathValue("file")).replace(/\.ics$/, "");
  if (!/^[A-Za-z0-9]{32}$/.test(token)) throw new NotFoundError("Calendar not found.");
  let user;
  try {
    user = e.app.findFirstRecordByData("users", "calToken", token);
  } catch (_) {
    throw new NotFoundError("Calendar not found.");
  }
  const records = e.app.findRecordsByFilter("tasks", "owner = {:uid} && archType = '' && due != ''", "due", 0, 0, { uid: user.id });
  const tasks = records.map((r) => ({
    id: r.id, title: r.getString("title"), desc: r.getString("desc"), due: r.getString("due"),
    time: r.getString("time"), list: r.getString("list"), priority: r.getString("priority"),
    starred: r.getBool("starred"), updated: r.getString("updated"),
  }));
  const ics = require(`${__hooks}/lib/calendar.js`).build(tasks);
  e.response.header().set("Cache-Control", "no-store");
  return e.blob(200, "text/calendar; charset=utf-8", toBytes(ics));
});

// ---- Google Calendar ----
// Every saved task is pushed to Google right away. A failure never blocks saving the
// task: the check every 10 minutes below catches up.

onRecordAfterCreateSuccess((e) => {
  e.next();
  try { require(`${__hooks}/lib/google.js`).syncTask(e.app, e.record); } catch (err) { console.warn("Google Calendar: " + err); }
}, "tasks");

onRecordAfterUpdateSuccess((e) => {
  e.next();
  try { require(`${__hooks}/lib/google.js`).syncTask(e.app, e.record); } catch (err) { console.warn("Google Calendar: " + err); }
}, "tasks");

onRecordAfterDeleteSuccess((e) => {
  e.next();
  try { require(`${__hooks}/lib/google.js`).removeTask(e.app, e.record); } catch (err) { console.warn("Google Calendar: " + err); }
}, "tasks");

cronAdd("googleCalendar", "*/10 * * * *", () => {
  try { require(`${__hooks}/lib/google.js`).reconcileAll($app); } catch (err) { console.warn("Google Calendar: " + err); }
});

routerAdd("GET", "/api/tm/google", (e) => {
  return e.json(200, require(`${__hooks}/lib/google.js`).status(e.auth));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/tm/google/start", (e) => {
  return e.json(200, { url: require(`${__hooks}/lib/google.js`).start(e.app, e.auth, e.requestInfo().body) });
}, $apis.requireAuth("users"));

// Google sends the browser here after you allow access (no app sign-in on this request).
routerAdd("GET", "/api/tm/google/callback", (e) => {
  return e.redirect(302, require(`${__hooks}/lib/google.js`).callback(e.app, e.requestInfo().query));
});

routerAdd("POST", "/api/tm/google/sync", (e) => {
  return e.json(200, require(`${__hooks}/lib/google.js`).reconcileUser(e.app, e.auth));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/tm/google/disconnect", (e) => {
  require(`${__hooks}/lib/google.js`).disconnect(e.app, e.auth);
  return e.json(200, { ok: true });
}, $apis.requireAuth("users"));

// ---- Claude connector ----
// Claude reaches this through Tailscale Funnel, which makes only /mcp public (on port 8443).
// The long random key in the address is the lock; without it the path doesn't exist.
routerAdd("POST", "/mcp/{key}", (e) => require(`${__hooks}/lib/mcp.js`).httpPost(e));
routerAdd("GET", "/mcp/{key}", (e) => require(`${__hooks}/lib/mcp.js`).httpGet(e));
routerAdd("DELETE", "/mcp/{key}", (e) => e.noContent(405));

routerAdd("GET", "/api/tm/claude", (e) => e.json(200, require(`${__hooks}/lib/mcp.js`).info(e.auth)), $apis.requireAuth("users"));
routerAdd("POST", "/api/tm/claude/enable", (e) => e.json(200, require(`${__hooks}/lib/mcp.js`).setKey(e.app, e.auth, "enable")), $apis.requireAuth("users"));
routerAdd("POST", "/api/tm/claude/reset", (e) => e.json(200, require(`${__hooks}/lib/mcp.js`).setKey(e.app, e.auth, "reset")), $apis.requireAuth("users"));
routerAdd("POST", "/api/tm/claude/disable", (e) => e.json(200, require(`${__hooks}/lib/mcp.js`).setKey(e.app, e.auth, "disable")), $apis.requireAuth("users"));
