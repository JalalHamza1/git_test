# eQRAP Logistika – manual test script

Run these tests after the setup (SETUP.md) and after every larger change.
Each line: **do** → **expected**. Tick the box when it passes.

## 0. Preparation

- [ ] `setup()` ran without errors; `selfTest()` shows no ✗ (or only the ones you understand).
- [ ] Every row of `SET_ROUTING` has **your** e-mail, so you receive all mails.
- [ ] You are in `SET_PEOPLE`. For most tests use roles `SUPERVISOR,PILOT,MANAGER,ADMIN,TL`, areas `*`.
  For kiosk tests switch your roles to `KIOSK`, areas `WH1` (or use a second domain account).
- [ ] `seedDemoData()` ran once (9 demo QRAPs).
- [ ] You know where to look: tab `MAIL_LOG` (every e-mail), tab `AUDIT_LOG` (every change),
  editor → *Executions* (server errors).

Shortcut: `U` = your app URL (`…/exec`).

---

## 1. Kiosk board (`U?page=board&area=WH1`, role KIOSK)

- [ ] Header shows "eQRAP Logistika", "WH1 · Sklad 1" and **"Kiosek WH1"**.
- [ ] One row per QRAP; **newest at the bottom**; the list opens scrolled to the bottom.
- [ ] Scroll up with more than 40 QRAPs (filter *vše*) → older rows load, the position stays.
- [ ] Each row: number, short text, zone / location, time, chips 1–7, "čeká na: …".
- [ ] Demo "Chybějící etiketa HU…" (③ open > 24 h) → chip 3 **red**, row with red left border.
- [ ] Solved demo QRAP → chips 5 and 6 **dashed** (not needed).
- [ ] Filters: *otevřené* (open + closed in the last 7 days), *dnes* (KDY today),
  *bezpečnost* (SAFETY only), *vše*.
- [ ] Bottom bar: **+ Nový QRAP** and **Pokračovat v rozpracovaném (n)**; n = drafts + QRAPs with ③ open.
- [ ] Tap a row → detail page.
- [ ] Wait 60 s after another user changes something → the board refreshes by itself.

## 2. Wizard (kiosk)

### Step 1 – Popis
- [ ] Nothing filled → **Další** → error list; SAFETY, CO, JAK, KDY, KDE, KOLIK, repeat, JMÉNO marked red.
- [ ] SAFETY has **no default**.
- [ ] CO shorter than 10 characters → warning dialog "je dost jasný?"; *Opravit* stays, *Pokračovat* saves.
- [ ] KDY in the future → blocked. KDY 2 days ago → warning, can continue.
- [ ] KDE: choosing a zone shows its location codes; a free code can be typed.
- [ ] KOLIK 0 → error; tick "NOK situace bez kusů" → 0 accepted.
- [ ] Repeat = ANO → list of QRAPs of the last 7 days (same material / zone / words first).
  A typed number that does not exist → error "Vyberte existující QRAP…".
- [ ] JMÉNO: pick a name, or type badge `1001` only → saved as "Jan Novák".
- [ ] Valid → **Další** → the title shows the new number `WH1-YYYY-M-n`; the row exists in tab QRAP with status DRAFT.
- [ ] Material number `0012345` → saved with the leading zeros.

### Step 2 – Fotky
- [ ] **Další** without photos → error.
- [ ] **Vyfotit** opens the rear camera on the tablet; the preview appears; tab ATTACHMENT has a row;
  Drive has `PHOTO_FOLDER / <number> /` with a full picture and a thumbnail.
- [ ] Taking a new photo of the same kind → the old ATTACHMENT row gets `removed = TRUE`.
- [ ] Exception ticked + reason → **Další** allowed without photos.

### Step 3 – Upozornění
- [ ] Nothing ticked → error. "jiné" without text → error.
- [ ] After step 4 with risk = ANO, going back shows **Kvalita** ticked and locked.

