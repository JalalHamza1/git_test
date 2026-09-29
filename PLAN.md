# eQRAP Logistika – build plan

Google Apps Script (V8) web app for QRAP v3.0 in the warehouse. One Google Sheet is the
database, Drive holds the photos, MailApp sends the e-mails. Everything the user pastes lives
in `apps-script/` (flat, no subfolders). Documents live in the repository root.

## 1. Files

### Server (`.gs`, one global scope, private helpers end with `_`)

| File | Purpose | Main functions |
|---|---|---|
| `Main.gs` | Web app entry, HTML include, bootstrap data, API wrapper | `doGet`, `include`, `apiRun_`, `bootstrap_`, `fail_`, `failMany_` |
| `Config.gs` | Constants, table schema, settings loader, shift maths | `SCHEMA`, `getSettings_`, `cfg_`, `route_`, `shiftAt_`, `nextShiftStart_`, `onEdit`, `clearCaches` |
| `Util.gs` | Dates in Europe/Prague, text cleaning, ids, HTML escaping | `tzDate_`, `parseDateTime_`, `todayStr_`, `str_`, `newId_`, `esc_` |
| `Db.gs` | Sheet access by header name, write buffer, lock, big cache | `dbTable_`, `dbInsert_`, `dbUpdate_`, `dbFlush_`, `withWrite_`, `cachePutBig_` |
| `Auth.gs` | Current user, roles, every permission rule | `currentUser_`, `canEditQr_`, `canDecide_`, `permissionsFor_` |
| `Audit.gs` | Append-only audit log, header-mapped appends | `audit_`, `auditFlush_`, `appendByHeader_` |
| `Qrap.gs` | Loading a QRAP, section rules, chips, "čeká na", detail DTO | `getQrapRow_`, `section3State_`, `computeChips_`, `apiGetQrap` |
| `Wizard.gs` | Kiosk wizard steps 1–4, submit, drafts, repeat suggestions | `apiSaveStep`, `apiSubmitQrap`, `apiGetWizard`, `apiGetDrafts`, `apiSuggestRepeats` |
| `Board.gs` | Board rows (cached), filters, paging | `apiGetBoard`, `boardRow_`, `invalidateBoardCache_` |
| `Decision.gs` | ④ shift ticks and decision signature | `apiSaveShiftInfo`, `apiSignDecision` |
| `Escalation.gs` | APU copy with suffix letter, escalation lists | `escalateQrap_`, `apiGetEscalations` |
| `Analysis.gs` | ⑤ 5 Why, lesson, standard question, pilots, status recompute | `apiSaveAnalysis`, `apiAddPilot`, `recomputeAnalysisStatus_` |
| `Actions.gs` | ⑥ definitive actions, notes, reviews, "Moje akce" | `apiSaveDefAction`, `apiRemoveDefAction`, `apiAddActionNote`, `apiGetMyActions` |
| `Effectiveness.gs` | 5-shift effectiveness, closure checklist and signature | `apiSaveEffect`, `apiSignClosure`, `closureChecklist_` |
| `Assessment.gs` | ⑦ QRQC assessment | `apiSaveAssessment` |
| `Photos.gs` | Upload to Drive, serve as base64, remove flag | `apiUploadPhoto`, `apiGetPhoto`, `apiRemovePhoto` |
| `Mail.gs` | Routing, templates E1–E11, de-duplication, MAIL_LOG | `mailE1_` … `mailE11_`, `mailFlush_` |
| `Triggers.gs` | Time-driven jobs | `installTriggers`, `removeTriggers`, `checkReminders`, `dailyDigest`, `archiveOld` |
| `Manager.gs` | Manager tiles, "Potřebuje vás", filters, search | `apiGetManager`, `apiSearch` |
| `Admin.gs` | Unlock, reopen, archive (reason required, audited) | `apiAdminUnlock`, `apiAdminReopen`, `apiAdminArchive` |
| `Setup.gs` | Create tabs + example settings, self test | `setup`, `selfTest` |
| `SeedDemo.gs` | About 9 demo QRAPs in all states | `seedDemoData` |

