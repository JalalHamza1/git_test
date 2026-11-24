/**
 * ============================================================================
 * PHOTO HANDOFF SERVICE (Photohandoff.js)
 * ============================================================================
 * Manages the process of taking photos via a mobile phone and syncing them
 * to the kiosk session without requiring the phone to submit the final form.
 *
 * CORE WORKFLOW:
 * 1. Kiosk requests session (apiPhotoSession) -> Gets QR code URL with a Token.
 * 2. Phone scans QR, opens Upload.html, and uploads photos (apiPhoneUpload).
 * 3. Kiosk polls for new photos (apiPhotoPoll) and displays previews.
 * 4. When form is submitted (apiCreate), photos are permanently attached.
 * ============================================================================
 */

const PS_TTL = 21600; // 6 h – the CacheService maximum
const PS_KINDS = ['WRONG', 'RIGHT'];
const PS_MAX = 20;
const PS_GONE = 'Odkaz už neplatí. Na kiosku zobrazte nový QR kód.';
const PS_BUSY = 'Aplikace je právě zaneprázdněná. Zkuste to prosím za chvíli znovu.';
const PS_IMG_TTL = 3600;

/**
 * ----------------------------------------------------------------------------
 * PUBLIC API ENDPOINTS (Called by the frontend via google.script.run)
 * ----------------------------------------------------------------------------
 */
function apiPhotoSession() { return run_('apiPhotoSession', () => photoSession_()); }
function apiPhotoPoll(token, have) { return run_('apiPhotoPoll', () => photoPoll_(token, have)); }
function apiPhoneUpload(token, kind, full, thumb, requestId) { return run_('apiPhoneUpload', () => phoneUpload_(token, kind, full, thumb, requestId)); }
function apiStagePhoto(token, kind, full, thumb) { return run_('apiStagePhoto', () => stagePhoto_(token, kind, full, thumb)); }
function apiPhotoDiscard(token) { return run_('apiPhotoDiscard', () => photoDiscard_(token)); }

/**
 * ----------------------------------------------------------------------------
 * INTERNAL IMPLEMENTATION LOGIC
 * ----------------------------------------------------------------------------
 */
function psKey_(token, kind) { return 'ps:' + token + (kind ? ':' + kind : ''); }

function tokenOf_(t) {
  t = String(t || '');
  need_(/^[0-9a-f]{32}$/.test(t), PS_GONE);
  return t;
}

function psMeta_(token) {
  try {
    const meta = JSON.parse(CacheService.getScriptCache().get(psKey_(token)) || 'null');
    return meta && (!meta.expires || meta.expires > Date.now()) ? meta : null;
  } catch (e) { return null; }
}

/** Validates that the provided token is owned by the currently active kiosk account. */
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

/** Initializes a new photo handoff session and returns the QR Code upload URL. */
function photoSession_() {
  const me = requireWriter_(true);
  rate_('psess', 30, 600);
  const token = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(psKey_(token), JSON.stringify({ owner: me.email, expires: Date.now() + PS_TTL * 1000, receipts: {} }), PS_TTL);
  return { token: token, url: uploadLink_(token) };
}

/** Receives a photo uploaded from the mobile device and saves it to the session. */
function phoneUpload_(token, kind, full, thumb, requestId) {
  requireWriter_(true);
  token = tokenOf_(token);
  need_(psMeta_(token), PS_GONE);
  rate_('phone', 40, 600);
  if (requestId != null) need_(/^[a-zA-Z0-9-]{8,64}$/.test(requestId), 'Neplatný identifikátor fotky.');
  putPhoto_(token, kind, full, thumb, requestId);
  return { ok: true };
}

/** Processes and saves a photo taken directly on the kiosk device. */
function stagePhoto_(token, kind, full, thumb) {
  requireWriter_(true);
  token = ownToken_(token);
  rate_('stage', 40, 600);
  return { value: putPhoto_(token, kind, full, thumb) };
}