### Step 4 – Opatření
- [ ] **Dokončí TL později** is disabled until the risk question is answered.
- [ ] Nalezeno špatně > Zkontrolováno → error.
- [ ] Action row without type / text / kdo → error for that row.
- [ ] "Hotovo v" in the future or before KDY → error.
- [ ] Proces zastaven = ano, obnoven before KDY → error.
- [ ] **Další** with an open action → error "③ nejsou kompletní" (use *Dokončí TL později*).
- [ ] *Dokončí TL později* with risk answered → step 5.

### Step 5 – Kontrola a odeslání
- [ ] Summary of ①②③, photos, and "③ není kompletní – chybí: …" or "③ jsou kompletní".
- [ ] **Upravit** buttons jump back to the step.
- [ ] **Odeslat** → back to the board, toast "QRAP … odeslán", the new row is **at the bottom**.
- [ ] Status QR_OPEN (③ open) or WAIT_DECISION (③ complete) in tab QRAP.

### Drafts and idle timeout
- [ ] Start a new QRAP, type something, touch nothing for `IDLE_MINUTES` → board, toast
  "Koncept … uložen", a DRAFT row exists.
- [ ] **Pokračovat v rozpracovaném** → the draft is listed → tap → the wizard opens at the right step
  with the saved values.
- [ ] Close the browser tab during step 3 and reopen `U?page=wizard&id=<number>&step=3` → the data is there.

## 3. QRAP detail (`U?page=qrap&id=…`)

- [ ] All 7 sections in paper order, coloured by role (orange ①②③, blue ④, purple ⑤⑥, green ⑦).
- [ ] Photos load (also for users without Drive access); tapping opens the big photo.
- [ ] QR code → scanning with a phone opens `?page=decide&id=…`.
- [ ] Kiosk sees only buttons it may use (no ④, no closure, no assessment).
- [ ] Quality user (role QUALITY only) sees the "Kvalita – data kontroly" form while ④ is not signed.
- [ ] Links to the repeated QRAP, the parent and the APU copy work.

## 4. Decision on the phone (`U?page=decide&id=…`, role SUPERVISOR)

- [ ] Summary with photos, wrong pieces, repeat and ③ state.
- [ ] Shift buttons R / O / N: a tap stores who + when; the button turns green.
- [ ] ③ not complete → the decision card says the decision is not possible yet.
- [ ] SAFETY = ano → "Problém vyřešen" is disabled; forcing it on the server → E_SOLVED_SAFETY.
- [ ] "Problém vyřešen" without comment → error; with repeat = ANO or wrong > 0 → warning dialog.
- [ ] "Pokračovat" without pilot → error.
- [ ] Not all shifts ticked → warning "Nejsou informovány všechny směny".
- [ ] **Podepsat** → "Podepsáno a zamčeno"; `decided_by` / `decided_at` stored; `locked_parts = QR,DECISION`.
- [ ] After signing: shift buttons are disabled; the kiosk can no longer edit ①–③ (E_LOCKED).
- [ ] **Kiosk account** opens the same page → no sign button, message "Kiosek nemůže podepisovat".
- [ ] A supervisor of another area → "Rozhodnout může jen supervizor této oblasti".

## 5. Escalation

- [ ] Decide **Eskalace** with a comment → toast "vytvořena kopie WH1-…-A".
- [ ] Original: status ESCALATED, `assign_ref` = copy; chips 5/6 dashed.
- [ ] Copy: area APU, level APU, `parent_id` = original, status WAIT_DECISION, same ①–③, same photos.
- [ ] Escalating again (from the APU copy, if APU has a parent) → suffix **B**.
- [ ] The line supervisor cannot decide the copy; the APU manager can.
- [ ] `U?page=escalation` lists the APU copy and the escalated original.

## 6. Analysis and actions (`U?page=analysis&id=…`, assigned pilot)