### Client (`.html`)

| File | Purpose |
|---|---|
| `Index.html` | Page skeleton; includes every partial; injects bootstrap JSON |
| `Styles.html` | All CSS (touch friendly, role and chip colours) |
| `I18n.html` | CZ/EN dictionary and `t()` |
| `ClientCore.html` | `h()` DOM builder, `api()` promise wrapper, offline banner, router, toast/modal, formatting, idle timer, photo resize, QR code |
| `ClientForms.html` | Reusable form widgets (yes/no, segmented buttons, selects, person picker, chips, errors) |
| `ViewBoard.html` | Kiosk board (one row per QRAP, newest at the bottom, load older on scroll) |
| `ViewWizard.html` | 5-step wizard (steps 1–2) and its framework |
| `ViewWizardSteps.html` | Wizard steps 3–5 |
| `ViewQrap.html` | Read-only detail of all 7 sections, buttons, QR code, admin box |
| `ViewDecide.html` | ④ decision (phone) and closure page |
| `ViewAnalysis.html` | ⑤ + ⑥ pilot form (PC) |
| `ViewActions.html` | "Moje akce" (pilot / N+1) |
| `ViewEffect.html` | 5-shift effectiveness |
| `ViewAssess.html` | ⑦ assessment |
| `ViewManager.html` | Manager page |
| `ViewEscalation.html` | APU / PLANT lists |

Plus `appsscript.json` (Europe/Prague, V8, executeAs USER_DEPLOYING, access DOMAIN).

## 2. Sheet tabs

Settings (edited by the admin): `SET_CONFIG`, `SET_AREAS`, `SET_LOCATIONS`, `SET_SHIFTS`,
`SET_PEOPLE`, `SET_ROUTING`, `SET_LISTS`.

Data: `QRAP`, `ALERT`, `ATTACHMENT`, `IMMEDIATE_ACTION`, `SHIFT_INFO`, `PILOT`, `WHY_STEP`,
`DEF_ACTION`, `ACTION_NOTE`, `EFFECTIVENESS`, `ASSESSMENT` (all with created/updated columns),
and the logs `AUDIT_LOG`, `MAIL_LOG`, `COUNTER`.

The column lists are defined once in `SCHEMA` (Config.gs). `setup()` creates the tabs from it,
and `Db.gs` maps every read and write by header name.

## 3. Request flow

1. `doGet(e)` reads the URL parameters, loads the user and the settings and renders `Index.html`
   with a bootstrap JSON.
2. The client router (`ClientCore.html`) shows the view for `?page=…` and switches views
   without reloading (`google.script.history`).
3. Views call `api('apiXxx', payload)`. Every `apiXxx` function wraps its body in `apiRun_`,
   which checks identity, catches errors and (for writes) runs the body in `withWrite_`
   (script lock → body → flush sheet writes → flush audit → send queued e-mails → clear board cache).

## 4. Build order

1. Plan + assumptions.
2. Server core: Config, Util, Db, Audit, Auth, Main.
3. Domain: Qrap, Wizard, Board, Decision, Escalation, Analysis, Actions, Effectiveness,
   Assessment, Photos, Mail, Triggers, Manager, Admin.
4. Setup, SeedDemo, selfTest.
5. Client: Styles, I18n, ClientCore, ClientForms, views.
6. Local test harness (Node mocks of SpreadsheetApp, DriveApp, MailApp, …) that runs `setup`,
   `seedDemoData`, `selfTest` and every rule; browser smoke test of the UI with a mocked
   `google.script.run`.
7. SETUP.md, EXPLAIN.md, TESTING.md.

See `ASSUMPTIONS.md` for every choice not fixed by the specification.
