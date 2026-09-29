/**
 * Main.gs – web app entry point, HTML include helper, bootstrap data and the API wrapper.
 *
 * Flow: the browser opens the /exec URL → doGet() renders Index.html with a bootstrap JSON →
 * Index.html includes the CSS and JS partials → the client router shows ?page=… →
 * views call api*() functions through google.script.run.
 */

/**
 * Web app entry point. All pages are one single-page app; ?page=… only chooses the first view.
 * Examples: ?page=board&area=WH1 · ?page=qrap&id=WH1-2026-9-14 · ?page=decide&id=… · ?page=manager
 * @param {Object} e request event (e.parameter = URL parameters)
 * @return {HtmlService.HtmlOutput}
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const tpl = HtmlService.createTemplateFromFile('Index');
  tpl.bootJson = safeJson_(bootstrap_(params));
  return tpl.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Used in Index.html: <?!= include('Styles') ?> inserts another HTML file. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Data the page needs before the first server call: user, settings, URL parameters. */
function bootstrap_(params) {
  const clean = {};
  Object.keys(params).forEach(k => { clean[k] = str_(params[k], 100); });
  try {
    const u = currentUser_();
    if (!u.known) return { error: 'E_NO_IDENTITY', params: clean };
    return {
      params: clean,
      user: userDto_(u),
      settings: clientSettings_(),
      appUrl: appUrl_(),
      appName: APP_NAME,
      serverNow: nowIso_()
    };
  } catch (err) {
    console.error('bootstrap failed: ' + (err && err.stack || err));
    return { error: 'E_BOOT', detail: String(err && err.message || err), params: clean };
  }
}

/** What the browser may know about the current user. */
function userDto_(u) {
  return {
    email: u.email, name: u.name, roles: u.roles, areas: u.areas, isKiosk: u.isKiosk,
    inPeople: u.inPeople,
    label: u.isKiosk ? 'Kiosek ' + (u.areas.filter(a => a !== '*')[0] || '') : u.name
  };
}

/** Settings for the browser (no badge numbers, only the config keys the client needs). */
function clientSettings_() {
  const s = getSettings_();
  return {
    config: {
      IDLE_MINUTES: cfgNum_('IDLE_MINUTES'),
      BOARD_CLOSED_DAYS: cfgNum_('BOARD_CLOSED_DAYS'),
      ASSESSMENT_OPEN_TO_ALL: cfgBool_('ASSESSMENT_OPEN_TO_ALL')
    },
    areas: s.areas,
    locations: s.locations,
    shifts: s.shifts.map(x => ({ code: x.code, name: x.name, start: x.start, end: x.end, days: x.days })),
    people: s.people.map(p => ({ name: p.name, email: p.email, roles: p.roles, areas: p.areas })),
    lists: s.lists
  };
}

// ---------------------------------------------------------------- API wrapper

/**
 * Standard body of every client-callable api*() function.
 *  - checks that the caller is identified
 *  - write = true → runs fn inside withWrite_ (lock + flush + e-mails)
 *  - AppError (fail_ / failMany_) → {ok:false, errors:[{code,…}], warnings:[…]}
 *  - other errors → logged, {ok:false, errors:[{code:'E_INTERNAL', detail}]}
 * The browser therefore always gets a plain object with an `ok` flag.
 * @param {Function} fn   returns a plain object (never Date objects)
 * @param {boolean=} write
 * @return {Object}
 */
function apiRun_(fn, write) {
  try {
    requireIdentity_();
    const out = write ? withWrite_(fn) : fn();
    if (out && out.ok === false) return out;
    return Object.assign({ ok: true }, out || {});
  } catch (err) {
    return errorResult_(err);
  }
}

/** Converts an exception into the {ok:false} shape. */
function errorResult_(err) {
  if (err && err.appErrors) {
    return { ok: false, errors: err.appErrors, warnings: err.appWarnings || [] };
  }
  const msg = String(err && err.message || err);
  if (/lock|timed out|Zámek/i.test(msg)) return { ok: false, errors: [{ code: 'E_BUSY' }] };
  console.error('API error: ' + (err && err.stack || msg));
  return { ok: false, errors: [{ code: 'E_INTERNAL', detail: truncate_(msg, 300) }] };
}

/**
 * Stops the call with one user-facing error. The client translates the code (I18n.html).
 * @param {string} code e.g. 'E_FORBIDDEN'
 * @param {Object=} params extra values for the message, e.g. {field:'what'}
 */
function fail_(code, params) {
  const e = new Error(code);
  e.appErrors = [Object.assign({ code: code }, params || {})];
  throw e;
}

/** Stops the call with several validation errors (and optional warnings). */
function failMany_(errors, warnings) {
  const e = new Error('validation');
  e.appErrors = errors;
  e.appWarnings = warnings || [];
  throw e;
}