- [ ] Each step label quotes the previous answer: "2. Proč: <answer 1>?".
- [ ] Only 2 steps → warning "doporučeno alespoň 3". A gap (steps 1 and 3 filled) → error.
- [ ] Root cause radio per chain; optional chain "Proč to nebylo zachyceno?".
- [ ] Standard = ANO without text → error; with text → action "Aktualizovat standard: …" appears.
- [ ] Standard back to NE → that action becomes REMOVED (if still open).
- [ ] New action: plan in the past → error; done in the future → error; link not https → error.
- [ ] First action saved (with root cause marked) → status ACTIONS_OPEN.
- [ ] Changing the plan keeps "původní plán" (planned_first); AUDIT_LOG has the old → new value.
- [ ] **Odebrat** → status REMOVED, the row stays in DEF_ACTION.
- [ ] All actions have a done date → status VERIFY.
- [ ] A pilot of one action (not assigned to the QRAP) can set only the done date / evidence and add notes.
- [ ] Supervisor adds a pilot during the analysis → new PILOT row; a pilot cannot be removed.

## 7. Moje akce (`U?page=actions`)

- [ ] Shows my actions; filters Otevřené / Uzavřené / Odebrané / Vše and Po termínu / do 7 dnů.
- [ ] Overdue action is marked "po termínu".
- [ ] **Hotovo** closes the action (status moves on if it was the last one).
- [ ] Note with review date → listed; "revize hotová" tick saved.
- [ ] "Můj tým (N+1)" shows actions of people whose `n1_email` is me.

## 8. Effectiveness (`U?page=effect&id=…`, kiosk or TL, status VERIFY)

- [ ] 5 slots; date defaults to today, shift to the current shift.
- [ ] Kiosk must pick "Zkontroloval(a)".
- [ ] Two EFFECTIVE slots with the same date + shift → error "5 různých směn".
- [ ] Future date → error.
- [ ] NOT_VERIFIED slot can be recorded again later; EFFECTIVE slot is final.
- [ ] NOT_EFFECTIVE → confirmation → status ANALYSIS, "Kolo 2", old slots in "Předchozí kola".
- [ ] After NOT_EFFECTIVE the QRAP stays in ANALYSIS until a **new** action is added.

## 9. Closure (`U?page=close&id=…`, supervisor)

- [ ] Checklist: status VERIFY, root cause, all actions closed, standard answered, 5 different
  shifts, lesson filled. Any ✗ → button disabled; the server also refuses (E_CLOSURE).
- [ ] All ✓ → **Podepsat uzavření** → status CLOSED, `closed_by` / `closed_at`, `locked_parts` contains ANALYSIS.
- [ ] Kiosk → no sign button.

## 10. Assessment (`U?page=assess&id=…`)

- [ ] DRAFT → not possible. Kiosk → not possible.
- [ ] Next to each criterion the app shows what it knows (① complete, ③ complete, photos, shifts informed).
- [ ] All 5 criteria + feedback required; assessor and time automatic.
- [ ] A second assessment is added (history kept); the detail shows the latest.

## 11. Manager (`U?page=manager`, role MANAGER)

- [ ] Tiles: Nové dnes, Čeká na rozhodnutí, Opatření > 24 h, Akce po termínu, Bezpečnost tento
  týden, Opakování 7 dní, Hodnocení dnes; numbers match the demo data.
- [ ] "Hodnocení dnes per supervizor" lists every supervisor, 0 in red.
- [ ] "Potřebuje vás" sorted by urgency (late decision and ③ > 24 h first, SAFETY higher).
- [ ] Filters area / date / status change the list.
- [ ] Search by number, text, material number, HU → results (archived marked).
- [ ] Kiosk / pilot → E_FORBIDDEN.

## 12. Admin (detail page, role ADMIN)

