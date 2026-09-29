# eQRAP Logistika – how the code works

This document is for an intermediate programmer who wants to understand, change and extend the app.
Read it together with the code: every function named here exists under exactly that name.

---

## 1. Architecture

```
  Kiosk tablet (KIOSK account)      Supervisor phone          Office PC (pilot, manager)
            │                              │                              │
            └──────────── browser: one single-page app (Index.html) ──────┘
                             │   HTML/CSS/JS partials included by include()
                             │   views draw into <main id="app">, router = ?page=…
                             │
                  google.script.run.apiXxx(payload)      (only way to reach the server)
                             │
  ┌──────────────────────────▼─────────────────────────────────────────────────────────┐
  │ Apps Script server (V8, runs as the owner)                                          │
  │                                                                                     │
  │  Main.gs  doGet() · include() · apiRun_() ── identity check, error → {ok:false}      │
  │     │                                                                               │
  │     ├─ Auth.gs      who is the user (SET_PEOPLE) and what may they do               │
  │     ├─ domain       Wizard · Board · Decision · Escalation · Analysis · Actions ·   │
  │     │               Effectiveness · Assessment · Photos · Manager · Admin           │
  │     ├─ Qrap.gs      shared rules: ③ complete, chips, "čeká na", closure checklist   │
  │     ├─ Db.gs        tables by header name, write buffer, withWrite_() = lock+flush  │
  │     ├─ Audit.gs     every insert / update → AUDIT_LOG                                │
  │     └─ Mail.gs      E1–E11 queued, sent after the save, MAIL_LOG de-duplication     │
  │                                                                                     │
  │  Triggers.gs  hourly checkReminders · daily dailyDigest · weekly archiveOld         │
  └───────────────┬───────────────────────────────┬──────────────────────┬─────────────┘
                  │                               │                      │
        Google Sheet (database)            Google Drive               MailApp
        SET_* settings tabs                PHOTO_FOLDER_ID/{id}/      (sender = owner)
        QRAP + child tabs + logs           full + thumbnail JPEG
        CacheService: settings (10 min), board rows (60 s), thumbnails
```

Key ideas:

- **One `doGet`, one page.** `?page=…` only chooses the first view. After that the client switches
  views itself (`go()` in ClientCore) and updates the URL with `google.script.history`.
- **Every server function returns a plain object with `ok`.** Errors are codes (`E_REQUIRED`,
  `E_FORBIDDEN` …) that the browser translates with `I18n.html`.
- **Every write runs inside `withWrite_`**: script lock → fresh reads → body → one flush of all
  sheet changes → audit rows → e-mails → board cache invalidated.
- **The server checks everything again.** Hiding a button is not security; `Auth.gs` is.

---

## 2. What each file does

### Server (`.gs`)

