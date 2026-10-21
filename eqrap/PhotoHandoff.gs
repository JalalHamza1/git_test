/**
 * eQRAP – photo hand-off: the kiosk shows a QR code, the operator scans it with a company phone, takes the photos
 * there, and they appear in the kiosk form. This is a NEW file in the Apps Script project (next to Code.gs);
 * it uses the helpers of Code.gs (run_, me_, need_, rate_, obj_, savePhotoPair_, photoIds_, trash_, link_).
 *
 * HOW IT WORKS
 *   kiosk  apiPhotoSession  → random token (kept in CacheService, bound to the kiosk's account) + the address for the QR
 *   phone  ?up=TOKEN        → Upload.html → apiPhoneUpload: saves the photo to Drive, remembers the file IDs under the token
 *   kiosk  apiPhotoPoll     → every 3 s: "what arrived?" – only new photos are sent back (as a small preview)
 *   kiosk  apiCreate        → sends the token; create_ attaches the photos (see phonePhotos_ / phoneDone_)
 *
 * SAFETY
 *   - The phone must be signed in with a company account like everybody else (me_() is called in every function).
 *   - The token is a random 128-bit value. Only the kiosk account that made it can read what arrived.
 *   - A phone can only ADD photos to a token; it cannot read anything. Max 12 uploads per token.
 *   - The photo checks are the same as for the kiosk camera (size, first bytes) because savePhotoPair_ does them.
 */

const PS_TTL = 21600; // 6 h – the CacheService maximum
const PS_KINDS = ['WRONG', 'RIGHT'];
const PS_GONE = 'Odkaz už neplatí. Na kiosku zobrazte nový QR kód.';

// ---- 3a. what the browsers may call
function apiPhotoSession() { return run_('apiPhotoSession', () => photoSession_()); }
function apiPhotoPoll(token, have) { return run_('apiPhotoPoll', () => photoPoll_(token, have)); }
function apiPhoneUpload(token, kind, full, thumb) { return run_('apiPhoneUpload', () => phoneUpload_(token, kind, full, thumb)); }

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
  const cache = CacheService.getScriptCache();
  need_(psMeta_(token), PS_GONE);
  kind = kind === 'RIGHT' ? 'RIGHT' : 'WRONG';
  const n = Number(cache.get(psKey_(token, 'n'))) || 0;
  need_(n < 12, 'Příliš mnoho fotek k jednomu QR kódu. Na kiosku zobrazte nový.');
  cache.put(psKey_(token, 'n'), String(n + 1), PS_TTL); // a soft limit (not atomic) – enough against runaway uploads
  const files = [];
  try {
    const value = savePhotoPair_(full, thumb, files); // size + first-bytes checks happen in there
    need_(value, 'Chybí fotka.');
    const old = cache.get(psKey_(token, kind));
    cache.put(psKey_(token, kind), value, PS_TTL);
    if (old) trash_(photoIds_(old)); // a retake replaces the previous photo
  } catch (e) {
    trash_(files);
    throw e;
  }
  return { ok: true };
}

/** Kiosk: what has arrived. Only photos the page does not have yet (`have` = the values it knows) are sent. */
function photoPoll_(token, have) {
  token = tokenOf_(token);
  const meta = psMeta_(token);
  need_(meta && meta.owner === me_().email, PS_GONE);
  const cache = CacheService.getScriptCache();
  have = obj_(have);
  const out = {};
  PS_KINDS.forEach(k => {
    const v = cache.get(psKey_(token, k));
    if (!v || v === have[k]) return;
    const ids = photoIds_(v);
    out[k] = { value: v, thumb: dataUrl_(ids[1] || ids[0]) };
  });
  return out;
}

/**
 * Called by create_. Returns the photo cells that arrived by phone and are wanted, the files that are not wanted
 * (removed on the kiosk, or replaced by a kiosk photo – `drop` lists the kinds) and whether the session is gone.
 * It never throws: a session that expired must not block sending the ticket.
 */
function phonePhotos_(token, drop) {
  const out = { WRONG: '', RIGHT: '', unused: [], expired: false };
  token = String(token || '');
  if (!token) return out;
  const meta = /^[0-9a-f]{32}$/.test(token) ? psMeta_(token) : null;
  if (!meta || meta.owner !== me_().email) { out.expired = true; return out; }
  const cache = CacheService.getScriptCache();
  const dropped = Array.isArray(drop) ? drop : [];
  PS_KINDS.forEach(k => {
    const v = cache.get(psKey_(token, k));
    if (!v) return;
    if (dropped.indexOf(k) >= 0) out.unused = out.unused.concat(photoIds_(v));
    else out[k] = v;
  });
  return out;
}

/** After the QRAP is saved: the token cannot be used for a second QRAP. */
function phoneDone_(token) {
  token = String(token || '');
  if (!/^[0-9a-f]{32}$/.test(token)) return;
  CacheService.getScriptCache().removeAll([psKey_(token)].concat(PS_KINDS.concat(['n']).map(k => psKey_(token, k))));
}

/** One photo as a data URL (same rules as photo_: only an image of an allowed type). */
function dataUrl_(fileId) {
  const blob = DriveApp.getFileById(fileId).getBlob();
  const type = String(blob.getContentType());
  need_(/^image\/(jpeg|png|webp|gif)$/.test(type), 'Soubor není obrázek.');
  return 'data:' + type + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

// ---- the page the phone opens (called from doGet when the address has ?up=TOKEN)
function uploadPage_(token) {
  const t = HtmlService.createTemplateFromFile('Upload');
  const boot = { token: String(token || '').replace(/[^0-9a-f]/g, '').slice(0, 32), error: '' };
  try { me_(); } catch (e) { boot.error = publicError_('uploadPage', e); } // e.g. the phone is not signed in
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return t.evaluate().setTitle('Fotky k QRAP').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}