- [ ] Unlock ①–③ (reason ≥ 5 characters) → ①–③ editable again; AUDIT_LOG `ADMIN_UNLOCK_QR` with the reason.
- [ ] Unlock ④ on an ANALYSIS or CLOSED_SOLVED QRAP → WAIT_DECISION, decision cleared.
- [ ] Reopen CLOSED → VERIFY; reopen CLOSED_SOLVED → WAIT_DECISION.
- [ ] Archive / restore → the QRAP disappears from / returns to the board.
- [ ] Reason missing → error; non-admin → "Jen pro admina".

## 13. E-mails (check your inbox and tab MAIL_LOG)

Subject format for every QRAP mail: `[QRAP <id>] <what is needed> · SAFETY: ano/ne · Opakování: ANO/NE`.
Body: key facts, both photo thumbnails, a big button to the right page, footer "Tento e-mail dostáváte, protože jste …".

| # | Do | Expected |
|---|---|---|
| E1 | Send a QRAP (Odeslat) | One mail to the supervisor of area + current shift (night shift → `supervisor.night` in the demo routing), cc manager; "nutné rozhodnutí" if ③ complete, else "opatření probíhají". Sending again is impossible → still **one** E1 row. |
| E2 | Step 1 with SAFETY = ano (before Odeslat) | Mail to EHS + supervisor, cc manager, **immediately**. Only once per QRAP. |
| E3 | Step 4 with risk = ANO | Mail to Quality, cc supervisor. Only once. |
| E4 | Leave a QRAP in WAIT_DECISION past the next shift start, run `checkReminders` | Mail to supervisor, cc manager. Running again → no second mail. |
| E5 | Decide "Pokračovat" | Mail to the pilots, cc supervisor, button → analysis page. |
| E5b | Save a new action / change its pilot | Mail to the action pilot with the planned date. |
| E6 | Decide "Eskalace" | Mail to the APU manager (routing of the APU area), cc supervisor, button → decide page of the copy. |
| E7 | Have an overdue action, run `dailyDigest` | One digest per pilot; cc the pilot's `n1_email` when overdue ≥ `OVERDUE_N1_DAYS`. Running again the same day → nothing. |
| E8 | Run `dailyDigest` on a working day | One summary per manager (new yesterday, waiting, ③ > 24 h, overdue, safety this week, repeats, assessments yesterday). Not on Saturday / Sunday. |
| E9 | Solve a QRAP or sign the closure | Mail to the finder (if the finder has an e-mail) + supervisor. |
| E10 | Keep ③ open 24 h after KDY, run `checkReminders` | Mail to TL + supervisor, cc manager, once. |
| E11 | Record a NOT_EFFECTIVE slot | Mail to the pilots, cc supervisor. |

- [ ] No routing row for a role → no mail, a warning in *Executions*; `selfTest()` lists the gap.
- [ ] MAIL_LOG has one row per sent mail with its key; errors appear as `…_ERROR`, quota problems as `…_QUOTA`.

## 14. Robustness

- [ ] Every save adds rows to AUDIT_LOG (who, when, field, old → new). Nothing is ever deleted.
- [ ] Turn off Wi-Fi on the tablet, press **Další** → red bar "Bez připojení"; the form keeps the data;
  Wi-Fi on → **Zkusit znovu** → saved.
- [ ] Two tablets save a new QRAP at the same moment → two different numbers.
- [ ] Type `=HYPERLINK("x")` into CO → stored as text in the Sheet (not a formula), shown as text in the app.
- [ ] Type `<b>test</b>` into CO → shown literally (no bold) on every page and in e-mails.
- [ ] Open the app in a browser signed in with a non-domain account → "Neznámý uživatel".
- [ ] CZ / EN button switches all texts; the choice is remembered on this device.
- [ ] Phone (≈ 390 px wide): board, decision, closure and assessment pages are usable without zooming.
- [ ] With 500+ QRAPs in the Sheet the board still opens in a few seconds (5 bulk reads on the first
  load, then the 60-second cache; tested locally with 600 QRAPs).
- [ ] `archiveOld` (or wait for Sunday) → QRAPs closed more than `ARCHIVE_AFTER_DAYS` ago get `archived = TRUE`.
