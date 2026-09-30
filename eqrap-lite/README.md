# eQRAP Expedice (Lite): admin guide

This is the simple version of the app, built for **warehouse and expedice**, not production. It's two files: `Code.gs` and `Index.html`. You manage almost everything in the Google Sheet, so you don't need to open the code.

---

## 1. What changed compared with the big version

| | Big version (`apps-script/`) | **Lite** (`eqrap-lite/`) |
|---|---|---|
| Files to paste | 39 | **2** (+ optional `appsscript.json`) |
| Lines of code | ~7,200 | **~2,000** (≈900 server, ≈1,100 screen incl. styles) |
| Roles | 10 (kiosk, operator, TL, supervisor, pilot, quality, EHS, manager, APU manager, admin) | **3**: everyone / VEDOUCÍ / MANAŽER |
| Screens | 13 | **4**: Přehled · Nahlásit · Detail (form ①–⑦) · Jak to funguje |
| Sheet tabs | ~20 | **6** (you edit only 3 of them) |
| Waiting | each screen asked the server (1–3 s) | only **first opening** and **saving** wait. Moving around is instant |
| Focus | production shifts, pilots, APU copies | zásilka, dodací list, zákazník, sklad, rampa |

**Why it's faster:** when the page opens, it receives all open problems at once. Clicking a problem, filtering and searching then happen in the browser with no server call. The server is only called when you **save**, plus a quiet refresh every 90 seconds.

**What was left out on purpose:** the 5-shift effectiveness slots, the pilot role, APU escalation copies, drafts and the step-by-step wizard, English, and 11 e-mail types.

**What replaces them:** one simple "účinné ANO/NE" check, an owner on each action, an e-mail to the manager on escalation, one form, and 3 e-mail types plus an optional morning reminder.

---

## 2. Setup (about 10 minutes, one time)

1. Create a **new Google Sheet**, for example "eQRAP Expedice". Use the account that should own the app (see §7 about ownership).
2. In the Sheet, open **Extensions → Apps Script**.
   - In `Code.gs`, delete everything and paste the content of **`eqrap-lite/Code.gs`**.
   - Click **+ → HTML** and name it **`Index`**. Delete everything and paste **`eqrap-lite/Index.html`**.
   - *(Optional)* In ⚙ Project Settings, tick "Show appsscript.json" and paste **`eqrap-lite/appsscript.json`**. If you skip this, set the time zone to *Europe/Prague* in Project Settings.
   - Click 💾 Save.
3. In the toolbar, choose the function **`setup`**, click **Run** and allow the permissions. This creates the 6 tabs and a Drive folder "eQRAP fotky".
4. Go back to the Sheet and reload it. A new menu **eQRAP** appears. Then:
   - In **Lidé**, replace the example people with real people (see §4).
   - In **Seznamy**, check the areas and problem types.
   - In **Nastavení**, set `EMAILY` to `NE` while you are testing.
5. Back in Apps Script, click **Deploy → New deployment → ⚙ Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone within [your company]**
   - Click **Deploy** and copy the URL. That is the app.
   - For the kiosk PC, add `?kiosk=1` to the end of the URL.
6. *(Optional)* Use **eQRAP → Vložit ukázková data** to see 3 example problems. Delete those rows afterwards, or better, try things in a separate test Sheet.

**Updating the code later:** paste the new code, then go to **Deploy → Manage deployments → ✏ → Version: New version → Deploy**. The URL stays the same.

---

## 3. How it works: the flow and who does what

```
Nahlásit ①②  →  Opatření ③ (24 h)  →  Rozhodnutí ④  →  Příčina ⑤ + Akce ⑥  →  Ověření ⑥  →  Uzavřeno
  anyone          anyone on shift        leader           leader + owners       leader
                                           └─ "Vyřešeno" closes right away
                                           └─ "Eskalace": the manager gets an e-mail, analysis continues
```

The **status is calculated automatically** from what has been filled in. Nobody sets it by hand:

| Status in the app | Means | Who acts |
|---|---|---|
| ③ Opatření | reported, immediate actions missing (deadline 24 h) | anyone on the shift |
| ④ Rozhodnutí | ③ done, waiting for the leader's decision | VEDOUCÍ |
| ⑤⑥ Analýza | 5× Proč and actions in progress | VEDOUCÍ + action owners |
| ⑥ Ověření | all actions done, check that the problem does not return | VEDOUCÍ |
| Uzavřeno / Zrušeno | finished / cancelled by a manager (the record stays) | – |

**Roles.** There are only three.

