# Assumptions and design choices

Choices made where the specification left room. Each one is small and easy to change later;
the file and function to change are named where useful.

## Data model

1. **`SET_LISTS` has an extra `code` column** (`list | code | value_cz | value_en | order | active`).
   The data tabs store the stable code (e.g. `PICKING`), not the Czech text, so a renamed label
   never breaks old rows and the CZ/EN toggle works. `ALERT_ROLE` codes that match a routing key
   (`TL`, `SUPERVISOR`, `QUALITY`, `MANAGER`) are used to fill `ALERT.notified_to`.
2. **`ALERT` has an extra `removed` column.** Un-ticking a role in ② must not delete a row.
3. **"jiné + text"** for HOW_FOUND is stored in one cell as `OTHER:free text`.
4. **Yes/no fields are stored as `ANO` / `NE`** (safety, risk, repeat, process stopped, standard
   update). The UI shows them in the wording of the form ("ano / ne" for SAFETY).
5. **Audit columns** (`created_at, created_by, updated_at, updated_by`) are on all business
   tabs. `AUDIT_LOG`, `MAIL_LOG` and `COUNTER` do not get them (they already hold a timestamp).
6. **Section timestamps:** `s1_done_at` = ① valid (step 1 passed server validation),
   `s2_done_at` = ② valid (≥ 1 role), `s3_done_at` = the ③ risk question first answered,
   `containment_done_at` = ③ complete (all rules of ③ met).
7. **`closed_at` / `closed_by`** are also filled for `CLOSED_SOLVED` and `ESCALATED` (the line
   row is closed at the decision). This keeps the board's "closed in the last N days" rule and
   archiving the same for every final state.
8. **`locked_parts`** is a comma list of `QR` (①–③), `DECISION` (④) and `ANALYSIS` (⑤⑥ and
   closure). Signing ④ adds `QR,DECISION`; closure adds `ANALYSIS`.
9. **`DEF_ACTION.root_step`** is `O1`…`O5` (occurrence chain), `N1`…`N5` (non-detection chain)
   or `STD` for the automatic "Aktualizovat standard" action.
10. **Effectiveness round** is derived from the data: current round = 1 + highest round that
    has a `NOT_EFFECTIVE` slot. No extra column is needed.
11. **Dates** are stored as real Sheet dates (the spreadsheet time zone is set to
    Europe/Prague by `setup()`), text columns are formatted as plain text so Sheets does not
    turn codes like `01-02` into dates. Text that starts with `=`, `+`, `-` or `@` is written
    with a leading apostrophe so it can never become a formula.
12. **Shift days** in `SET_SHIFTS.days` are digits, Monday = 1 … Sunday = 7 (`12345` = Mon–Fri).
    A digit string survives even if Sheets converts it to a number. A night shift belongs to
    the day it starts.
13. **Shifts are plant-wide.** `SET_SHIFTS` has no area column, so "every active shift of the
    area" means every active shift.

## Rules and guards

14. **Hard blocks vs. warnings.** Blocks: everything the spec marks required, plus wrong ≤
    checked, restore ≥ KDY, done times not in the future and not before KDY, no future KDY.
    Warnings (the user confirms): "CO" shorter than 10 characters, KDY older than 24 h,
    fewer than 3 whys, "Problém vyřešen" with repeat = ANO or wrong > 0, signing ④ before
    every shift was informed.
15. **Step 4 "Další" requires ③ to be complete.** "Dokončí TL později" only needs the risk
    question (plus consistent values). This is how the two buttons differ.
16. **Idle timeout** saves a DRAFT without validation (nothing typed is lost). For a QRAP that
    was already sent, the idle save must pass validation, otherwise the changes are dropped
    and a toast says so (a sent QRAP must stay valid).
17. **③ can become incomplete again.** If a supervisor adds an open action to a QRAP that is
    `WAIT_DECISION`, it goes back to `QR_OPEN` (logged).
18. **Decision deadline (chip 4 red, E4)** = the start of the next shift after the QRAP
    reached `WAIT_DECISION` (`containment_done_at`).
19. **Shift ticks in ④** can be set by the decider or a TL until ④ is signed. After the
    signature they are locked with the rest of ④.
20. **"Co jsme se naučili z QR?"** is required for closure (closure checklist) and shown as a
    warning in the analysis form.
21. **ANALYSIS → ACTIONS_OPEN** needs a marked root cause and ≥ 1 action. After a
    `NOT_EFFECTIVE` slot, at least one action created after that moment is needed, so the
    QRAP cannot jump straight back to VERIFY with the old actions.
22. **Adding an action in VERIFY** moves the QRAP back to ACTIONS_OPEN. Slots already recorded
    in the current round stay.
23. **NOT_VERIFIED** slots can be overwritten later; EFFECTIVE slots are final; NOT_EFFECTIVE
    ends the round. Slots must be on 5 different (date, shift) pairs, not in the future.
