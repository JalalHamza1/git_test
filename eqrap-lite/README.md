# eQRAP Expedice (Lite): admin guide

This is the simple version of the app, built for **warehouse and expedice**, not production. It's two files: `Code.gs` and `Index.html`. As admin you manage people, lists and settings on the app's **Správa** page (or in the Google Sheet), so you don't need to open the code.

**Everything can be done on one kiosk.** The operator only reports ①, ② and the ③ risk question, then clicks Odeslat and the screen goes back home. The TL finishes ③, the leader signs ④, pilots fill ⑤ ⑥, and a manager closes the QRAP, all on the same kiosk. At every signature the kiosk asks **"Kdo podepisuje?"** and checks the name's role.

**The form follows the firm's QRAP V3.0 form.** Sections ① to ⑦ ask the same questions and follow the same QRQC rules as the original eQRAP (logistics version). Only the parts that belong to production or APU were removed: the APU and plant-level copies of a QRAP.

---

## 1. What changed compared with the big version

| | Big version (`apps-script/`) | **Lite** (`eqrap-lite/`) |
|---|---|---|
| Files to paste | 39 | **2** (+ optional `appsscript.json`) |
| Lines of code | ~7,200 | **~3,400** (≈1,450 server, ≈1,950 screen incl. styles) |
| Questions ①–⑦ | QRAP V3.0 (logistics) | **the same**, without the APU / plant level |
| Roles to set up | 10 (kiosk, operator, TL, supervisor, pilot, quality, EHS, manager, APU manager, admin) | **4**: VEDOUCÍ, MANAŽER, ADMIN (+ KIOSK for the kiosk account). Everyone else is a normal user; pilots are chosen in ④ |
| Screens | 13 | **6**: Tabule · Nový QRAP · Detail (form ①–⑦) · Přehled (managers) · Správa (admin) · Jak to funguje |
| Sheet tabs | ~20 | **8** (you edit only 3 of them) |
| Waiting | each screen asked the server (1–3 s) | only **first opening** and **saving** wait. Moving around is instant |

**Why it's faster:** when the page opens, it receives all open problems at once. Clicking a problem, filtering and searching then happen in the browser with no server call. The server is only called when you **save**, plus a quiet refresh every 90 seconds.

**What stays exactly as on the form:**