| File | Responsibility |
|---|---|
| `Main.gs` | `doGet` renders `Index.html` with the bootstrap JSON (user, settings, URL parameters). `include()` for partials. `apiRun_` = the standard wrapper of every API; `fail_` / `failMany_` stop a call with error codes. |
| `Config.gs` | Constants (`ST` states, roles, `CONFIG_DEFAULTS`), the table **schema** (`SCHEMA`), the settings loader (`getSettings_`), config getters (`cfg_`, `cfgNum_`, `cfgBool_`), routing (`route_`), shift maths (`shiftAt_`, `nextShiftStart_`), `onEdit` (clears the settings cache), `clearCaches`. |
| `Util.gs` | Prague time helpers (`tzDate_`, `parseDateTime_`, `todayStr_`, `addDaysStr_`), text cleaning (`str_`, `yesNo_`, `intOrBlank_`), `newId_`, `esc_` (HTML escaping for e-mails), `safeJson_`, `clientRow_`. |
| `Db.gs` | `dbTable_` (one bulk read per tab, memoised), `dbInsert_` / `dbUpdate_` (buffered, audited), `dbFlush_` (one `setValues` per block of rows), `withWrite_`, `nextQrapId_`, `cachePutBig_` / `cacheGetBig_`. |
| `Audit.gs` | `audit_` (buffer), `auditFlush_`, `appendByHeader_` (append to a log tab reading only its header), `readLogColumn_`. |
| `Auth.gs` | `currentUser_`, `requireIdentity_`, `isOwnerOrAdmin_`, and one function per permission rule (`canEditQr_`, `canDecide_`, `canAnalyze_`, …) plus `permissionsFor_` (the flags the client uses for buttons). |
| `Qrap.gs` | `getQrapRow_`, child row helpers, `section3State_` (③ rule), `refreshContainment_` (QR_OPEN ↔ WAIT_DECISION), `effState_`, `computeChips_`, `waitingFor_`, `closureChecklist_`, `apiGetQrap` / `qrapDetail_`. |
| `Wizard.gs` | `apiSaveStep` (steps 1–4), `validateStep1_`, `validateStep4_`, `setAlerts_`, `saveIaRows_`, `apiSubmitQrap`, `apiGetWizard`, `apiGetDrafts`, `apiSuggestRepeats`. |
| `Board.gs` | `apiGetBoard` (filters, paging with `before`), `boardRowsCached_`, `buildBoardRows_`, `boardRow_`, `invalidateBoardCache_`. |
| `Decision.gs` | `apiSaveShiftInfo`, `apiSignDecision`, `decisionGuards_`. |
| `Escalation.gs` | `escalateQrap_` (APU copy with suffix letter), `baseId_`, `nextSuffix_`, `apiGetEscalations`. |
| `Analysis.gs` | `apiSaveAnalysis` (5 Why, lesson, standard), `saveWhySteps_`, `syncStdAction_`, `recomputeAnalysisStatus_`, `apiAddPilot`. |
| `Actions.gs` | `apiSaveDefAction`, `validateDefAction_`, `apiRemoveDefAction`, `apiAddActionNote`, `apiSetReviewDone`, `apiGetMyActions`. |
| `Effectiveness.gs` | `apiSaveEffect` (5 slots, NOT_EFFECTIVE → ANALYSIS), `apiSignClosure`. |
| `Assessment.gs` | `apiSaveAssessment`. |
| `Photos.gs` | `apiUploadPhoto`, `qrapFolder_`, `apiGetPhoto` (only files listed in ATTACHMENT), `apiRemovePhoto`, `photoBlobsForMail_`. |
| `Mail.gs` | `queueMail_`, `queueQrapMail_` (subject + layout), `qrapMailHtml_`, rules `mailE1_` … `mailE11_`, `mailFlush_` (de-duplication, quota, MAIL_LOG). |
| `Triggers.gs` | `installTriggers`, `removeTriggers`, `checkReminders` (E4, E10), `dailyDigest` (E7, E8), `archiveOld`, digest builders `queueDigestE7_` / `queueDigestE8_`. |
| `Manager.gs` | `apiGetManager`, `managerSets_` (shared with E8), `needsYou_`, `assessPerSupervisor_`, `apiSearch`. |
| `Admin.gs` | `apiAdminUnlock`, `apiAdminReopen`, `apiAdminArchive` (reason required, audited). |
| `Setup.gs` | `setup` (tabs, headers, formats, example settings), `ensureSheet_`, `seedSettings_`, `selfTest`. |
| `SeedDemo.gs` | `seedDemoData` – 9 demo QRAPs in all states. |

### Client (`.html`)

| File | Responsibility |
|---|---|
| `Index.html` | Skeleton: header, `#app`, toast, modal; loads the QR library; injects `window.BOOT`; includes all partials; calls `App.start()`. |
| `Styles.html` | All CSS. Role colours (operator `#D7861B`, supervisor `#2F6DB5`, pilot `#7B4FB8`, manager `#0E8C83`), chip colours, ≥ 52 px touch targets, phone layout. |
| `I18n.html` | `I18N.cz` / `I18N.en`, `t(key, params)`, `setLang`. Every text of the UI and every error code. |
| `ClientCore.html` | `App` state, `h()` DOM builder (text is always inserted as text → no XSS), `api()` (promise wrapper around `google.script.run`, offline banner + retry), `go()` / `render()` router, `toast`, `modal`, `confirmDlg`, `promptDlg`, `warnConfirm`, Prague date helpers, lists and people, `resizeImage`, `loadPhoto`, `qrCode`, `Idle` timer, header. |
| `ClientForms.html` | Widgets: `field`, `segmented`, `multiToggle`, `yesNo`, `selectEl`, inputs, `personSelect`, `button` (disables itself while saving), `chipsEl`, `sectionCard`, `kvList`, `table`. |
| `ViewBoard.html` | The board. |
| `ViewWizard.html` | Wizard state, navigation, saving, idle save, steps 1 and 2. |
| `ViewWizardSteps.html` | Steps 3–5 and the browser-side checks of every step. |
| `ViewQrap.html` | Detail of all 7 sections, buttons, QR code, Quality check form, admin box. |
| `ViewDecide.html` | ④ decision page and the closure page (phone). |
| `ViewAnalysis.html` | ⑤ + ⑥ for the pilot (PC). |
| `ViewActions.html` | "Moje akce". |
| `ViewEffect.html` | 5-shift effectiveness. |
| `ViewAssess.html` | ⑦ assessment. |
| `ViewManager.html` | Manager page. |
| `ViewEscalation.html` | APU / PLANT lists. |

