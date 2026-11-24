/**
 * ONE-TIME TOOL – renumber the QRAPs that are left so they start again from 1.
 *
 * HOW TO USE
 *   1. Paste this file into the Apps Script project as a new script file (or push it with clasp).
 *   2. Check RENUMBER below: old number → new number. Every QRAP still in the tab Problémy must be listed.
 *   3. In the editor choose the function "renumberQrapsOnce" and press Run (as an ADMIN, the account that deployed the app).
 *   4. Read the result in the execution log. Then DELETE this file and deploy a new version.
 *
 * WHAT IT DOES (all under the save lock, so nobody saves meanwhile)
 *   - Problémy, Akce, Ověření, Hodnocení, Nedodávky, Historie: the old number becomes the new one;
 *     rows of QRAPs that no longer exist (left over from deleted QRAPs) are removed.
 *   - Operace (recovery journal) and Alerty_stav (notification state) are emptied – they still point to the old numbers.
 *   - The notification sheet (Nastavení → NOTIFIKACE_TABULKA): this app's rows for the old numbers are removed.
 *   - The counter "SEQ:Q-<year>-" in Script Properties is set to the highest new number, so the next QRAP continues after it.
 *   - Caches are cleared, open pages reload, and the notifications of the renumbered QRAPs are written again.
 */
const RENUMBER = {
  'Q-2026-009': 'Q-2026-001',
  'Q-2026-010': 'Q-2026-002'
};

function renumberQrapsOnce() {
  menuOnly_(); // only an active admin from the Sheet / editor
  const map = RENUMBER;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = [];
  const lock = LockService.getScriptLock();
  need_(lock.tryLock(30000), 'Aplikace právě ukládá. Zkuste to za chvíli znovu.');
  try {
    const qsh = ss.getSheetByName(TAB.qraps);
    need_(qsh && qsh.getLastRow() >= 2, 'List Problémy je prázdný.');
    const qhead = qsh.getRange(1, 1, 1, qsh.getLastColumn()).getValues()[0].map(x => String(x).trim());
    const qcol = qhead.indexOf('ID') + 1;
    need_(qcol, 'V listu Problémy chybí sloupec ID.');
    const existing = qsh.getRange(2, qcol, qsh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim()).filter(String);
    const missing = existing.filter(id => !map[id]);
    need_(!missing.length, 'Tyto QRAP nejsou v RENUMBER: ' + missing.join(', ') + '. Doplňte je a spusťte znovu.');
    const targets = Object.values(map);
    need_(new Set(targets).size === targets.length, 'Dvě stará čísla mají stejné nové číslo.');
    const year = targets.map(id => id.slice(0, 7));
    need_(year.every(y => y === year[0]) && targets.every(id => /^Q-\d{4}-\d{3,}$/.test(id)), 'Nová čísla musí mít tvar Q-RRRR-001 a stejný rok.');

    // Nothing may be half-saved: an unfinished operation would be lost when the journal is emptied.
    const ops = ss.getSheetByName(OPS_TAB);
    if (ops && ops.getLastRow() > 1) {
      const open = ops.getRange(2, 1, ops.getLastRow() - 1, 2).getValues()
        .filter(r => r[0] && String(r[0]).indexOf('upload:') !== 0 && (() => { try { return JSON.parse(r[1]).state !== 'done'; } catch (e) { return true; } })());
      need_(!open.length, 'V listu Operace je nedokončená operace (' + open[0][0] + '). Otevřete aplikaci, nechte ji dokončit a spusťte znovu.');
    }

    // 1. Data tabs: rename the QRAP number, drop rows of QRAPs that no longer exist.
    [[TAB.qraps, 'ID'], [TAB.actions, 'QRAP'], [TAB.effects, 'QRAP'], [TAB.assess, 'QRAP'], [TAB.shortages, 'QRAP'], [TAB.log, 'QRAP']]
      .forEach(([name, header]) => {
        const sh = ss.getSheetByName(name);
        if (!sh || sh.getLastRow() < 2) return;
        const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim());
        const col = head.indexOf(header) + 1;
        need_(col, 'V listu „' + name + '“ chybí sloupec „' + header + '“.');
        const range = sh.getRange(2, col, sh.getLastRow() - 1, 1);
        const ids = range.getValues();
        const drop = [];
        let renamed = 0;
        ids.forEach((r, i) => {
          const id = String(r[0]).trim();
          if (map[id]) { r[0] = "'" + map[id]; renamed++; }
          else if (id) drop.push(i + 2);
        });
        range.setValues(ids);
        drop.reverse().forEach(row => sh.deleteRow(row));
        report.push(name + ': přečíslováno ' + renamed + ', odstraněno ' + drop.length);
      });

    // 2. Journals that still point to the old numbers.
    [OPS_TAB, ALERTS.TAB].forEach(name => {
      const sh = ss.getSheetByName(name);
      if (sh && sh.getLastRow() > 1) { sh.deleteRows(2, sh.getLastRow() - 1); report.push(name + ': vyprázdněno'); }
    });

    // 3. This app's rows in the notification sheet for the old numbers (they are written again in step 5).
    try {
      const t = notifTarget_();
      const app = String(setting_('NOTIFIKACE_APLIKACE') || 'eQRAP');
      [t.normal, t.safety].forEach(tab => {
        const sh = tab.sh, a = tab.head.indexOf('Aplikace'), u = tab.head.indexOf('URL');
        if (sh.getLastRow() < 2 || a < 0 || u < 0) return;
        const rows = sh.getRange(2, 1, sh.getLastRow() - 1, tab.head.length).getValues();
        const drop = [];
        rows.forEach((r, i) => {
          const id = alertUrlId_(r[u]);
          if (String(r[a]) === app && id && targets.indexOf(id) < 0) drop.push(i + 2);
        });
        drop.reverse().forEach(row => sh.deleteRow(row));
        report.push(sh.getName() + ': odstraněno ' + drop.length + ' upozornění se starými čísly');
      });
    } catch (e) {
      report.push('Tabulka upozornění přeskočena: ' + e.message);
    }

    // 4. The counter: the next QRAP continues after the highest new number.
    const prefix = year[0] + '-';
    const top = Math.max.apply(null, targets.map(id => parseInt(id.slice(prefix.length), 10)));
    PropertiesService.getScriptProperties().setProperty('SEQ:' + prefix, String(top));
    report.push('Počítadlo SEQ:' + prefix + ' = ' + top + ' → další QRAP bude ' + prefix + ('00' + (top + 1)).slice(-3));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  // 5. Fresh start: caches, open pages reload, notifications of the renumbered QRAPs written again.
  clearCache_();
  MEMO_ = {};
  bumpVersion_();
  const sync = syncAlerts_(null);
  report.push('Upozornění znovu zapsána: ' + (sync.ok ? 'ano (' + sync.written + ')' : 'zkusí se znovu automaticky'));
  console.log(report.join('\n'));
  toast_('Přečíslování hotovo. Podrobnosti: Apps Script → Spuštění.');
  return report;
}