24. **Who edits ⑤⑥:** the assigned pilots and the decider (supervisor of the area, APU manager
    for APU copies). The action owner (pilot of one action) may set the done date, evidence and
    notes of their own action. The N+1 of the action owner may add notes.
25. **Deciders:** SUPERVISOR for AREA-level QRAPs, APU_MANAGER for APU/PLANT-level copies.
    The kiosk account can never sign, even if someone gives it more roles.
26. **Reading:** every identified domain user may read QRAPs (like "any Valeo user" in eQRAP).
    Users with an empty e-mail are blocked from everything. Users who are not in SET_PEOPLE
    can read and, when `ASSESSMENT_OPEN_TO_ALL` = TRUE, assess.
27. **Assessors:** SUPERVISOR, MANAGER, APU_MANAGER, QUALITY, ADMIN (or anyone identified when
    `ASSESSMENT_OPEN_TO_ALL` = TRUE). Never the kiosk.
28. **Pilots cannot be removed** in the app (the spec only allows it after closure, when it has
    no effect). Deciders can add pilots during the analysis (the new pilot gets E5).
29. **Escalation:** the suffix letter is the next free letter for the base number
    (`WH1-2026-9-14-A`, then `-B` …). The copy gets `locked_parts = QR` (its ①–③ are a copy of
    the line's facts). An APU copy can be escalated again to its own parent (PLANT) if
    `SET_AREAS` has one. Reopening an ESCALATED QRAP is not offered.
30. **Admin tools:** unlock ①–③ (status unchanged), unlock ④ (only in ANALYSIS or
    CLOSED_SOLVED: the decision is cleared and the QRAP returns to WAIT_DECISION), reopen
    (CLOSED → VERIFY, CLOSED_SOLVED → WAIT_DECISION), archive / un-archive. A reason is
    always required and logged in AUDIT_LOG.
31. **The board filter "otevřené"** shows open QRAPs plus QRAPs closed in the last
    `BOARD_CLOSED_DAYS` (the default board of the spec). "dnes" = KDY today. "vše" = every
    non-archived QRAP of the area.
32. **"Pokračovat v rozpracovaném (n)"** counts DRAFTs and sent QRAPs whose ③ is still open
    (`QR_OPEN`) in the area.
33. **Repeat suggestions** score QRAPs of the same area from the 7 days before KDY:
    material number match 3, zone match 1, each shared word (≥ 4 letters) 1.

## E-mails

34. **E1** is not sent for an APU copy; the APU manager gets E6 instead.
35. **E10** covers DRAFT and QR_OPEN QRAPs (both have ③ open) with a KDY older than 24 h.
36. **E7** is sent every day (as written in the spec), **E8** only Monday–Friday.
    E7 also lists notes whose review date has come.
37. **E11 (extra rule)**: "Efektivita nepotvrzena" to the pilots, cc the decider, when a slot is
    NOT_EFFECTIVE (the spec asks to "notify pilot + supervisor" but has no number for it).
38. **E5** is also sent to a pilot added later (key per pilot).
39. **② ticks do not send e-mails** (the spec's e-mail table does not list it). `notified_to`
    shows the routing e-mail for that role, when there is one.
40. If no routing e-mail exists for a rule, nothing is sent and the problem is written to the
    execution log; `selfTest()` reports missing routing.
41. De-duplication keys: `E1|id`, `E2|id`, `E3|id`, `E4|id`, `E5|id|decided_at`,
    `E5|id|email` (added pilot), `E5b|action|email`, `E6|id`, `E7|email|date`,
    `E8|email|date`, `E9|id|closed_at`, `E10|id`, `E11|id|round`.

## Technical

42. **Script lock for every write call.** Each write API takes the script lock for its whole
    body (max ≈ 1–3 s), which also covers ID generation. Nested locks are never taken.
43. **Settings cache:** 10 minutes in CacheService, cleared by the simple `onEdit` trigger
    when a `SET_*` tab is edited, or by running `clearCaches()`.
44. **Board cache:** 60 seconds per area, invalidated on every write through a global version
    number. Large values are split into 45 000-character chunks (CacheService limit 100 KB).
45. **Kiosk page reload:** settings are loaded when the page opens. After changing settings,
    reload the kiosk page (the board itself refreshes its data every 60 s).
46. **Photos:** one active WRONG and one active CORRECT photo; a new photo marks the old one
    `removed`. `apiGetPhoto` only serves Drive files that are listed in `ATTACHMENT`, so a user
    cannot read other Drive files of the owner through the app.
47. **Demo data** (`seedDemoData`) runs once; delete the script property `DEMO_SEEDED` to run
    it again. It sends no e-mails and uses no photos (photo exception "Demo data").
48. **Functions that must not be called from the browser** (`setup`, `seedDemoData`,
    `installTriggers`, `removeTriggers`, trigger jobs) check that the caller is the script
    owner or an ADMIN, because any public function can be called with `google.script.run`.
