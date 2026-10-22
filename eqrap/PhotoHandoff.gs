/**
 * eQRAP – photos of a new QRAP that do not travel with "Odeslat". This is a file in the Apps Script project next to
 * Code.gs; it uses the helpers of Code.gs (run_, me_, need_, rate_, obj_, savePhotoPair_, photoIds_, trash_, link_,
 * dataUrl_, publicError_).
 *   a) Photo hand-off: the kiosk shows a QR code, the operator scans it with a company phone, takes the photos there,
 *      and they appear in the kiosk form.
 *   b) Photos taken on the kiosk itself are uploaded in the background while the operator fills in the rest of the
 *      form (apiStagePhoto) – so pressing "Odeslat" sends only text and is quick.
 *   Both keep the photos under one random token per form.
 *
 * HOW IT WORKS
 *   kiosk  apiPhotoSession  → random token (kept in CacheService, bound to the kiosk's account) + the address for the QR
 *   kiosk  apiStagePhoto    → a photo taken on the kiosk: saved to Drive at once, remembered under the token
 *   phone  ?up=TOKEN        → Upload.html (marks the token "phone connected") → apiPhoneUpload: the same from the phone
 *   kiosk  apiPhotoPoll     → every few seconds: "what arrived?" – only new photos come back (as a small preview)
 *   kiosk  apiCreate        → sends the token + the photos it shows; create_ attaches them (see phonePhotos_ / phoneDone_)
 *   kiosk  apiPhotoDiscard  → the form was thrown away: its photos go to the Drive trash
 *
 * SAFETY
 *   - The phone must be signed in with a company account like everybody else (me_() is called in every function).
 *   - The token is a random 128-bit value. Only the kiosk account that made it can read what arrived, stage a photo
 *     or throw the photos away.
 *   - A phone can only ADD photos to a token; it cannot read anything. At most PS_MAX uploads per token.
 *   - The photo checks are the same as for the kiosk camera (size, first bytes) because savePhotoPair_ does them.
 */

const PS_TTL = 21600; // 6 h – the CacheService maximum
const PS_KINDS = ['WRONG', 'RIGHT'];
const PS_MAX = 20;    // uploads per token: phone and kiosk together, retakes included
const PS_GONE = 'Odkaz už neplatí. Na kiosku zobrazte nový QR kód.';

// ---- 3a. what the browsers may call
function apiPhotoSession() { return run_('apiPhotoSession', () => photoSession_()); }
function apiPhotoPoll(token, have) { return run_('apiPhotoPoll', () => photoPoll_(token, have)); }
function apiPhoneUpload(token, kind, full, thumb) { return run_('apiPhoneUpload', () => phoneUpload_(token, kind, full, thumb)); }
function apiStagePhoto(token, kind, full, thumb) { return run_('apiStagePhoto', () => stagePhoto_(token, kind, full, thumb)); }
function apiPhotoDiscard(token) { return run_('apiPhotoDiscard', () => photoDiscard_(token)); }

// ---- 3b. what each call does
function psKey_(token, kind) { return 'ps:' + token + (kind ? ':' + kind : ''); }

function tokenOf_(t) {
  t = String(t || '');
  need_(/^[0-9a-f]{32}$/.test(t), PS_GONE);
  return t;
}

function psMeta_(token) {
  try { return JSON.parse(CacheService.getScriptCache().get(psKey_(token)) || 'null'); } catch (e) { return null; }
}

/** A token of the calling kiosk account – anything else reads as "the link is no longer valid". */
function ownToken_(token) {
  token = tokenOf_(token);
  const meta = psMeta_(token);
  need_(meta && meta.owner === me_().email, PS_GONE);
  return token;
}

function uploadLink_(token) {
  const base = link_('');
  need_(base, 'Adresa aplikace není známá. Vložte ji do Nastavení → ODKAZ_APLIKACE.');
  return base + (base.indexOf('?') < 0 ? '?' : '&') + 'up=' + token;
}

/** Kiosk: opens a hand-off. The token belongs to the kiosk's account. */
function photoSession_() {
  const me = me_();
  rate_('psess', 30, 600);
  const token = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(psKey_(token), JSON.stringify({ owner: me.email }), PS_TTL);
  return { token: token, url: uploadLink_(token) };
}

/** Phone: adds (or replaces) the photo of one kind under the token. */
function phoneUpload_(token, kind, full, thumb) {
  me_(); // the phone is signed in with a company account like everybody else
  token = tokenOf_(token);
  rate_('phone', 40, 600);
  need_(psMeta_(token), PS_GONE);
  putPhoto_(token, kind, full, thumb);
  return { ok: true };
}

/** Kiosk: a photo taken on the kiosk, uploaded while the form is still being filled in. Returns the cell value. */
function stagePhoto_(token, kind, full, thumb) {
  token = ownToken_(token);
  rate_('stage', 40, 600);
  return { value: putPhoto_(token, kind, full, thumb) };
}

/** Saves the photo of one kind under the token; a retake replaces the previous photo (which goes to the trash). */
function putPhoto_(token, kind, full, thumb) {
  const cache = CacheService.getScriptCache();
  kind = kind === 'RIGHT' ? 'RIGHT' : 'WRONG';
  const n = Number(cache.get(psKey_(token, 'n'))) || 0;
  need_(n < PS_MAX, 'Příliš mnoho fotek k jednomu QRAP (max ' + PS_MAX + ' i s opakovanými). Odešlete formulář, nebo začněte nový.');
  cache.put(psKey_(token, 'n'), String(n + 1), PS_TTL); // a soft limit (not atomic) – enough against runaway uploads
  const files = [];
  try {
    const value = savePhotoPair_(full, thumb, files); // size + first-bytes checks happen in there
    need_(value, 'Chybí fotka.');
    const old = cache.get(psKey_(token, kind));
    cache.put(psKey_(token, kind), value, PS_TTL);
    if (old && old !== value) trash_(photoIds_(old));
    return value;
  } catch (e) {
    trash_(files);
    throw e;
  }
}