| Section | Questions and rules |
|---|---|
| ① POPIS PROBLÉMU | SAFETY · CO je za problém? · JAK byl objeven? (+ jiné) · KDY? · KDE? zóna + lokace · Kde vzniklo? · KOLIK? + jednotka / NOK situace bez kusů · Stejný problém v posledních 7 dnech? (+ číslo QRAP) · JMÉNO · číslo materiálu, HU / dodacího listu, dodavatel · **Foto ŠPATNĚ + Foto SPRÁVNĚ** (or an exception with a reason) |
| ② Kdo byl upozorněn? | roles (+ jiné). Kvalita is added automatically when ③ risk = ANO |
| ③ OKAMŽITÁ OPATŘENÍ <24h | Je riziko u zboží na skladě / expedovaného? (ANO → zkontrolováno / nalezeno špatně / kontrola probíhá, Kvalita gets an e-mail) · list of immediate actions (Typ, Co, Kdo, Hotovo v) · Proces zastaven? (+ obnoven v). ③ is complete only when every rule is met; the TL may finish it later |
| ④ Rozhodnutí OJT | Informace všem směnám (5' meeting) · Pokračovat s analýzou a 5 Proč (+ piloti) / Problém vyřešen: ŽÁDNÉ 5 Proč (not allowed when SAFETY = ANO) / Eskalace · komentář · signature. After signing, ①–④ are locked |
| ⑤ PŘÍČINA 5 Proč? | Proč to vzniklo? (5×) · Proč to nebylo zachyceno? (5×) · kořenová příčina · Co jsme se naučili z QR? · Příležitost k aktualizaci STANDARDU? (ANO creates the action "Aktualizovat standard") |
| ⑥ Konečné akce | each action removes one 5 Proč step, has a pilot, plan, done date and evidence link · **efektivita na 5 různých směnách** ("neefektivní" sends the QRAP back to analysis and a new action is needed) · closure checklist + signature |
| ⑦ Hodnocení QRQC | 1 RED BOX · 2 ROZDĚLENÍ · 3 POROVNÁNÍ · 4 POUČENÍ A SDÍLENÍ · 5 ON JOB TRAINING (OK / NOK / N/A) · OJT s kým · zpětná vazba + typ. A QRAP can be assessed many times |

**What was left out:**

- **Removed because it's APU / production only:** APU and plant-level QRAP copies.
- **Simplified app features (the form questions are not affected):**
  - drafts and the step-by-step wizard (now one form)
  - the manager dashboard
  - English
  - notes with review dates on actions
  - per-shift e-mail routing
  - 11 e-mail types reduced to 7 plus an optional morning reminder

---

## 2. Setup (about 10 minutes, one time)

> If you already set up an earlier Lite test, start again with a **new Sheet** (or delete all tabs and run setup again). The columns changed, so the old test tabs don't fit.

1. Create a **new Google Sheet**, for example "eQRAP Expedice". Use the account that should own the app (see §7 about ownership).
2. In the Sheet, open **Extensions → Apps Script**.
   - In `Code.gs`, delete everything and paste the content of **`eqrap-lite/Code.gs`**.
   - Click **+ → HTML** and name it **`Index`**. Delete everything and paste **`eqrap-lite/Index.html`**.
   - *(Optional)* In ⚙ Project Settings, tick "Show appsscript.json" and paste **`eqrap-lite/appsscript.json`**. If you skip this, set the time zone to *Europe/Prague* in Project Settings.
   - Click 💾 Save.
3. In the toolbar, choose the function **`setup`**, click **Run** and allow the permissions. This creates the 8 tabs and a Drive folder "eQRAP fotky".
4. Go back to the Sheet and reload it. A new menu **eQRAP** appears. Then:
   - In **Lidé**, replace the example people with real people (see §4). From now on you can do this on the **Správa** page in the app instead.
   - In **Seznamy**, check the zones, shifts and lists.
   - In **Nastavení**, fill in `EMAIL_KVALITA` and `EMAIL_BOZP`, and set `EMAILY` to `NE` while you are testing.
5. Back in Apps Script, click **Deploy → New deployment → ⚙ Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone within [your company]**
   - Click **Deploy** and copy the URL. That is the app.
   - For the kiosk: create one Google account just for the kiosk, add it to **Lidé** with the role **KIOSK**, and sign in with it on the kiosk PC or tablet. The app switches to kiosk mode by itself.
6. *(Optional)* Use **eQRAP → Vložit ukázková data** to see 3 example QRAPs. It's better to try this in a separate test Sheet.

**Updating the code later:** paste the new code, run **eQRAP → Nastavit tabulku** once (it adds any new columns), then go to **Deploy → Manage deployments → ✏ → Version: New version → Deploy**. The URL stays the same.

---

## 3. How it works: the flow and who does what

```
①②③  Operátor – ① popis + fotky, ② kdo byl upozorněn, ③ jen „riziko ano/ne“ → Odeslat → zpět na tabuli
       └─ e-mail: vedoucí zóny (+ lidé vybraní v ②), Kvalita při riziku ANO, BOZP při SAFETY ANO
③     TL / vedoucí – doplní okamžitá opatření do 24 h od KDY
④     Vedoucí – informované směny, rozhodnutí, podpis
       ├─ „Problém vyřešen: ŽÁDNÉ 5 Proč“ → čeká na uzavření manažerem
       ├─ „Eskalace“ → manažeři dostanou e-mail, manažer vybere piloty
       ↓
⑤ ⑥   Piloti – 5 Proč, konečné akce
⑥     TL – efektivita na 5 různých směnách
      Manažer – uzavře QRAP
⑦     Vedoucí / manažer – hodnocení QRQC (kdykoli, i vícekrát)
```

The **status is calculated automatically** from what has been filled in. Nobody sets it by hand:

| Status in the app | Means | Who acts |
|---|---|---|
| ③ Opatření | reported, ③ not complete yet (the page lists what is missing; deadline 24 h from KDY) | TL / anyone on the shift |
| ④ Rozhodnutí | ③ complete, waiting for the signed decision | VEDOUCÍ |
| ⑤ 5 Proč | root cause not marked yet, or no action yet | pilots |
| ⑥ Akce | definitive actions are open | pilots of the actions |
| ⑥ Ověření 5 směn | all actions done: record 5 effective shifts, then a manager closes | TL, then MANAŽER |
| Ke schválení | the leader decided "Problém vyřešen: ŽÁDNÉ 5 Proč" | MANAŽER |
| Uzavřeno / Zrušeno | closed by a manager / cancelled by a manager (the record stays) | – |

**Roles.** There are four, set per person in **Lidé** (or on the Správa page):

| | No role (operators, anyone) | **VEDOUCÍ** | **MANAŽER** (any number of people) | **ADMIN** (you) |
|---|:-:|:-:|:-:|:-:|
| ①② report + ③ risk question | ✓ | ✓ | ✓ | ✓ |
| ③ finish immediate actions (until ④) | ✓ | ✓ | ✓ | ✓ |
| ④ tick informed shifts, sign the decision | – | ✓ | ✓ | ✓ |
| ⑤ 5 Proč · ⑥ definitive actions | if chosen as pilot | ✓ | ✓ | ✓ |
| ⑥ mark own action done · record a 5-shift check | ✓ | ✓ | ✓ | ✓ |
| ⑦ QRQC assessment | – | ✓ | ✓ | ✓ |
| **close a QRAP** (also "vyřešeno bez 5 Proč") | – | – | ✓ | ✓ |
| cancel / reopen / unlock ①–④, **Přehled** (dashboard) | – | – | ✓ | ✓ |
| **Správa** page: people, lists, settings | – | – | – | ✓ |

The owner of the script is always ADMIN. All MANAŽERs have exactly the same rights, and you can add as many as you want. The fifth role, **KIOSK**, is only for the shared kiosk account.

**Who gets e-mails:**

| When | Who |
|---|---|
| new QRAP | leaders of that zone (empty zone in Lidé = all zones) + anyone ticked under "Poslat e-mail také" in ② |
| SAFETY = ANO | `EMAIL_BOZP` + managers |
| ③ risk = ANO | `EMAIL_KVALITA` |
| ④ pilots chosen | the pilots |
| ④ Eskalace | managers |
| new definitive action | the pilot of the action |
| ⑥ "neefektivní" | the pilots + leaders of the zone |
| every morning (optional) | reminder to leaders about open QRAPs, and to pilots about late actions |

### The kiosk: everything on one screen

- The kiosk signs in with its own Google account, which has the role **KIOSK** in Lidé.
- Anyone can report, finish ③ or record a 5-shift check without a name check. JMÉNO in ① is typed freely.
- At every signature the kiosk asks **"Kdo podepisuje?"**: ④, ⑤ ⑥, closing, ⑦, and cancel/reopen. The person types their name and picks it from the suggestions. The app checks that the name is an active person in Lidé with the right role. A leader's name can't close a QRAP, for example.
- The history records the person's e-mail with "(kiosk)" and the time. The cameras at the kiosk cover the rest.
- On the kiosk, even an ADMIN's name acts only as a manager. The Správa page works only on personal accounts.
- After a few minutes without use, the kiosk returns to the board by itself.

### What each person sees

- **Everyone:** the **Tabule** (home) with a big **"+ Nahlásit problém"** button and the list of QRAPs. Each row shows its status, who it's waiting for, and a progress bar ①–⑦. Buttons in a QRAP appear only for people allowed to use them.
- **"Moje úkoly":** each person's own work:
  - leaders: decisions in their zone
  - pilots: their analysis and actions
  - managers: QRAPs waiting for closure
- **Managers and admin** also see **Přehled**: the number of open and late QRAPs, and what's waiting for a decision or for a manager. It also shows the average time to close, % of ③ done within 24 h, repeated problems, a weekly chart of new vs. closed, the top problem sources and zones, late actions per pilot, and open SAFETY and escalations.
- **Admin** also sees **Správa**.

---

## 4. Everyday admin tasks (page Správa, no code)

| I want to… | Do this |
|---|---|
| add a person, make someone a leader or manager | **Správa → Lidé a role → + Přidat osobu** (Jméno, e-mail of their Google account, Role, Zóna) |
| let someone be a pilot | add them as a person (no role needed). The leader then picks them in ④ |
| take a role away / someone left | **Správa → Upravit →** untick "Aktivní". People are never deleted, so the history keeps their name |
| change zones, shifts or the lists in the form | **Správa → Seznamy**: one item per line → Uložit. Old QRAPs keep their old values |
| set who gets Quality / safety e-mails | **Správa → Nastavení**: E-mail Kvality, E-mail BOZP |
| change the 24 h deadline for ③, turn e-mails off, rename the app | **Správa → Nastavení** |
| send a morning reminder | menu **eQRAP → Zapnout denní připomínky** in the Sheet |
| correct ①–④ after the decision was signed | as manager, in the QRAP: **Správa QRAP → Odemknout ①–④** (with a reason). The decision must then be signed again |
| get rid of a duplicate or mistaken QRAP | as manager: **Správa QRAP → Zrušit QRAP** (with a reason). It disappears from the lists but stays in the history (managers find it under "Zrušené") |
| reopen a closed QRAP | as manager: **Správa QRAP → Znovu otevřít** |
| make a report | the **Přehled** page, or your own tab in the Sheet with formulas, or File → Download → Excel |
| back up | File → Version history works automatically; also make a monthly **File → Make a copy** |

Changes made on the Správa page apply immediately; other users see them after reloading the page. Everything you change there is written to the history as "SPRÁVA". You can still edit the tabs Lidé, Seznamy and Nastavení directly in the Sheet if you prefer (changes apply within 5 minutes, or use **eQRAP → Použít změny v nastavení hned**).

### Tabs in the Sheet

| Tab | What it is | May I edit it? |
|---|---|---|
| **Lidé** | people, roles, zones | ✅ yes, this is your main control |
| **Seznamy** | the dropdown values of the form | ✅ yes (don't rename the column headers) |
| **Nastavení** | name, e-mails, deadlines | ✅ only the *Hodnota* column |
| **Problémy** | one row = one QRAP (columns ① … ⑥) | ⚠ read only. Change data through the app |
| **Akce** | one row = one action (Část ③ = okamžité, ⑥ = konečné) | ⚠ read only |
| **Ověření** | the 5-shift effectiveness slots (all rounds) | ⚠ read only |
| **Hodnocení** | ⑦ QRQC assessments | ⚠ read only |
| **Historie** | who changed what and when | ⚠ read only (this is your audit trail) |

The five data tabs are protected with a warning, so you get a prompt before editing them by hand.

**Never do these:**

- rename, delete or reorder the columns in the data tabs (you may add your own columns *to the right*)
- delete the tabs Lidé, Seznamy or Nastavení
- give everyone edit access to the Sheet. Users don't need it at all, because the app works without it

---

## 5. If something is wrong

| Problem | Fix |
|---|---|
| "Aplikaci se nepodařilo spustit – chybí list / sloupec" | run **eQRAP → Nastavit tabulku (setup)**. It repairs things and never deletes data. Check that no column header was renamed |
| a leader has no "Rozhodnout" button | ③ must be complete first (the page shows what is missing). Their e-mail in Lidé must match their Google account exactly, and they must be active |
| the kiosk says "Jméno … není v seznamu Lidé" | the person must be active in Lidé; pick the name from the suggestions (upper/lower case and accents don't matter) |
| nobody can close a QRAP | only MANAŽER or ADMIN can close. Give someone the MANAŽER role on the Správa page |
| a pilot can't edit ⑤ | the pilot must be chosen in ④ (or added with "+ přidat pilota" by a leader) |
| "Podepsat uzavření" is greyed out | the checklist under it shows what is missing (e.g. "Co jsme se naučili z QR?" or 5 different effective shifts). Only a manager sees the button |
| e-mails don't arrive | `EMAILY` = `ANO`, the person has an e-mail in Lidé / Nastavení, check spam. Google allows about 1,500 e-mails a day |
| someone gets "you need permission" | the deployment must be "Anyone within [company]" and they must be signed in with their **company** Google account |
| I changed the code but nothing changed | **Manage deployments → New version** (§2) |
| the first opening takes 2–4 s | normal: Google starts the script. After that, clicks are instant and saves take about 1–2 s |

---

## 6. If you ever need to look at the code

Both files are split into numbered sections with a table of contents at the top. Typical changes:

| Change | Where |
|---|---|
| texts of the form (labels, hints) | `Index.html` section 7 (`popisForm`, `opatreniForm`, `decisionForm`, `pricinaForm`, `actionForm`, `assessForm`) |
| what a form part checks | `Code.gs` section 6 (`popisFrom_`, `opatreniFrom_`, `pricinaFrom_`, `defActionFields_`) |
| who may do what | `Code.gs` section 5: one-line rules `canPopis_ … canAssess_` |
| when a status changes, ③ completeness, closure checklist | `Code.gs` section 4 (`statusOf_`, `s3Missing_`, `checklist_`) |
| e-mail texts | `Code.gs` section 7 (`mailNew_`, `mailQuality_`, `mailPilots_` …) |
| colours | `Index.html` top of `<style>` (`--accent` etc.) |
| a new column | `Code.gs` section 1 `COLS`, then run setup (it adds the missing header) |

| `Code.gs` (server) | `Index.html` (screen) |
|---|---|
| 1 tabs, columns, defaults | 1 state and texts |
| 2 web app entry (`doGet`) | 2 small helpers (`h`, `api`, `save`) |
| 3 API called by the page | 3 header and routing |
| 4 status rules | 4 board (Tabule) |
| 5 permissions | 5 new QRAP |
| 6 sheet helpers and form checks | 6 QRAP detail ①–⑦ |
| 7 e-mails, daily reminder | 7 forms ① … ⑦ |
| 8 setup, menu, example data | 8 photos · 9 help, kiosk, refresh |

---

## 7. Is it safe to use in the firm?

**Short answer:** it's safe for an **internal pilot in expedice**. Before it becomes the official QRAP record, get IT and Quality to approve it and move the ownership to a team account.

### What protects it

- **Only company accounts** can open it ("Anyone within [company]"). People outside the company can't.
- **Users never get access to the Sheet or the Drive folder.** The app runs as the owner, and **every save is checked on the server** against the Lidé tab and the QRAP rules. Hiding a button in the browser is only for convenience. The real check is on the server, so a user can't bypass it.
- **Admin functions** (setup, example data, reminders) run only for the owner of the script. The Správa page works only for ADMIN on a personal account, never on the kiosk.
- **Kiosk signatures are checked.** The typed name must be an active person in Lidé with the right role, and the history records who it was and that it was signed on the kiosk.
- **Only managers close.** A leader can decide "Problém vyřešen", but the QRAP is closed only after a manager approves it.
- **Everything is logged** in Historie: who, when and what. Nothing can be deleted from the app. "Zrušit" keeps the record with a reason, and removed actions stay in the Sheet marked "Odebráno".
- **Signed parts are locked.** After ④ is signed, ①–④ can only be unlocked by a manager, with a reason that goes to the history.
- **Typed text can't do harm.** It's always shown as plain text, never run as code. In the Sheet it's stored as text, never as a formula, so values like "00123" stay exactly as typed. Evidence links must start with http(s).
- A photo can be opened **only through its own QRAP**, so nobody can read other files from the owner's Drive.
- **No outside services or libraries.** Everything stays in your company's Google Workspace, the same place as your e-mail and Drive.
- **Tested:** 212 automatic server checks (every rule of ①–⑦, roles, kiosk signatures, Správa, e-mails, bad input) and a full browser test of the whole flow from reporting to closure and assessment, including the kiosk, the dashboard, Správa and a phone.

### Risks you should know about (and what to do)

| Risk | What to do |
|---|---|
| **It depends on one person's account.** If the owner leaves and the account is deleted, the app stops and the photos disappear | Put the Sheet in a **Shared Drive**, or create it under a **team account** (e.g. qrqc-expedice@…). Have 2 people with edit access to the Sheet |
| **It isn't a validated system** (IATF 16949 / customer requirements) | Run it **in parallel with the paper QRAP for 2–4 weeks**. Let Quality decide if it can replace the paper |
| **Everyone in the company can see all QRAPs** | This is intended for transparency. Don't write health details of injuries into it; BOZP injuries still go to the official injury book |
| **Kiosk shared account:** the name at a signature is typed, not proven (no PIN) | The name must match Lidé and have the right role; the kiosk is covered by cameras. Give the kiosk account only the role KIOSK |
| **Google limits:** about 1,500 e-mails a day; about 30 people saving *at the same second* | Plenty for one warehouse. Not meant for the whole company |
| **Personal data** (names, e-mails of employees) | Tell IT / the data protection officer. It stays inside your Google Workspace |
| **Backups** | Version history is automatic. Also make a monthly File → Make a copy |

### Pilot checklist

- [ ] IT agrees with an Apps Script web app on the company domain (and with a kiosk account, if used).
- [ ] Owner is a team account or Shared Drive; 2 admins have edit access to the Sheet.
- [ ] Lidé filled in (Správa page): every leader and manager, everyone who can be a pilot, and the kiosk account with role KIOSK.
- [ ] Seznamy match your zones, shifts and lists; `EMAIL_KVALITA` and `EMAIL_BOZP` filled in.
- [ ] One week with `EMAILY` = `NE` on a test Sheet, then switch to the real Sheet with `EMAILY` = `ANO`.
- [ ] Short training (5 min): show "Jak to funguje" in the app.
- [ ] 2–4 weeks in parallel with paper, then Quality decides.

---

*Placeholder data only: all example people use example.com addresses.*