---

## 3. One QRAP from the kiosk to closure

**Kiosk, board.** The tablet opens `APP_URL?page=board&area=WH1`. `doGet` → `bootstrap_` →
`currentUser_` finds `kiosk.wh1@…` in SET_PEOPLE (role KIOSK) → `Index.html` is rendered with
`window.BOOT`. `App.start()` → `render()` → `App.views.board.render()` → `api('apiGetBoard', …)` →
`boardRowsCached_` (cache miss → `buildBoardRows_` → `computeChips_` per row). The list is scrolled
to the bottom.

**Step 1 – Popis.** The operator taps **+ Nový QRAP** → `go('new')` → wizard. On **Další**:
`Wiz.validate[1]` (browser) → `api('apiSaveStep', {step: 1, mode: 'next'})` → `saveStep_` →
`saveStep1_`: `cleanStep1_` → `validateStep1_` → `nextQrapId_` (under the lock of `withWrite_`) →
`dbInsert_('QRAP')` with status DRAFT and `s1_done_at`. If SAFETY = ano, `mailE2_` is queued now.
`withWrite_` then runs `dbFlush_` → `auditFlush_` → `mailFlush_` → `invalidateBoardCache_`.

**Step 2 – Fotky.** Taking a photo → `resizeImage` (1600 px and 400 px JPEG in the browser) →
`apiUploadPhoto` → `qrapFolder_` → two Drive files → `dbInsert_('ATTACHMENT')`. **Další** →
`saveStep2_` checks `photosOk_` (both photos or a written exception).

**Step 3 – Upozornění.** `saveStep3_` → `setAlerts_` inserts ALERT rows (un-ticked roles get
`removed = TRUE`) and fills `notified_to` from `route_`.

**Step 4 – Opatření.** `saveStep4_` → `validateStep4_`; with **Další** also `section3State_` must be
complete, with **Dokončí TL později** only the risk answer is needed. `saveIaRows_` saves the action
rows. Risk = ANO → Kvalita ticked (`setAlerts_`) and `mailE3_` queued.

**Step 5 – Odeslat.** `apiSubmitQrap` → `submitQrap_`: `validateStep1_`, `photosOk_`, ≥ 1 alert,
`validateStep4_` → status QR_OPEN, `sent_at` → `refreshContainment_` (→ WAIT_DECISION if ③ is
complete) → `mailE1_` (+ E2 / E3 if not sent yet; the MAIL_LOG key makes them "once"). The browser
goes back to the board with a toast; the new row is at the bottom.

**TL completes ③ later.** From the detail page "Doplnit opatření ③" → wizard step 4 → `saveStep4_`
→ `refreshContainment_` moves QR_OPEN → WAIT_DECISION and stores `containment_done_at`.
If nobody finishes it, the hourly `checkReminders` sends `mailE10_` 24 h after KDY.

**Supervisor, phone.** The supervisor scans the QR code (it opens `?page=decide&id=…`).
`apiSaveShiftInfo` stores the shift ticks. **Podepsat** → `apiSignDecision` → `signDecision_` →
`decisionGuards_`. Warnings (repeat, wrong > 0, shifts not informed) come back as
`{ok:false, needConfirm:true}`; after confirmation the call is repeated with `confirmWarnings`.
- *Pokračovat* → PILOT rows, status ANALYSIS, `mailE5_`.
- *Problém vyřešen* → CLOSED_SOLVED (blocked when SAFETY), `mailE9_`.
- *Eskalace* → `escalateQrap_` creates `…-A` at the parent area, original → ESCALATED, `mailE6_`.
The signature adds `QR,DECISION` to `locked_parts`. If nobody decides before the next shift starts,
`checkReminders` sends `mailE4_`.

**Pilot, PC.** `?page=analysis&id=…`. **Uložit analýzu** → `apiSaveAnalysis` → `saveWhySteps_`,
`syncStdAction_` (standard = ANO creates the STD action), `recomputeAnalysisStatus_`.
Each action row → `apiSaveDefAction` → `validateDefAction_` → insert (+ `mailE5b_`) → recompute:
root cause + ≥ 1 action → ACTIONS_OPEN; all actions CLOSED → VERIFY. Overdue actions are e-mailed by
`dailyDigest` → `queueDigestE7_` (cc N+1 after `OVERDUE_N1_DAYS`).