/**
 * Kiosk: what has arrived. Only photos the page does not have yet (`have` = the values it knows) are sent, plus
 * seen = the phone has opened the link (so the kiosk can say "phone connected"). One cache call.
 */
function photoPoll_(token, have) {
  token = ownToken_(token);
  have = obj_(have);
  const got = CacheService.getScriptCache().getAll(PS_KINDS.concat(['seen']).map(k => psKey_(token, k)));
  const out = { seen: !!got[psKey_(token, 'seen')] };
  PS_KINDS.forEach(k => {
    const v = got[psKey_(token, k)];
    if (!v || v === have[k]) return;
    const ids = photoIds_(v);
    out[k] = { value: v, thumb: dataUrl_(ids[1] || ids[0]) };
  });
  return out;
}

/** Kiosk: the form was thrown away – its photos go to the Drive trash (recoverable 30 days), the token ends. */
function photoDiscard_(token) {
  token = ownToken_(token);
  const got = CacheService.getScriptCache().getAll(PS_KINDS.map(k => psKey_(token, k)));
  trash_([].concat.apply([], PS_KINDS.map(k => photoIds_(got[psKey_(token, k)]))));
  phoneDone_(token);
  return { ok: true };
}

/**
 * Called by create_ – which photos go into the new QRAP. keep = { WRONG, RIGHT }: the photo cells the page SHOWS
 * (uploaded from the kiosk or arrived from the phone), so exactly what the operator saw is attached. A value is
 * accepted when the hand-off still has it, or – when the cache lost it (6 h, or Google evicted it) – when its files
 * are recent images in the photo folder (ownUpload_). Kinds the page showed but that cannot be attached are in
 * `lost` (the page then uploads them again from memory or says so). Every other file of the hand-off is `unused`
 * (removed or replaced on the kiosk) and goes to the trash. Never throws: photos must not block sending the ticket.
 * A page from before this version sends no `keep`, only the kinds to drop – handled the old way.
 */
function phonePhotos_(token, keep, drop) {
  const out = { WRONG: '', RIGHT: '', unused: [], lost: [], expired: false };
  token = /^[0-9a-f]{32}$/.test(String(token || '')) ? String(token) : '';
  const meta = token ? psMeta_(token) : null;
  const mine = !!(meta && meta.owner === me_().email);
  if (token && !mine) out.expired = true;
  const got = mine ? CacheService.getScriptCache().getAll(PS_KINDS.map(k => psKey_(token, k))) : {};
  const legacy = keep === undefined || keep === null;
  const want = obj_(keep);
  const dropped = Array.isArray(drop) ? drop : [];
  PS_KINDS.forEach(k => {
    const have = String(got[psKey_(token, k)] || '');
    const w = legacy ? (dropped.indexOf(k) >= 0 ? '' : have) : txt_(want[k], 200);
    if (w) {
      if (w === have || ownUpload_(w)) out[k] = w;
      else if (have) out[k] = have; // the shown photo was replaced meanwhile (phone retake): the newest one
      else out.lost.push(k);
    }
    if (have && have !== out[k]) out.unused = out.unused.concat(photoIds_(have));
  });
  return out;
}

/**
 * A photo cell the page says it uploaded, when the hand-off no longer knows it: accepted only when each file is an
 * image created in the last 24 h in the eQRAP photo folder and not in the trash – so nothing else in Drive can be
 * attached (and then read through photo_) this way.
 */
function ownUpload_(value) {
  const ids = photoIds_(value);
  if (!ids.length || ids.length > 2 || ids.some(id => !/^[\w-]{10,100}$/.test(id))) return false;
  let folder = '';
  try { folder = photoFolderId_(); } catch (e) { return false; }
  return ids.every(id => {
    try {
      const f = DriveApp.getFileById(id);
      if (f.isTrashed() || !/^image\//.test(String(f.getMimeType())) || Date.now() - f.getDateCreated().getTime() > 864e5) return false;
      const parents = f.getParents();
      while (parents.hasNext()) if (parents.next().getId() === folder) return true;
      return false;
    } catch (e) {
      return false;
    }
  });
}

/** After the QRAP is saved: the token cannot be used for a second QRAP. */
function phoneDone_(token) {
  token = String(token || '');
  if (!/^[0-9a-f]{32}$/.test(token)) return;
  CacheService.getScriptCache().removeAll([psKey_(token)].concat(PS_KINDS.concat(['n', 'seen']).map(k => psKey_(token, k))));
}

// ---- the page the phone opens (called from doGet when the address has ?up=TOKEN)
function uploadPage_(token) {
  const t = HtmlService.createTemplateFromFile('Upload');
  const boot = { token: String(token || '').replace(/[^0-9a-f]/g, '').slice(0, 32), error: '' };
  try {
    me_(); // e.g. the phone is not signed in
    // say at once when the QR code is old – before anybody takes a photo for nothing
    need_(/^[0-9a-f]{32}$/.test(boot.token) && psMeta_(boot.token), PS_GONE);
    CacheService.getScriptCache().put(psKey_(boot.token, 'seen'), '1', PS_TTL); // the kiosk shows "telefon připojen"
  } catch (e) {
    boot.error = publicError_('uploadPage', e);
  }
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return t.evaluate().setTitle('Fotky k QRAP').addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
