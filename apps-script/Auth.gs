/**
 * Auth.gs – who is the current user and what may they do.
 *
 * Roles and areas come from SET_PEOPLE. Every API function checks these rules on the server;
 * the client only uses the same flags (permissionsFor_) to show or hide buttons.
 */

let CURRENT_USER_ = null; // memo for this server call

/**
 * The signed-in user.
 * @return {{email:string, known:boolean, inPeople:boolean, name:string, roles:string[],
 *           areas:string[], isKiosk:boolean}}
 */
function currentUser_() {
  if (CURRENT_USER_) return CURRENT_USER_;
  let email = '';
  try { email = normEmail_(Session.getActiveUser().getEmail()); } catch (e) { email = ''; }
  const person = email ? personByEmail_(email) : null;
  const roles = person ? person.roles : [];
  CURRENT_USER_ = {
    email: email,
    known: !!email,
    inPeople: !!person,
    name: person ? person.name : email,
    roles: roles,
    areas: person ? person.areas : [],
    isKiosk: roles.indexOf('KIOSK') >= 0
  };
  return CURRENT_USER_;
}

/** Blocks anonymous callers (empty e-mail). */
function requireIdentity_() {
  const u = currentUser_();
  if (!u.known) fail_('E_NO_IDENTITY');
  return u;
}

/** Owner of the script (running from the editor or a trigger) or an ADMIN. */
function isOwnerOrAdmin_() {
  let active = '';
  let effective = '';
  try { active = normEmail_(Session.getActiveUser().getEmail()); } catch (e) { active = ''; }
  try { effective = normEmail_(Session.getEffectiveUser().getEmail()); } catch (e) { effective = ''; }
  if (active && active === effective) return true;
  try { return hasRole_(currentUser_(), 'ADMIN'); } catch (e) { return false; }
}

/** For setup/seed/trigger installation: throws unless owner or admin. */
function requireOwnerOrAdmin_() {
  if (!isOwnerOrAdmin_()) throw new Error('Only the script owner or an ADMIN may run this.');
}

/** Trigger jobs: allowed for time triggers (no active user), the owner or an admin. */
function triggerCallerOk_() {
  let active = '';
  try { active = Session.getActiveUser().getEmail(); } catch (e) { active = ''; }
  return !active || isOwnerOrAdmin_();
}

// ---------------------------------------------------------------- basic checks

function hasRole_(u, role) { return u.roles.indexOf(role) >= 0; }
function hasAnyRole_(u, roles) { return roles.some(r => hasRole_(u, r)); }
function inArea_(u, area) {
  return u.areas.indexOf('*') >= 0 || u.areas.indexOf(up_(area)) >= 0;
}
function isAdmin_(u) { return hasRole_(u, 'ADMIN'); }
function isLocked_(q, part) { return splitList_(q.locked_parts).indexOf(part) >= 0; }

/** Adds parts to a locked_parts list: addLock_('QR', 'DECISION') … */
function addLock_(current) {
  const parts = splitList_(current);
  for (let i = 1; i < arguments.length; i++) if (parts.indexOf(arguments[i]) < 0) parts.push(arguments[i]);
  return parts.join(',');
}
function removeLock_(current, part) {
  return splitList_(current).filter(p => p !== part).join(',');
}

/** Role that decides and signs: SUPERVISOR on line level, APU_MANAGER on APU / PLANT level. */
function deciderRole_(q) {
  return q.level && q.level !== 'AREA' ? 'APU_MANAGER' : 'SUPERVISOR';
}

/** May sign ④ and the closure of this QRAP (the kiosk account never can). */
function isDecider_(u, q) {
  return u.known && !u.isKiosk && hasRole_(u, deciderRole_(q)) && inArea_(u, q.area_code);
}

function isQrapPilot_(u, pilots) {
  return (pilots || []).some(p => normEmail_(p.email) === u.email);
}

// ---------------------------------------------------------------- rules per section

/** Create a new QRAP in an area (line-level areas only). */
function canCreate_(u, area) {
  const a = areaByCode_(area);
  return !!a && a.level === 'AREA' && inArea_(u, area) &&
    hasAnyRole_(u, ['KIOSK', 'OPERATOR', 'TL', 'SUPERVISOR', 'ADMIN']);
}