**TL, kiosk.** `?page=effect&id=…` → `apiSaveEffect` per slot (5 different date + shift pairs).
NOT_EFFECTIVE → status ANALYSIS, round + 1 (derived by `effState_`), `mailE11_`.

**Supervisor closes.** `?page=close&id=…` shows `closureChecklist_`. **Podepsat uzavření** →
`apiSignClosure` → status CLOSED, `locked_parts += ANALYSIS`, `mailE9_`.

**Assessment.** Any time after DRAFT: `?page=assess&id=…` → `apiSaveAssessment`.

**Later.** `archiveOld` (Sunday night) sets `archived = TRUE` after `ARCHIVE_AFTER_DAYS`.

---

## 4. Rules, guards and e-mails → where they live

| Rule | File · function |
|---|---|
| QRAP number `{AREA}-{YYYY}-{M}-{seq}`, monthly counter, lock | `Db.gs · nextQrapId_` (called in `withWrite_`) |
| Suffix letter for copies | `Escalation.gs · nextSuffix_` |
| SAFETY required, no default | `Wizard.gs · validateStep1_`, `ViewWizardSteps · Wiz.validate[1]` |
| CO required, warning < 10 characters | same |
| KDY not in the future, warning > 24 h | same |
| KOLIK integer ≥ 0; 0 only with "NOK situace bez kusů" | same |
| Repeat = ANO → existing QRAP, same area, last 7 days | `Wizard.gs · repeatRefValid_` |
| Repeat suggestions | `Wizard.gs · apiSuggestRepeats` |
| Both photos or exception with reason | `Qrap.gs · photosOk_`, `Wizard.gs · saveStep2_`, `submitQrap_` |
| ② ≥ 1 role, Kvalita automatic when risk = ANO | `Wizard.gs · saveStep3_`, `saveStep4_`, `setAlerts_` |
| Wrong ≤ checked, restore ≥ KDY, done ≤ now and ≥ KDY | `Wizard.gs · validateStep4_` |
| ③ complete (risk, check data, actions done, process) | `Qrap.gs · section3State_` |
| QR_OPEN ↔ WAIT_DECISION | `Qrap.gs · refreshContainment_` |
| Send guards (DRAFT → QR_OPEN) | `Wizard.gs · submitQrap_` |
| Kiosk can never sign | `Auth.gs · isDecider_`, `Decision.gs · signDecision_`, `Effectiveness.gs · apiSignClosure` |
| Solved blocked by SAFETY, comment required, repeat / wrong warnings | `Decision.gs · decisionGuards_` |
| Pokračovat needs ≥ 1 pilot; pilots can't be removed | `Decision.gs · decisionGuards_`, `Analysis.gs · apiAddPilot` |
| Escalation copy linked both ways | `Escalation.gs · escalateQrap_`, `Decision.gs · signDecision_` (`assign_ref`) |
| Signature locks parts; admin unlock with reason | `Auth.gs · addLock_ / isLocked_`, `Admin.gs · apiAdminUnlock` |
| 5 Why: no gaps, root on a filled step, warning < 3 | `Analysis.gs · saveAnalysis_` |
| Standard = ANO → action "Aktualizovat standard" | `Analysis.gs · syncStdAction_` |
| Action: text, root step, known pilot, plan ≥ today (new), done ≤ today, https link | `Actions.gs · validateDefAction_` |
| Done date closes the action; removing = REMOVED | `Actions.gs · saveDefAction_`, `apiRemoveDefAction` |
| ANALYSIS → ACTIONS_OPEN → VERIFY | `Analysis.gs · recomputeAnalysisStatus_` |
| 5 different shifts, EFFECTIVE final, NOT_EFFECTIVE → ANALYSIS | `Effectiveness.gs · saveEffect_`, `Qrap.gs · effState_` |
| Closure guards | `Qrap.gs · closureChecklist_`, `Effectiveness.gs · apiSignClosure` |
| Chips 1–7 and "čeká na" | `Qrap.gs · computeChips_`, `waitingFor_` |
| Board: open + closed in last N days, newest at the bottom, paging | `Board.gs · apiGetBoard`, `boardFilterMatch_` |
| Assessment: any state except DRAFT, never kiosk, history kept | `Auth.gs · canAssess_`, `Assessment.gs · apiSaveAssessment` |
| Reopen / archive | `Admin.gs` |
| **E1** sent → supervisor, cc manager | `Mail.gs · mailE1_` ← `Wizard.gs · submitQrap_` |
| **E2** SAFETY → EHS + supervisor, cc manager | `mailE2_` ← `saveStep1_`, `submitQrap_` |
| **E3** risk ANO → Quality, cc supervisor | `mailE3_` ← `saveStep4_`, `submitQrap_` |
| **E4** no decision by next shift | `mailE4_` ← `Triggers.gs · checkReminders` |
| **E5** Pokračovat → pilots, cc supervisor | `mailE5_` ← `signDecision_`, `apiAddPilot` |
| **E5b** new action → action pilot | `mailE5b_` ← `saveDefAction_`, `syncStdAction_` |
| **E6** escalation → APU manager, cc supervisor | `mailE6_` ← `signDecision_` |
| **E7** overdue actions digest (+ N+1) | `Triggers.gs · queueDigestE7_` ← `dailyDigest` |
| **E8** manager summary (Mon–Fri) | `Triggers.gs · queueDigestE8_` ← `dailyDigest` |
| **E9** closed → finder + supervisor | `mailE9_` ← `signDecision_` (Solved), `apiSignClosure` |
| **E10** ③ open 24 h after KDY | `mailE10_` ← `checkReminders` |
| **E11** not effective → pilots, cc supervisor | `mailE11_` ← `saveEffect_` |
| "Send once" | `Mail.gs · mailFlush_` (keys in MAIL_LOG) |

