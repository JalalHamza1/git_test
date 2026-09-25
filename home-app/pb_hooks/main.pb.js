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