| | Everyone with a company account (no row in Lidé needed) | **VEDOUCÍ** | **MANAŽER** |
|---|:-:|:-:|:-:|
| ①② report a problem | ✓ | ✓ | ✓ |
| ③ immediate actions (until the decision) | ✓ | ✓ | ✓ |
| ④ decide · ⑤ 5× Proč · ⑥ add actions | – | ✓ | ✓ |
| ⑥ mark **own** action as done | ✓ | ✓ | ✓ |
| ⑥ verify and close · ⑦ QRQC assessment | – | ✓ | ✓ |
| cancel / reopen a problem | – | – | ✓ |
| gets an e-mail when… | an action is assigned to them | there's a new problem in their area (empty area = all areas) | there's an escalation or a BOZP (safety) problem |

The person who owns the script is always MANAŽER.

**What each person sees.** Everyone sees the **same 4 screens**, and buttons appear only if that person is allowed to use them. The **"Moje úkoly"** tile on the board shows each person only what is waiting for them:

- leaders see problems in their area that need a decision, analysis or verification
- everyone sees their own actions
- the reporter sees their own problem while ③ is missing

The **kiosk** (`?kiosk=1`) is the same app with 3 differences: no personal name, a "thank you" screen after reporting, and it returns to the board by itself after 2 minutes of no use.

---

## 4. Everyday admin tasks, all in the Sheet (no code)

| I want to… | Do this |
|---|---|
| add a person or make someone a leader | **Lidé**: add a row with Jméno, E-mail (exactly their Google account), Role `VEDOUCÍ` or `MANAŽER`, Oblast |
| take a role away / someone left | **Lidé**: set Aktivní to `NE` (keep the row so the history still shows the name) |
| add or change an area, problem type or checklist item | **Seznamy**: edit the column. Old problems keep their old value |
| change the 24 h deadline for ③ | **Nastavení** → `LHUTA_OPATRENI_HODIN` |
| turn e-mails off or on | **Nastavení** → `EMAILY` = `NE` / `ANO` |
| send a morning reminder to leaders and late action owners | menu **eQRAP → Zapnout denní připomínky** |
| rename the app | **Nastavení** → `NAZEV` |
| show closed problems for longer on the board | **Nastavení** → `ZOBRAZIT_UZAVRENE_DNI` |
| get rid of a duplicate or mistaken problem | in the app, as manager: **Správa → Zrušit problém** (with a reason). It stays in the history |
| reopen a closed problem | in the app, as manager: **Správa → Znovu otevřít** |
| make a report or chart | add **your own tab** with formulas (for example `=COUNTIF(Problémy!B:B;"UZAVŘENO")`), or File → Download → Excel |
| back up | File → Version history works automatically; also make a monthly **File → Make a copy** |

Changes in Lidé, Seznamy and Nastavení apply **within 5 minutes**. To apply them right away, use **eQRAP → Použít změny v nastavení hned**. Users then reload the app.

### Tabs in the Sheet

| Tab | What it is | May I edit it? |
|---|---|---|
| **Lidé** | people, roles, areas | ✅ yes, this is your main control |
| **Seznamy** | dropdown values (areas, types, …) | ✅ yes |
| **Nastavení** | name, e-mails on/off, deadlines | ✅ only the *Hodnota* column |
| **Problémy** | one row = one QRAP (columns ①–⑦) | ⚠ read only. Change data through the app |
| **Akce** | one row = one action ⑥ | ⚠ read only |
| **Historie** | who changed what and when | ⚠ read only (this is your audit trail) |

The three data tabs are protected with a warning, so you get a prompt before editing them by hand.

**Never do these:**

- rename, delete or reorder the columns in Problémy, Akce or Historie (you may add your own columns *to the right*)
- delete the tabs Lidé, Seznamy or Nastavení
- give everyone edit access to the Sheet. Users don't need it at all, because the app works without it

---

## 5. If something is wrong

| Problem | Fix |
|---|---|
| "Aplikaci se nepodařilo spustit – chybí list / sloupec" | run **eQRAP → Nastavit tabulku (setup)**. It repairs things and never deletes data. Check that no column header was renamed |
| a leader has no "Rozhodnout" button | their e-mail in Lidé must match their Google account exactly, and Aktivní must be `ANO`. Then **eQRAP → Použít změny…** and reload |
| e-mails don't arrive | `EMAILY` = `ANO`, the person has an e-mail in Lidé, check spam. Google allows about 1,500 e-mails a day |
| someone gets "you need permission" | the deployment must be "Anyone within [company]" and they must be signed in with their **company** Google account |
| I changed the code but nothing changed | **Manage deployments → New version** (§2) |
| the first opening takes 2–4 s | normal: Google starts the script. After that, clicks are instant and saves take about 1–2 s |