---

## 5. How data is stored and read

- **Schema first.** `SCHEMA` in `Config.gs` lists every tab and column with a type
  (`text`, `num`, `bool`, `ts`, `date`). `setup()` creates the headers from it and formats the
  columns (text columns as plain text, so Sheets never turns `01-02` into a date).
- **Reading.** `dbTable_(name)` reads the whole tab once with `getDataRange().getValues()`,
  finds columns **by header name** and converts each cell (`dbFromCell_`): timestamps become ISO
  strings, days become `yyyy-MM-dd`. The result is memoised for the rest of the server call.
  `dbGroup_(name, 'qrap_id')` groups rows (e.g. all actions of one QRAP) without extra reads.
- **Writing.** `dbInsert_` / `dbUpdate_` only change objects in memory and remember them.
  `dbFlush_` writes them at the end: consecutive dirty rows in one `setValues`, all new rows in
  one `setValues`. Text starting with `=`, `+`, `-`, `@` gets an apostrophe so it can never become a
  formula (`dbToCell_`).
- **Audit.** `dbInsert_` writes a `CREATE` entry, `dbUpdate_` one `UPDATE` entry per changed field
  (old → new). Log tabs are appended with `appendByHeader_`, which reads only the header row.
- **Nothing is deleted.** Removing = `status REMOVED` or `removed = TRUE`.
- **Locking.** `withWrite_` takes `LockService.getScriptLock()` for the whole write call, so two
  tablets never get the same number and never overwrite each other.
- **Caches.** Settings: 10 minutes (cleared by `onEdit` on SET_* tabs). Board rows: 60 seconds per
  area, invalidated on every write by changing `board_ver`. Values over 100 KB are split into chunks
  (`cachePutBig_`). With 600 QRAPs a board request does 5 bulk reads on a cache miss and none on a hit.
- **Dates.** The server keeps instants; `Utilities.formatDate(…, 'Europe/Prague', …)` reads local
  parts and `tzDate_` builds a Prague wall-clock time. The browser sends `YYYY-MM-DDTHH:mm` (Prague)
  and receives ISO strings; `fmtDT` / `toLocalInput` show them in Prague time.

---

## 6. How to add a new field end to end

Example: a new optional field **"Číslo objednávky"** (`order_no`) in ①.

1. **Schema** – `Config.gs`, `SCHEMA.QRAP.cols`: add `['order_no', 'text']` (at the end is fine).
2. **Sheet** – run `setup()`: it adds the missing header and formats the column.
3. **Server cleaning** – `Wizard.gs · cleanStep1_`: add `order_no: str_(d.order_no, 60),`.
   (Add a rule in `validateStep1_` only if the field is required.)
4. **Escalation copy** – if it is part of ①–③, add `'order_no'` to `ESCALATION_COPY_FIELDS`.
5. **Client data** – `ViewWizard.html · Wiz.data[1]`: add `'order_no'` to the field list.
6. **Client input** – `ViewWizard.html · Wiz.steps[1]`: next to *Dodavatel* add
   `field(t('f.order_no'), textInput(q.order_no, set('order_no'), { max: 60 }), { name: 'order_no' })`.