/** Core function to save a photo (full & thumbnail) and link it to the session token. */
function putPhoto_(token, kind, full, thumb, requestId) {
  const cache = CacheService.getScriptCache();
  kind = oneOf_(kind, PS_KINDS, 'Neplatný druh fotky.');
  checkPhotoSizes_(full, thumb);
  
  const lock = LockService.getScriptLock();
  const receipt = requestId ? kind + ':' + requestId : '';
  const initial = psMeta_(token);
  need_(initial, PS_GONE);
  if (receipt && initial.receipts && initial.receipts[receipt]) return initial.receipts[receipt];
  const files = [];
  let value = '', old = '', duplicate = '';
  let publishing = false;
  try {
    value = savePhotoPair_(full, thumb, files);
    need_(value, 'Chybí fotka.');
    cacheThumb_(value, thumb);
    need_(lock.tryLock(10000), PS_BUSY);
    try {
      const now = cache.getAll([psKey_(token), psKey_(token, 'closing'), psKey_(token, kind)]);
      need_(now[psKey_(token)] && !now[psKey_(token, 'closing')], PS_GONE);
      const meta = JSON.parse(now[psKey_(token)]);
      duplicate = receipt && meta.receipts && meta.receipts[receipt];
      if (!duplicate) {
        const n = Number(cache.get(psKey_(token, 'n'))) || 0;
        need_(n < PS_MAX, 'Příliš mnoho fotek k jednomu QRAP (max ' + PS_MAX + ').');
        old = now[psKey_(token, kind)] || '';
        delete MEMO_[OPS_TAB];
        saveOperation_('upload:' + digest_(value), {token:token, owner:meta.owner, kind:kind, value:value, at:nowIso_()});
        const updates = {};
        updates[psKey_(token, kind)] = value;
        updates[psKey_(token, 'n')] = String(n + 1);
        if (receipt && meta.receipts) {
          meta.receipts[receipt] = value;
          updates[psKey_(token)] = JSON.stringify(meta);
        }
        const ttl = meta.expires ? Math.min(PS_TTL, Math.ceil((meta.expires - Date.now()) / 1000)) : PS_TTL;
        need_(ttl > 0, PS_GONE);
        publishing = true;
        cache.putAll(updates, ttl);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    if (!publishing) trash_(files); // a lost cache response may already have exposed these file IDs
    throw e;
  }
  if (duplicate) { trash_(files); return duplicate; }
  if (old && old !== value) trashUnreferenced_(photoIds_(old));
  return value;
}

/** Caches the image thumbnail to avoid unnecessary Google Drive reads during polling. */
function cacheThumb_(value, thumb) {
  const id = photoIds_(value)[1];
  const s = String(thumb || '');
  if (!id || s.length >= 95000 || !/^data:image\/(jpeg|png|webp|gif);base64,/.test(s)) return;
  try { CacheService.getScriptCache().put('img:' + id, s, PS_IMG_TTL); } catch (e) { /* cache full – fine */ }
}

/** Polled by the kiosk to retrieve any newly uploaded photos from the active session. */
function photoPoll_(token, have) {
  token = ownToken_(token);
  have = obj_(have);
  const cache = CacheService.getScriptCache();
  const got = cache.getAll(PS_KINDS.concat(['seen']).map(k => psKey_(token, k)));
  const out = { seen: !!got[psKey_(token, 'seen')] };
  const fresh = PS_KINDS.filter(k => {
    const v = got[psKey_(token, k)];
    return v && v !== have[k];
  });
  if (!fresh.length) return out;
  const previewId = k => { const ids = photoIds_(got[psKey_(token, k)]); return ids[1] || ids[0]; };
  const imgs = cache.getAll(fresh.map(k => 'img:' + previewId(k)));
  fresh.forEach(k => {
    const id = previewId(k);
    let thumb = imgs['img:' + id];
    if (!thumb) {
      try { thumb = dataUrl_(id); } catch (e) { console.warn('poll preview ' + id + ': ' + ((e && e.message) || e)); return; }
    }
    out[k] = { value: got[psKey_(token, k)], thumb: thumb };
  });
  return out;
}

/** Discards all uploaded photos if the user cancels the kiosk form. */
function photoDiscard_(token) {
  requireWriter_(true);
  token = ownToken_(token);
  const got = psFreeze_(token);
  trashUnreferenced_([].concat.apply([], PS_KINDS.map(k => photoIds_(got[psKey_(token, k)]))));
  phoneDone_(token);
  return { ok: true };
}

/** Finalizes the photos when the user submits the QRAP form. Unused photos are trashed. */
function phonePhotos_(token, keep, drop) {
  const out = { WRONG: '', RIGHT: '', unused: [], lost: [], expired: false, mine: false };
  token = /^[0-9a-f]{32}$/.test(String(token || '')) ? String(token) : '';
  const meta = token ? psMeta_(token) : null;
  const mine = !!(meta && meta.owner === me_().email);
  if (token && !mine) out.expired = true;
  out.mine = mine;
  const got = mine ? psFreeze_(token) : {};
  const legacy = keep === undefined || keep === null;
  const want = obj_(keep);
  const dropped = Array.isArray(drop) ? drop : [];
  PS_KINDS.forEach(k => {
    const have = String(got[psKey_(token, k)] || '');
    const w = legacy ? (dropped.indexOf(k) >= 0 ? '' : have) : txt_(want[k], 200);
    if (w) {
      if (w === have || (!have && ownUpload_(w, k, token))) out[k] = w;
      else if (have) out[k] = have;
      else out.lost.push(k);
    }
    if (have && have !== out[k]) out.unused = out.unused.concat(photoIds_(have));
  });
  return out;
}

/** Locks the session so no new photos can be uploaded during form submission. */
function psFreeze_(token) {
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  need_(lock.tryLock(5000), PS_BUSY);
  try {
    need_(!cache.get(psKey_(token, 'closing')), PS_BUSY);
    const got = cache.getAll(PS_KINDS.map(k => psKey_(token, k)));
    cache.put(psKey_(token, 'closing'), '1', PS_TTL);
    return got;
  } finally { lock.releaseLock(); }
}

/** Re-opens the session for uploads if form submission fails. */
function phoneReopen_(token) {
  token = String(token || '');
  if (!/^[0-9a-f]{32}$/.test(token)) return;
  try { CacheService.getScriptCache().remove(psKey_(token, 'closing')); } catch (e) { console.warn('photo reopen: ' + ((e && e.message) || e)); }
}

/** Validates that a file ID belongs to a recently uploaded photo. */
function ownUpload_(value, kind, token) {
  if (!token) return false;
  const binding = operation_('upload:' + digest_(value));
  if (!binding || binding.token !== token || binding.owner !== me_().email || binding.kind !== kind || binding.value !== value || Date.now()-new Date(binding.at).getTime()>864e5) return false;
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

/** Cleans up cache metadata for the session after completion. */
function phoneDone_(token) {
  token = String(token || '');
  if (!/^[0-9a-f]{32}$/.test(token)) return;
  CacheService.getScriptCache().removeAll([psKey_(token)].concat(PS_KINDS.concat(['n', 'seen', 'closing']).map(k => psKey_(token, k))));
}

/** Serves the Upload.html template when a mobile device visits the upload URL. */
function uploadPage_(token) {
  const t = HtmlService.createTemplateFromFile('Upload');
  const boot = { token: String(token || '').replace(/[^0-9a-f]/g, '').slice(0, 32), error: '' };
  try {
    requireWriter_(true);
    need_(token === boot.token && /^[0-9a-f]{32}$/.test(boot.token) && psMeta_(boot.token), PS_GONE);
    CacheService.getScriptCache().put(psKey_(boot.token, 'seen'), '1', PS_TTL);
  } catch (e) {
    boot.error = publicError_('uploadPage', e);
  }
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return t.evaluate().setTitle('Fotky k QRAP').addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}