---

## 6. If you ever need to look at the code

Both files are split into numbered sections with a table of contents at the top. Typical changes:

| Change | Where |
|---|---|
| texts of the form (labels, hints) | `Index.html` section 7 (`popisForm`, `opatreniForm`, `actionForm`) |
| the decision options ④ | `Index.html` section 1 `DECISIONS` + `Code.gs` section 1 `DECISIONS` |
| who may do what | `Code.gs` section 5: six one-line rules `canPopis_ … canAssess_` |
| when a status changes | `Code.gs` section 4 `statusOf_` (8 lines) |
| e-mail texts | `Code.gs` section 7 (`mailNew_`, `mailEscalated_`, `mailAction_`) |
| colours | `Index.html` top of `<style>` (`--accent` etc.) |
| a new column | `Code.gs` section 1 `COLS`, then run setup (it adds the missing header) |

| `Code.gs` (server) | `Index.html` (screen) |
|---|---|
| 1 tabs, columns, defaults | 1 state and texts |
| 2 web app entry (`doGet`) | 2 small helpers (`h`, `api`, `save`) |
| 3 API called by the page | 3 header and routing |
| 4 status rules | 4 board (Přehled) |
| 5 permissions | 5 new problem (Nahlásit) |
| 6 sheet helpers | 6 problem detail ①–⑦ |
| 7 e-mails, daily reminder | 7 section forms |
| 8 setup, menu, example data | 8 photos · 9 help, kiosk, refresh |

---

## 7. Is it safe to use in the firm?

**Short answer:** it's safe for an **internal pilot in expedice**. Before it becomes the official QRAP record, get IT and Quality to approve it and move the ownership to a team account.

### What protects it

- **Only company accounts** can open it ("Anyone within [company]"). People outside the company can't.
- **Users never get access to the Sheet or the Drive folder.** The app runs as the owner, and **every save is checked on the server** against the Lidé tab. Hiding a button in the browser is only for convenience. The real check is on the server, so a user can't bypass it.
- **Everything is logged** in Historie: who, when and what. Nothing can be deleted from the app. "Zrušit" keeps the record with a reason.
- **Typed text can't do harm.** It's always shown as plain text, never run as code. In the Sheet it's stored as text, never as a formula, so values like "00123" stay exactly as typed.
- A photo can be opened **only through its own problem**, so nobody can read other files from the owner's Drive.
- **No outside services or libraries.** Everything stays in your company's Google Workspace, the same place as your e-mail and Drive.
- **Tested:** 108 automatic server checks (permissions, statuses, e-mails, bad input) and a full browser test of the whole flow, including the kiosk and a phone.

### Risks you should know about (and what to do)

| Risk | What to do |
|---|---|
| **It depends on one person's account.** If the owner leaves and the account is deleted, the app stops and the photos disappear | Put the Sheet in a **Shared Drive**, or create it under a **team account** (e.g. qrqc-expedice@…). Have 2 people with edit access to the Sheet |
| **It isn't a validated system** (IATF 16949 / customer requirements) | Run it **in parallel with the paper QRAP for 2–4 weeks**. Let Quality decide if it can replace the paper |
| **Everyone in the company can see all problems** | This is intended for transparency. Don't write health details of injuries into it; BOZP injuries still go to the official injury book |
| **Kiosk shared account:** "Kdo hlásí" is typed, not verified | Never give the kiosk account a role. Decisions are made from personal accounts |
| **Google limits:** about 1,500 e-mails a day; about 30 people saving *at the same second* | Plenty for one warehouse. Not meant for the whole company |
| **Personal data** (names, e-mails of employees) | Tell IT / the data protection officer. It stays inside your Google Workspace |
| **Backups** | Version history is automatic. Also make a monthly File → Make a copy |

### Pilot checklist

- [ ] IT agrees with an Apps Script web app on the company domain (and with a kiosk account, if used).
- [ ] Owner is a team account or Shared Drive; 2 admins have edit access to the Sheet.
- [ ] Lidé filled in: every leader and manager, e-mails checked.
- [ ] Seznamy match your areas and problem types.
- [ ] One week with `EMAILY` = `NE` on a test Sheet, then switch to the real Sheet with `EMAILY` = `ANO`.
- [ ] Short training (5 min): show "Jak to funguje" in the app.
- [ ] 2–4 weeks in parallel with paper, then Quality decides.

---

*Placeholder data only: all example people use example.com addresses.*