7. **Display** – `ViewQrap.html · sec1` and `ViewWizardSteps.html · Wiz.steps[5]`: add
   `[t('f.order_no'), q.order_no]` to the `kvList`. Optionally add it to the e-mail facts in
   `Mail.gs · qrapMailHtml_`.
8. **Texts** – `I18n.html`: add `'f.order_no': 'Číslo objednávky'` (cz) and `'Order number'` (en).
9. **Search** (optional) – `Manager.gs · apiSearch`: add `'order_no'` to `fields`.
10. Save, **Deploy → Manage deployments → Edit → New version**.

---

## 7. How to add a new e-mail rule

Example: **E12** – tell Quality when a QRAP is escalated.

1. **Rule function** in `Mail.gs`:
   ```js
   /** E12 – escalation: Quality of the line area. */
   function mailE12_(q, copy) {
     queueQrapMail_(q, { rule: 'E12', key: 'E12|' + q.qrap_id, to: route_(q.area_code, 'QUALITY'), cc: [],
       need: 'QRAP eskalován na APU', page: 'qrap', button: 'Otevřít QRAP',
       reason: 'Kvalita pro oblast ' + q.area_code });
   }
   ```
   - `key` makes it "send once". Use a key with a date for daily rules, e.g. `'E12|' + email + '|' + todayStr_()`.
   - Recipients always come from `route_` (SET_ROUTING) or people chosen from SET_PEOPLE.
2. **Call it** where the event happens, inside a write call: in `Decision.gs · signDecision_`,
   after `mailE6_(q, copy);` add `mailE12_(q, copy);`.
   For a time-based rule, call it from `checkReminders` or `dailyDigest` in `Triggers.gs`.
3. Nothing else: `withWrite_` sends the queue after the data is saved, and `mailFlush_` logs it
   in MAIL_LOG.
4. If a new routing role is needed (e.g. `PURCHASING`), add it to `ROUTING_KEYS` in `Config.gs`,
   add rows to SET_ROUTING, and add it to the check in `selfTest`.

---

## 8. Common errors and fixes

| Symptom | Cause | Fix |
|---|---|---|
| "Authorization is required" / the app asks for permissions again | New Google services were added to the code | Run any function (e.g. `selfTest`) in the editor and allow; then deploy a new version. |
| "Neznámý uživatel" (E_NO_IDENTITY) | `Session.getActiveUser()` is empty: the browser is not signed in with a domain account, or the user is outside the domain | Sign the browser in with the company account. The deployment must be *Anyone within the domain*. Consumer (@gmail) users are never identified by a domain web app. |
| Page shows old behaviour after pasting code | The `/exec` URL runs the last **deployed version** | Deploy → Manage deployments → Edit → **New version**. Use the `/dev` URL while developing. |
| "No HTML file named ViewBoard was found" | File name typo or `.html` typed twice | Rename the file exactly as in SETUP.md (case-sensitive). |
| "Missing tab …" | `setup()` was not run, or a tab was renamed | Run `setup()`; never rename tabs or headers. |
| E-mails do not arrive | No routing row for area + role, or daily quota used | Run `selfTest()`; check MAIL_LOG (`…_QUOTA`, `…_ERROR` rows) and the execution log. Consumer accounts have ~100 recipients/day, Workspace ~1500. |
| E-mail button opens the wrong page | `APP_URL` empty or points to `/dev` | Put the `/exec` URL in SET_CONFIG. |
| "Složka na fotky není nastavena" | `PHOTO_FOLDER_ID` empty or wrong | Put the folder ID in SET_CONFIG; the owner must have access. |
| Settings change not visible | Settings cache | Wait a few seconds (onEdit clears it) or run `clearCaches()`; reload the kiosk page. |
| "Server je zaneprázdněný" (E_BUSY) | Another write held the lock for > 25 s | Try again; if frequent, check for slow triggers in *Executions*. |
| A signed part must be corrected | Signatures lock parts | Admin: detail page → Admin → *Odemknout* (reason is logged). |
| Times are one hour off | Time zone of the Sheet or project | `appsscript.json` must have `Europe/Prague`; `setup()` sets the Sheet time zone; `selfTest()` checks both. |
| Triggers do nothing | Not installed, or installed by another user | Run `installTriggers()` as the owner; check the Triggers page and *Executions*. |
