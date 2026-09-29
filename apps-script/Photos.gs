/**
 * Photos.gs – Foto ŠPATNĚ / Foto SPRÁVNĚ (and documents) in Google Drive.
 *
 * The browser resizes the picture first (full ≤ 1600 px, thumbnail ≤ 400 px, JPEG) and sends
 * base64 text. Files go to PHOTO_FOLDER_ID / {qrap_id} /. Users never open Drive directly:
 * apiGetPhoto returns base64, and only for files listed in the ATTACHMENT tab.
 */

const PHOTO_KINDS = ['WRONG', 'CORRECT', 'DOC'];
const PHOTO_MAX_B64 = 8 * 1024 * 1024; // about 6 MB of image data

/**
 * Uploads one photo (full + thumbnail).
 * @param {{qrapId:string, kind:string, full:string, thumb:string}} p base64 without the data: prefix
 * @return {{ok, photo:{file_id, thumb_file_id, kind}}}
 */
function apiUploadPhoto(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const q = getQrapRow_(p.qrapId);
    const kind = up_(p.kind);
    if (PHOTO_KINDS.indexOf(kind) < 0) fail_('E_PHOTO_KIND');
    const pilots = childrenOf_('PILOT', q.qrap_id);
    const allowed = kind === 'DOC' ? (canEditQr_(u, q) || canAnalyze_(u, q, pilots)) : canEditQr_(u, q);
    if (!allowed) fail_('E_FORBIDDEN');
    const full = String(p.full || '');
    const thumb = String(p.thumb || '');
    if (!full || !thumb || full.length > PHOTO_MAX_B64 || thumb.length > PHOTO_MAX_B64) fail_('E_PHOTO_SIZE');

    const folder = qrapFolder_(q.qrap_id);
    const stamp = fmt_(new Date(), 'yyyyMMdd-HHmmss');
    const base = q.qrap_id + '_' + kind + '_' + stamp;
    const fullFile = folder.createFile(Utilities.newBlob(Utilities.base64Decode(full), 'image/jpeg', base + '.jpg'));
    const thumbFile = folder.createFile(Utilities.newBlob(Utilities.base64Decode(thumb), 'image/jpeg', base + '_thumb.jpg'));

    if (kind !== 'DOC') { // one active photo per kind: the older one is marked removed
      activePhotos_(q.qrap_id).filter(a => a.kind === kind).forEach(a => dbUpdate_('ATTACHMENT', a, { removed: true }));
    }
    const row = dbInsert_('ATTACHMENT', {
      file_id: fullFile.getId(), thumb_file_id: thumbFile.getId(), qrap_id: q.qrap_id, kind: kind,
      uploaded_by: u.email, uploaded_at: nowIso_(), removed: false
    });
    return { photo: { file_id: row.file_id, thumb_file_id: row.thumb_file_id, kind: kind } };
  }, true);
}

/** Drive folder PHOTO_FOLDER_ID / {qrap_id} (created when missing). */
function qrapFolder_(qrapId) {
  const rootId = cfg_('PHOTO_FOLDER_ID');
  if (!rootId) fail_('E_NO_PHOTO_FOLDER');
  let root;
  try { root = DriveApp.getFolderById(rootId); } catch (e) { fail_('E_NO_PHOTO_FOLDER'); }
  const it = root.getFoldersByName(qrapId);
  return it.hasNext() ? it.next() : root.createFolder(qrapId);
}

/**
 * Returns a photo as base64 so users need no Drive access.
 * @param {{fileId:string, size:string}} p size: 'thumb' | 'full'
 * @return {{ok, mime:string, data:string}}
 */
function apiGetPhoto(p) {
  return apiRun_(() => {
    p = p || {};
    const fileId = str_(p.fileId, 200);
    // Security: only files that belong to a QRAP (the web app runs as the owner!).
    const att = dbFirst_('ATTACHMENT', a => a.file_id === fileId || a.thumb_file_id === fileId);
    if (!att || !fileId) fail_('E_NOT_FOUND', { id: fileId });
    const small = fileId === att.thumb_file_id;
    const cache = CacheService.getScriptCache();
    const cacheKey = 'ph_' + fileId;
    if (small) {
      const hit = cache.get(cacheKey);
      if (hit) return { mime: 'image/jpeg', data: hit };
    }
    const blob = DriveApp.getFileById(fileId).getBlob();
    const data = Utilities.base64Encode(blob.getBytes());
    if (small && data.length < 95000) cache.put(cacheKey, data, 21600);
    return { mime: blob.getContentType() || 'image/jpeg', data: data };
  });
}

/** Marks a photo as removed (the Drive file stays). */
function apiRemovePhoto(p) {
  return apiRun_(() => {
    p = p || {};
    const u = currentUser_();
    const att = dbFirst_('ATTACHMENT', a => a.file_id === p.fileId && a.removed !== true);
    if (!att) fail_('E_NOT_FOUND', { id: p.fileId });
    const q = getQrapRow_(att.qrap_id);
    if (!canEditQr_(u, q)) fail_('E_FORBIDDEN');
    dbUpdate_('ATTACHMENT', att, { removed: true });
    return {};
  }, true);
}

/** Thumbnail blobs {wrong, correct} for e-mails (missing ones are skipped). */
function photoBlobsForMail_(qrapId) {
  const out = {};
  activePhotos_(qrapId).forEach(a => {
    if (a.kind !== 'WRONG' && a.kind !== 'CORRECT') return;
    try {
      out[a.kind === 'WRONG' ? 'wrong' : 'correct'] = DriveApp.getFileById(a.thumb_file_id || a.file_id).getBlob();
    } catch (e) {
      console.warn('photo for mail not found: ' + a.file_id);
    }
  });
  return out;
}