/** Edit ①②③ until ④ is signed. */
function canEditQr_(u, q) {
  if (q.archived === true || QR_STATES.indexOf(q.status) < 0 || isLocked_(q, 'QR')) return false;
  if (isDecider_(u, q)) return true;
  return inArea_(u, q.area_code) && hasAnyRole_(u, ['KIOSK', 'OPERATOR', 'TL', 'SUPERVISOR', 'ADMIN']);
}

/** Quality may edit the ③ check data (checked / wrong / in progress). */
function canEditCheck_(u, q) {
  if (canEditQr_(u, q)) return true;
  return hasRole_(u, 'QUALITY') && q.archived !== true && QR_STATES.indexOf(q.status) >= 0 &&
    !isLocked_(q, 'QR');
}

/** Tick "shift informed" in ④ (before ④ is signed). */
function canShiftInfo_(u, q) {
  if (q.archived === true || isLocked_(q, 'DECISION')) return false;
  if ([ST.QR_OPEN, ST.WAIT_DECISION].indexOf(q.status) < 0) return false;
  return isDecider_(u, q) || (hasRole_(u, 'TL') && inArea_(u, q.area_code) && !u.isKiosk);
}

/** Sign the ④ decision. */
function canDecide_(u, q) {
  return q.status === ST.WAIT_DECISION && q.archived !== true && !isLocked_(q, 'DECISION') && isDecider_(u, q);
}

/** Edit ⑤ and ⑥ (assigned pilots and the decider). */
function canAnalyze_(u, q, pilots) {
  if (ANALYSIS_STATES.indexOf(q.status) < 0 || q.archived === true || isLocked_(q, 'ANALYSIS')) return false;
  if (u.isKiosk) return false;
  return isQrapPilot_(u, pilots) || isDecider_(u, q) || isAdmin_(u);
}

/** Edit one definitive action: analysts, or the action's own pilot. */
function canEditAction_(u, q, action, pilots) {
  if (canAnalyze_(u, q, pilots)) return true;
  return ANALYSIS_STATES.indexOf(q.status) >= 0 && q.archived !== true && !isLocked_(q, 'ANALYSIS') &&
    normEmail_(action.pilot_email) === u.email;
}

/** Add a note / review to an action: editors of the action, or the N+1 of its pilot. */
function canNoteAction_(u, q, action, pilots) {
  if (canEditAction_(u, q, action, pilots)) return true;
  const p = personByEmail_(action.pilot_email);
  return !!p && p.n1 === u.email && q.archived !== true;
}

/** Record an effectiveness slot (TL on the kiosk, TL, supervisor). */
function canEffect_(u, q) {
  if (q.status !== ST.VERIFY || q.archived === true) return false;
  return isDecider_(u, q) ||
    (inArea_(u, q.area_code) && hasAnyRole_(u, ['KIOSK', 'TL', 'SUPERVISOR']));
}

/** Sign the closure. */
function canClose_(u, q) {
  return q.status === ST.VERIFY && q.archived !== true && isDecider_(u, q);
}

/** ⑦ assessment (any state except DRAFT, never the kiosk). */
function canAssess_(u, q) {
  if (q.status === ST.DRAFT || !u.known || u.isKiosk) return false;
  return hasAnyRole_(u, ['SUPERVISOR', 'MANAGER', 'APU_MANAGER', 'QUALITY', 'ADMIN']) ||
    cfgBool_('ASSESSMENT_OPEN_TO_ALL');
}

/** Manager page. */
function canManager_(u) {
  return hasAnyRole_(u, ['MANAGER', 'APU_MANAGER', 'ADMIN']);
}

/**
 * All flags for one QRAP, used by the server guards and by the client buttons.
 * @return {Object} {editQr, editCheck, submit, shiftInfo, decide, analyze, effect, close, assess, admin, isPilot, isDecider}
 */
function permissionsFor_(u, q, pilots) {
  const editQr = canEditQr_(u, q);
  return {
    editQr: editQr,
    editCheck: canEditCheck_(u, q),
    submit: editQr && q.status === ST.DRAFT,
    shiftInfo: canShiftInfo_(u, q),
    decide: canDecide_(u, q),
    analyze: canAnalyze_(u, q, pilots),
    effect: canEffect_(u, q),
    close: canClose_(u, q),
    assess: canAssess_(u, q),
    admin: isAdmin_(u),
    isPilot: isQrapPilot_(u, pilots),
    isDecider: isDecider_(u, q)
  };
}
