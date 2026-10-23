/**
 * QR Scanner web app.
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me | Who has access: whoever needs it
 * Open the /exec URL directly (not inside the editor preview) so the camera works.
 */

const SHEET_NAME = 'Scans';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('QR Scanner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Called from the page with the decoded QR text. */
function saveScan(text, source) {
  if (!text) throw new Error('Empty QR value');
  const ss = SpreadsheetApp.getActiveSpreadsheet() ||
             SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Value', 'Source', 'User']);
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.appendRow([new Date(), text, source, Session.getActiveUser().getEmail()]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, value: text };
}
