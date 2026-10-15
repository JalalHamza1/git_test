# eQRAP Expedice: admin guide

This guide is for the **admin** of eQRAP Expedice, the electronic QRAP V3.0 form for the warehouse and expedice. It covers:

1. [What the app is](#1-what-the-app-is)
2. [Setting it up](#2-setting-it-up-one-time-about-10-minutes)
3. [Navigating the app, page by page](#3-navigating-the-app-page-by-page)
4. [How a QRAP moves from ① to ⑦](#4-how-a-qrap-moves-from--to-)
5. [Roles, the kiosk and e-mails](#5-roles-the-kiosk-and-e-mails)
6. [Everyday admin work (no code)](#6-everyday-admin-work-no-code)
7. [The Google Sheet](#7-the-google-sheet)
8. [How the code is organised](#8-how-the-code-is-organised)
9. [Editing `Code.gs` (server)](#9-editing-codegs-server)
10. [Editing `Index.html` (screen)](#10-editing-indexhtml-screen)
11. [Recipes: common changes step by step](#11-recipes-common-changes-step-by-step)
12. [Testing and publishing a change](#12-testing-and-publishing-a-change)
13. [Troubleshooting](#13-troubleshooting)
14. [Safety and good practice](#14-safety-and-good-practice)

The app is two files: **`Code.gs`** (server) and **`Index.html`** (everything you see). The data lives in one Google Sheet. All example people use example.com addresses.

---

## 1. What the app is

- It is the firm's **paper QRAP V3.0 form**, sections ① to ⑦, with the same blocks, questions and QRQC rules. Only the APU and plant-level parts, which belong to production, were left out.
- **The screens look like the paper:** the board shows every QRAP as a strip of the paper form, and a QRAP opens as the full paper form with its blocks filled in.
- **Everything can be done on one kiosk tablet:**
  - As on the paper, the operator fills ① Popis problému, ② Kdo byl upozorněn? and ③ Okamžitá opatření, clicks **Odeslat**, and the screen returns to the board. Only the ③ risk question is required; the TL completes the rest of ③ within 24 h.
  - The leader signs ④, and the pilots fill ⑤ and ⑥.
  - A **manager** closes the QRAP.
  - At every signature the kiosk asks **"Kdo podepisuje?"** and checks the name and role against the Lidé tab.
- **The status is calculated automatically** from what has been filled in. Nobody sets it by hand.
- **It is fast:** the page receives all open QRAPs when it opens, so clicking, filtering and searching need no server call. The server is called only when something is saved, plus a quiet refresh every 90 seconds.
- **It is Czech only.** The user interface and e-mails are in Czech; the code comments are in English.

---

## 2. Setting it up (one time, about 10 minutes)

1. Create a **new Google Sheet**, for example "eQRAP Expedice". Use the account that should own the app; a team account is best (see §14).
2. In the Sheet, open **Extensions → Apps Script**:
   - In `Code.gs`, delete everything and paste the content of **`eqrap-lite/Code.gs`**.
   - Click **+ → HTML**, name the file **`Index`** (no extension), and paste **`eqrap-lite/Index.html`**.
   - *(Optional)* In **⚙ Project Settings**, tick "Show appsscript.json" and paste **`eqrap-lite/appsscript.json`**. If you skip this, set the time zone to **Europe/Prague** in Project Settings.
   - Click **💾 Save**.
3. In the toolbar, choose the function **`setup`**, click **Run** and allow the permissions. This creates 8 tabs and a Drive folder "eQRAP fotky".
4. Reload the Sheet. A menu **eQRAP** appears. Then:
   - **Lidé:** replace the example people with real people. You can do this later in the app on the Správa page instead.
   - **Seznamy:** check the zones, shifts and dropdown lists.
   - **Nastavení:** fill in `EMAIL_KVALITA` and `EMAIL_BOZP`. Set `EMAILY` to `NE` while you test.
5. In Apps Script, click **Deploy → New deployment → ⚙ Web app** and set:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone within [your company]**
   - Click **Deploy**. The URL you get is the app.
6. **Kiosk:** create one Google account just for the kiosk and add it to Lidé with the role **KIOSK**. Sign in with it on the tablet and open the URL. The app switches to kiosk mode by itself (bigger buttons, automatic return to the board, signature by name).
7. *(Optional)* **eQRAP → Vložit ukázková data** adds 3 example QRAPs. Do this in a separate test Sheet.

---

## 3. Navigating the app, page by page

### Header (on every page)

| Item | Who sees it | What it does |
|---|---|---|
| **QRQC** (text logo) | everyone | back to the board |
| **Tabule** | everyone | the home page with all QRAPs |
| **Jak to funguje** | everyone | visual guide: how to fill in a QRAP, what happens next, who can do what |
| **Správa** | ADMIN only | people, lists and settings |
| **Přehled manažera** (button) | MANAŽER, ADMIN | the manager overview |
| **+ Nahlásit problém** | everyone | new QRAP (hidden on the board, which has its own big button) |
| **Zobrazit jako** (dropdown) | only the owner of the script | try the app as another role: běžný uživatel, vedoucí, manažer or kiosk. "Admin (vy)" switches back. The server really applies the chosen role, so you see exactly what that person sees |
| name + role | everyone | who is signed in (on the kiosk: "Kiosk") |

### Tabule: the home page

![Tabule](../dev-tests/lite/shots/01-board-paper.png)

- **Big "+ Nahlásit problém" button** at the top right.
- **Four count cards.** Click a card to filter the list:
  - On a personal account: Otevřené, Moje úkoly, Po termínu, Uzavřené.
  - On the kiosk: Otevřené, Čeká na rozhodnutí, Čeká na manažera, Po termínu.
- **"Moje úkoly"** is each person's own work:
  - leaders: QRAPs in their zone waiting for ③ or ④
  - pilots: their analysis and actions
  - managers: QRAPs waiting to be closed
- **Search** looks in the QRAP number, CO, the descriptions of the wrong and good part, part / HU / delivery note numbers, supplier and zone.
- **Filters:** Stav (including Čeká na rozhodnutí, Čeká na manažera and, for managers, Zrušené), Zóna, Období (24 h, 7 or 30 days).
- **Zobrazení: "Formulář QRAP" (default) or "Tabulka".** The choice is remembered on each device.
  - **Formulář QRAP:** a small bordered header at the top (who fills what, and the block titles ①–⑦ each above its column), then one paper strip per QRAP. Above each strip is the number, the status, who it waits for, and "po termínu!" when late. The block that is next (for example ③ or ④) has a **red** frame. Long texts are shortened; click the strip to open the full form.
  - **Tabulka:** the compact table (Číslo · Problém · Kde · Kdy · Nahlásil · Stav · Krok ①–⑦), sortable by clicking a column header.
  - Both views have page buttons and a "rows per page" setting at the bottom.
- **"Moje konečné akce"** appears above the list when you are the pilot of an open action.
- **"Zobrazit i starší uzavřené"** loads closed QRAPs older than `ZOBRAZIT_UZAVRENE_DNI` days.
- **"Zrušené"** link (managers only) shows cancelled QRAPs.
- The board refreshes by itself every 90 seconds. **Obnovit** refreshes now.

### Nový QRAP: the form for the operator

![Nový QRAP](../dev-tests/lite/shots/02-new.png)

- The tabs across the top are the steps, in the order of the paper:

  | Step | Questions |
  |---|---|
  | **Problém** | SAFETY · CO je za problém? · JAK byl objeven? (both dropdowns; "jiné" opens a text field right under the question) |
  | **Kdy a kde** | KDY ? (date and time, "Teď" button) · KDE ? (one zone) |
  | **Kolik a kdo** | KOLIK špatných dílů? with the unit on the same row · Stejný problém v posledních 7 dnech? (ANO → N° QRAP, right under the question) · JMÉNO |
  | **Popis** | ŠPATNÝ díl – popis · DOBRÝ díl – popis (both required) · optional photo of each · číslo dílu, HU / dodací list and dodavatel (all marked "nepovinné") |
  | **Upozornění** | Kdo byl upozorněn? (roles + jiné) |
  | **Opatření** | Ochranná opatření: riziko na již naskladněném / expedovaném zboží? (required; ANO → Přetříděno / Špatné kusy) · Okamžitá opatření (Co, Kdo, Čas) · Čas re-startu procesu/stanice |
  | **Kontrola** | everything on one page for a last check |

  - ✓ = done, ○ = not yet, green = the current step.
  - You can click a tab to go back. To go forward, use **Pokračovat →**, which checks the step first.
- **Hints:**
  - In text fields the hint is the grey placeholder; it disappears when you type.
  - Other fields have a small **ⓘ** next to the label. Tap it to show a one-line hint.
- **Layout:** every question is on the left in bold, the answer on the right in normal weight, one question per row. The same layout is used in the block forms on the QRAP page.
- **Required fields** have a red ✱. Fields that are not on the paper form are marked "nepovinné" and never block sending. If something is missing, the field turns red and a message appears at the bottom.
- **Photos are optional.** "📷 Přidat foto" opens the camera directly on the kiosk tablet or a phone, and the file picker on a PC. Photos are made smaller in the browser before they are sent. A photo can also be added later on the QRAP page, until ④ is signed.
- **③ for the operator:** only the risk question is required. Whatever the operator doesn't know (for example the re-start time) stays empty; the QRAP then waits in "③ Opatření" and the TL completes it within 24 h. If the operator fills ③ completely, the QRAP goes straight to "④ Rozhodnutí".
- **Kontrola** shows everything on one page for a last check. **Odeslat ✓** saves the QRAP, sends the e-mails and returns to the board with a green confirmation.

### QRAP page: the paper form ①–⑦

![QRAP page](../dev-tests/lite/shots/03-closed.png)

- **At the top:** the breadcrumb (Tabule / Q-…), the number, the status, SAFETY / ESKALACE marks, and the **Tisk / PDF** button.
- **Další krok** bar: what has to happen next, who does it, what is missing, the deadline, and the main button for you (for example **Doplnit ③**, **Rozhodnout ④**, **Vyplnit 5 Proč ⑤**, **+ Přidat konečnou akci ⑥**).
- **The paper form**, exactly in the paper's layout:
  - grey bands "QR vyplňuje OPERÁTOR…", "Vyplňuje Supervizor", "Vyplňují pověření pracovníci…", "Supervizor / Manažer"
  - ① Popis problému (N°, SAFETY, CO a JAK, KDY, KDE, KOLIK, Stejný problém, JMÉNO, ŠPATNÝ / DOBRÝ díl with photos), ② Kdo byl upozorněn?, ③ Okamžitá opatření <24h
  - ④ Rozhodnutí OJT (shifts, decision, piloti, komentář, podpis)
  - ⑤ Příčina 5 Proč ? (the arrow with 1–5 PROČ; the root cause is green; the optional "Proč nebylo zachyceno" chain is written under it)
  - ⑥ Konečné akce (Co jsme se naučili, actions with Kdo / plán / hotovo, Uzavření QRAP schváleno, Efektivita ①–⑤, Příležitost k aktualizaci STANDARDU)
  - ⑦ Hodnocení QRQC (the latest assessment; older ones are listed under the form)
  - the block that is next has a **red** frame.
- **Filling a block – two ways:**
  - **Straight in the paper:** click a block you may fill (it gets a dashed green frame on hover), or its small button in the block (**Upravit ① ②**, **Doplnit ③**, **Rozhodnout ④**, **Vyplnit 5 Proč**, **+ Konečná akce**, **+ Hodnotit**). The block widens and its questions appear right inside the paper.
  - **Under the paper:** the buttons in the "Další krok" bar open the same form in a panel under the paper.
  - Either way **Uložit** saves and **Zavřít** / **Zrušit** closes. Blocks and buttons react **only for people who are allowed to fill them**.
- **Under the paper**, when needed: ⑥ Konečné akce with **✓ Hotovo** / **Upravit**, the 5-shift table (Ověření 5 směn), the closing checklist with **Podepsat uzavření** / **Schválit a uzavřít**.
- **Historie změn:** click **Zobrazit** to load who changed what and when.
- **Správa QRAP – jen pro manažera** (folded away; click to open): **Zrušit QRAP** (duplicate or mistake), **Znovu otevřít**, **Odemknout ①–④** (cancels the signed decision). A reason is always required; on the kiosk also the manager's name, which is checked against Lidé. On personal accounts only managers see it; on the kiosk it is shown to everyone because the name is checked when saving.
- **Tisk / PDF** prints just the paper form on one landscape A4, or saves it as a PDF.

### Přehled manažera (managers and admin)

![Přehled manažera](../dev-tests/lite/shots/10-dashboard.png)

- **Four compact cards:**
  - **Otevřené** (and how many are late)
  - **Čeká na vás** (waiting for closure)
  - **Nahlášeno** in the last 8 weeks, with a small bar strip per week. Hover a bar for the exact number.
  - **③ do 24 h**: the share of QRAPs whose immediate actions were complete within the deadline.
  - Clicking Otevřené or Čeká na vás switches the list below.
- **Otevřené QRAP:** the main list as paper strips (or the table, with the same switch as on the board), with a choice of Všechny otevřené / Čeká na uzavření / SAFETY a eskalace / Po termínu, plus search.
- **Další statistiky** (closed until you click it):
  - QRAPs by zone and by how they were found (last 90 days). Click a bar to open the board filtered by it.
  - Overdue final actions per pilot.
  - The average time to close.
- **Načíst všechna data** also loads old closed QRAPs. **Tisk / PDF** prints the overview.

### Správa (admin only)

- **Lidé a role:** add a person, edit, or deactivate. People are never deleted.
- **Seznamy ve formuláři:** one item per line: Zóny (KDE), CO je za problém, JAK byl objeven, Jednotky, Kdo byl upozorněn (②), Směny (④). Keep a line "jiné" in CO, JAK and ② if people should be able to write their own text.
- **Nastavení:** app name, e-mails on/off, Quality and BOZP e-mails, the ③ deadline, how many days of closed QRAPs to show, the kiosk timeout, and the app link for e-mails.

Changes apply immediately for you. Other users see them after reloading the page. Every change is written to the history as "SPRÁVA".

### Jak to funguje

![Jak to funguje](../dev-tests/lite/shots/05-help.png)

- **A short visual guide for operators:** the 7 steps of the form (Problém → Kdy a kde → Kolik a kdo → Popis → Upozornění → Opatření → Kontrola), each with an icon and one sentence, and a "+ Nahlásit problém" button.
- **Co se děje potom:** ④ Supervizor → ⑤ ⑥ Piloti → ⑥ Ověření → Manažer uzavře · ⑦.
- **Na kiosku:** signing by name, and the automatic return to the board.
- **Kdo co může:** the roles table, folded away until someone clicks it.
- The admin role is deliberately not shown there; it lists only Kdokoli, Vedoucí and Manažer.

---

## 4. How a QRAP moves from ① to ⑦

```
①②③  Operátor     – ① popis problému, ② kdo byl upozorněn, ③ okamžitá opatření (povinné jen riziko) → Odeslat
③     TL           – doplní, co v ③ chybí, do 24 h od KDY
④     Vedoucí      – informované směny + rozhodnutí + podpis
        ├─ „Problém vyřešen: ŽÁDNÉ 5 Proč“ → manažer schválí a uzavře
        ├─ „Eskalace“ → manažeři dostanou e-mail
        └─ „Pokračovat s analýzou a 5 Proč“ → piloti
⑤ ⑥   Piloti       – 5 Proč, kořenová příčina, konečné akce
⑥     TL           – efektivita na 5 různých směnách
       Manažer      – podepíše uzavření
⑦     Vedoucí / manažer – hodnocení QRQC (kdykoli, i vícekrát)
```

| Status | Means | Who acts | Exact rule (`statusOf_` in Code.gs) |
|---|---|---|---|
| **③ Opatření** | reported, ③ not complete | TL / anyone on the shift | `s3Done` is empty |
| **④ Rozhodnutí** | ③ complete, waiting for the decision | VEDOUCÍ | no `decision` yet |
| **Ke schválení** | leader chose "vyřešeno bez 5 Proč" | MANAŽER | `decision = VYŘEŠENO` |
| **⑤ 5 Proč** | no root cause marked, or no final action yet | pilots | `rootOk_` false or no ⑥ action |
| **⑥ Akce** | final actions are open | pilots of the actions | some ⑥ action not done |
| **⑥ Ověření 5 směn** | all actions done; 5 different effective shifts, then closure | TL, then MANAŽER | everything else |
| **Uzavřeno** | closed by a manager | – | `closedAt` set |
| **Zrušeno** | cancelled by a manager (record kept) | – | `cancelReason` set |

**Important rules:**

- **When ③ is complete** (the page lists anything that is missing):
  - the risk question (Ochranná opatření) is answered
  - if the risk is ANO, Třídění – data (Přetříděno / Špatné kusy) is filled in
  - there is at least one immediate action, and every one has its Čas (= done)
  - "Čas re-startu" is optional, as on the paper
- **Signing ④** locks ①–④. Only a manager can unlock them (with a reason), and the decision must then be signed again.
- **"Vyřešeno bez 5 Proč"** is not allowed when SAFETY = ANO.
- **Each final action** removes one 5 Proč step (1.–5. Proč, or a step of the optional "Proč nebylo zachyceno" chain), or is "Aktualizovat standard".
- **Effectiveness:** 5 slots, each a **different** shift (date + shift).
  - "NEEFEKTIVNÍ" sends the QRAP back to analysis.
  - A new round of slots starts, and a new action is needed.
- **Closing checklist** (shown above the button):
  - the QRAP is in "Ověření 5 směn"
  - the root cause is marked
  - all final actions are done
  - the standard question is answered
  - 5 different effective shifts are recorded
  - "Co jsme se naučili z QR?" is filled in
  - Only a MANAŽER (or ADMIN) can sign the closure.
- **⑦ assessment** can be added many times, by leaders and managers.

---

## 5. Roles, the kiosk and e-mails

### Roles (tab Lidé, column Role)

| | none (operators) | **VEDOUCÍ** | **MANAŽER** | **ADMIN** |
|---|:-:|:-:|:-:|:-:|
| ①②③ report the problem and the immediate actions | ✓ | ✓ | ✓ | ✓ |
| ③ finish immediate actions (until ④) | ✓ | ✓ | ✓ | ✓ |
| edit ①② of an own report before ④ | own only | ✓ | ✓ | ✓ |
| ④ informed shifts, sign the decision | – | ✓ | ✓ | ✓ |
| ⑤ 5 Proč, ⑥ final actions | if chosen as pilot | ✓ | ✓ | ✓ |
| ⑥ mark own action done, record a shift check | ✓ | ✓ | ✓ | ✓ |
| ⑦ QRQC assessment | – | ✓ | ✓ | ✓ |
| close a QRAP, cancel / reopen / unlock, Přehled | – | – | ✓ | ✓ |
| Správa page | – | – | – | ✓ |

- **Leaders and zones:** a leader with a zone in Lidé gets e-mails only for that zone. A leader with no zone gets e-mails for all zones.
- **Managers:** there can be any number, all with the same rights. If no MANAŽER exists, manager e-mails go to the ADMIN.
- **KIOSK:** only for the shared kiosk account.
- **The owner:** the owner of the script is always ADMIN, unless you use "Zobrazit jako" to test another role.

### The kiosk

- Reporting, finishing ③, recording a shift check and marking an action done need **no name check**. JMÉNO in ① is typed freely.
- **Signatures** (④, ⑤ ⑥ for pilots, closing, ⑦, cancel / reopen / unlock) ask **"Kdo podepisuje?"**.
  - The person types their name and picks it from the suggestions.
  - The server checks that it is an **active** person in Lidé with the **right role**. Accents and upper/lower case don't matter.
- **An ADMIN name on the kiosk** acts as a manager only. The Správa page never works on the kiosk.
- **The history** records the person's e-mail plus "(kiosk)" and the time.
- **Timeout:** after `KIOSK_NAVRAT_SEKUND` seconds without a touch, the kiosk returns to the board.

### Who gets e-mails

| When | Who |
|---|---|
| new QRAP | leaders of the zone |
| SAFETY = ANO | `EMAIL_BOZP` + managers |
| ③ risk = ANO | `EMAIL_KVALITA` |
| pilots chosen in ④ | the pilots |
| ④ Eskalace | managers |
| new final action | the action's pilot |
| ⑥ NEEFEKTIVNÍ | pilots + zone leaders |
| every morning (optional) | leaders: open QRAPs; pilots: late actions |

All e-mails are switched off with `EMAILY = NE`.

---

## 6. Everyday admin work (no code)

| I want to… | Do this |
|---|---|
| add a person, make someone a leader or manager | **Správa → Lidé a role → + Přidat osobu**: Jméno, e-mail of their company Google account, Role, Zóna |
| let someone be a pilot | add them without a role. The leader picks them in ④ |
| someone left / take a role away | **Správa → Upravit →** untick **Aktivní**. Never delete people, because the history keeps their name |
| change zones, shifts or dropdown values | **Správa → Seznamy**: one item per line → **Uložit**. Old QRAPs keep their old values |
| set the Quality / BOZP e-mail | **Správa → Nastavení** |
| change the ③ deadline, turn e-mails off, rename the app | **Správa → Nastavení** |
| turn on the morning reminder | in the Sheet: **eQRAP → Zapnout denní připomínky e-mailem** |
| correct ①–④ after ④ was signed | as a manager, in the QRAP: **Správa QRAP → Odemknout ①–④** (reason required) |
| remove a duplicate QRAP | **Správa QRAP → Zrušit QRAP** (reason required). It is hidden but kept |
| reopen a closed QRAP | **Správa QRAP → Znovu otevřít** |
| check what a leader / operator / kiosk sees | header **Zobrazit jako** (owner only), then "Admin (vy)" to return |
| export data | in the Sheet: **File → Download → Excel**, or build your own tab with formulas |
| back up | version history is automatic. Also do **File → Make a copy** once a month |

---

## 7. The Google Sheet

| Tab | Content | May I edit it by hand? |
|---|---|---|
| **Lidé** | Jméno, E-mail, Role, Zóna, Aktivní | ✅ yes (or use Správa) |
| **Seznamy** | the dropdown values, one column per list | ✅ values only; don't rename the headers |
| **Nastavení** | Klíč, Hodnota, Popis | ✅ only the *Hodnota* column |
| **Problémy** | one row per QRAP; columns named after the form (① …, ② …) | ⚠ no, use the app |
| **Akce** | ③ immediate and ⑥ final actions (column *Část*) | ⚠ no |
| **Ověření** | the 5-shift effectiveness slots, all rounds | ⚠ no |
| **Hodnocení** | ⑦ assessments | ⚠ no |
| **Historie** | audit trail: time, who, QRAP, what | ⚠ no, never |

- **Applying changes:** changes in Lidé, Seznamy or Nastavení apply within 5 minutes, or at once with **eQRAP → Použít změny v nastavení hned**.
- **Never:**
  - rename, delete or reorder columns in the data tabs (adding your own columns at the far right is fine)
  - delete the settings tabs
  - give users edit access to the Sheet (they don't need it; the app runs as the owner)
- **eQRAP menu** in the Sheet: Nastavit tabulku (setup) · Použít změny v nastavení hned · Zapnout / Vypnout denní připomínky · Vložit ukázková data.

---

## 8. How the code is organised

```
Google Sheet  ←→  Code.gs (server, runs as the owner)  ←→  Index.html (screen, runs in the browser)
   data + settings     checks every save, sends e-mails          shows data, collects input
```

1. **Opening the page:** `doGet` in Code.gs builds the page from `Index.html` and embeds all start data as JSON (`BOOT`): who you are, settings, lists, people, open QRAPs, actions, checks and assessments.
2. **Saving:** the page calls a server function with `google.script.run` (wrapped as `api('apiSave', …)` in Index.html).
3. **On the server**, every `api…` function:
   1. takes a lock, so two people can't write at the same time
   2. checks the permission (`can…_`)
   3. validates the input (`…From_`)
   4. writes the Sheet
   5. recalculates the status (`statusOf_`)
   6. writes the history (`log_`)
   7. sends e-mails
   8. returns the fresh QRAP, which the page puts into its data (`store`)

> **Golden rule:** the screen only *hides* buttons for convenience. **All real checks are in Code.gs.** When you change a rule, change it in Code.gs. Change Index.html only so the screen matches.

### Code.gs: the sections

| § | Section | Main contents |
|---|---|---|
| 1 | Tabs, columns, defaults | `TAB`, `COLS`, `SETTINGS`, `LISTS`, `EXAMPLE_PEOPLE`, `DECISIONS`, `ROLES`, `NEXT_STEP` |
| 2 | Web app entry | `doGet`, `startData_` |
| 3 | API used by the page | `apiCreate`, `apiSave` (parts popis / opatreni / smeny / rozhodnuti / pricina / piloti / uzavreni), `apiSaveAction`, `apiSaveEffect`, `apiAssess`, `apiSetPhoto`, `apiPhoto`, `apiHistory`, `apiAdmin`, `apiViewAs`, `apiAdminData`, `apiSavePerson`, `apiSaveList`, `apiSaveSettings` |
| 4 | Status rules | `statusOf_`, `s3Missing_`, `effState_`, `checklist_`, `finish_` |
| 5 | Permissions | `me_`, `signAs_` (kiosk signatures), `canPopis_ … canAssess_`, `pubQ_` (what the page receives) |
| 6 | Sheet helpers and form checks | `table_`, `insert_`, `update_`, `log_`, `lock_`, `cfg_`, `readPeople_`; validators `popisFrom_`, `opatreniFrom_`, `pricinaFrom_`, `defActionFields_`; `savePhoto_` |
| 7 | E-mails | `leaders_`, `managers_`, `mailNew_`, `mailSafety_`, `mailQuality_`, `mailPilots_`, `mailEscalated_`, `mailAction_`, `mailNotEffective_`, `send_`, `dailyReminder` |
| 8 | Setup and menu | `onOpen`, `onEdit`, `clearCache`, `setup`, `installReminder`, `exampleData` |

### Index.html: the parts

| Part | What it contains |
|---|---|
| `<style>` | the whole look. Colours, spacing and widths are variables at the top (`:root`) |
| 1. State and texts | `S` (all data on the page), `STATUS` (status names), `DECISIONS`, `CRITERIA` (⑦), `SECTION_TITLES` |
| 2. Small helpers | `h()` creates elements (text is always safe), `fill()`, `api()`, `save()`, `submit()`, `store()`, date formatting, `isLate`… |
| 3. Header and routing | `ICONS` / `icon()`, `go()` (switch page), `render()`, `header()`, `pageHead()`, `viewAsSelect()` |
| 4. Board | `FILTERS`, `COLUMNS`, `boardPage()`, `rowEl()` (one table row), `myActions()`, `layoutSwitch()` (Formulář QRAP / Tabulka) |
| 5. New problem | `newPage()`: the step tabs and the `steps` list |
| 6. The paper form | `paperHead()` (grey bands and titles), `paperBody(q, big)` (one QRAP filled into blocks ①–⑦), `paperList()` (board strips); the QRAP page: `detailPage()`, `nextBar()`, `editorPanel()` (form of the block being filled), `actionsPanel()`, `effectBox()`, `closureBox()`, `historyBox()`, `adminBox()` |
| 7. Forms | `makeForm()` (form builder), `popisForm`, `opatreniForm`, `decisionForm`, `pricinaForm`, `actionForm`, `assessForm`, `signerField` |
| 8. Photos | `photoSlot` (photo on the paper + camera button), `photoPicker` (new QRAP), `shrink` (resizes before upload) |
| 9. Pages and start | `sparkline()`, `barList()`, `dashPage()`, `adminPage()`, `helpPage()`, `refresh()`, `startKiosk()`, `start()` |

**Tip:** to find something, search (Ctrl+F) for the Czech text you see on the screen. For example, search for `'Podepsat uzavření'` to land in `closureBox`.

---

## 9. Editing `Code.gs` (server)

### Rules that keep the app safe

- **Every `api…` function must check permission** with `need_(can…_(me, q), 'message')` before writing anything.
- **Never trust input from the page.** Pass every value through a validator: `txt_(v, max)`, `yn_(v)`, `num_(v, label)`, `iso_(v)`, `day_(v)`, `oneOf_(v, list, msg)`, `url_(v)`.
- **Write through `insert_` / `update_`.** They put an apostrophe before text, so "00123" stays text and "=…" is never run as a formula.
- **Log every change** with `log_(id, 'what happened')`.
- **Wrap writes in `lock_(() => { … })`.**
- **Error messages** (`need_`) are shown to the user, so write them in Czech.

### Columns: `COLS`

Each column is `['nameInCode', 'Header in the Sheet']`:

```js
['materialNo', '① Číslo materiálu'], ['huNo', '① Číslo HU / dodacího listu'], ['supplier', '① Dodavatel'],
```

- **Order:** the order in `COLS` is the order of the columns that `setup` creates.
- **Adding:** you may add new entries anywhere. `setup` adds missing headers at the end and **never deletes data**.
- **Renaming:** don't rename a header that already has data. If you must, rename it in the Sheet *and* in `COLS` at the same time.

### Settings and lists: `SETTINGS`, `LISTS`

```js
['LHUTA_OPATRENI_HODIN', 24, 'Do kolika hodin od KDY mají být hotová ③ okamžitá opatření.'],
['shifts', 'Směny', ['Ranní', 'Odpolední', 'Noční']]
```

- These are only **defaults** that `setup` writes the first time. After that, the values live in the Sheet: change them on the Správa page, not here.
- **A new setting:** add a row here, run setup, then read it in code with `setting_('MY_KEY')`.
- **A new list:** add a row to `LISTS`. On the page it is available as `S.lists.myKey`.

### Permissions: section 5

Each rule is one line. `me.lead` = VEDOUCÍ/MANAŽER/ADMIN, `me.manager` = MANAŽER/ADMIN.

```js
function canDecide_(me, q) { return me.lead && q.status === 'ROZHODNUTÍ'; }
function canClose_(me, q) { return me.manager && (q.status === 'OVĚŘENÍ' || q.status === 'SCHVÁLENÍ'); }
function canAssess_(me, q) { return me.lead && q.status !== 'ZRUŠENO'; }
```

- **The page follows automatically:** `pubQ_` sends these results to the page as `q.can.decide`, `q.can.close` and so on. Buttons show or hide by themselves.
- Example: to let only managers do ⑦, change `canAssess_` to `me.manager && …`.

### Status: section 4

- `statusOf_` decides the status from the data, with the first matching rule winning.
- `s3Missing_` lists what ③ still needs.
- `checklist_` builds the closing checklist.
- If you add a status, also add it to `NEXT_STEP` in Code.gs and to `STATUS`, `stage()` and `NOW_CELL` (which paper block is highlighted) in Index.html.

### E-mails: section 7

Every e-mail is a list of lines:

```js
function mailNew_(q) {
  send_(leaders_(q.zone).concat(list_(q.notifyPeople)), q.id + ' – nový problém (' + q.zone + ')',
    ['Byl nahlášen nový QRAP.', ''].concat(facts_(q), [...]), q.id);
```

- `send_(to, subject, lines, id)` adds the app name to the subject and an **Otevřít** link at the end.
- It does nothing when `EMAILY = NE`, and a failed e-mail never stops a save.
- **To change the recipients**, change the first argument: `leaders_(zone)`, `managers_()`, `setting_('EMAIL_KVALITA')`, `list_(q.pilots)`…

---

## 10. Editing `Index.html` (screen)

### Look: colours, spacing, widths

Everything is in the variables at the top of `<style>`:

```css
--ink: #151B1F; --ink-2: #374148;            /* text */
--accent: #66B539; --accent-ink: #3f7d1f;    /* green buttons / green text */
--accent-soft: #E8F7DD;                      /* light green backgrounds */
--viz: #4f9a2a;                              /* chart green (darker, readable on white) */
--gutter: clamp(16px, 4vw, 72px);            /* side margins, grow with the screen */
--w-wide: 84rem; --w-mid: 72rem; --w-form: 56rem;  /* max width: tables / detail / form */
--tap: 44px; --tap-s: 36px;                  /* button and field height (kiosk: 52 / 44) */
```

- **Text and greens:** keep `--accent-ink` dark enough for green text on white. Text in `#66B539` is hard to read.
- **Which width a page gets** is set in `render()`: `{ new: 'w-form', admin: 'w-mid', help: 'w-mid', detail: 'w-mid' }`. Other pages use the wide width.
- **Phone layout:** the `@media (max-width: 760px)` block.
- **Tablet layout:** the `@media (max-width: 1180px)` block.
- **Kiosk sizes:** `body.kiosk`.

### Creating screen elements: `h()`

```js
h('button', { class: 'btn primary', onclick: () => go('new') }, '+ Nahlásit problém')
```

- `h(tag, attributes, …children)` builds an element.
- Text is always inserted as text, so anything a user typed can't break the page. **Don't use `innerHTML`.**
- Button styles: `btn`, plus `primary` (green), `small`, `ghost` (no border) or `danger`.

### Form fields: `makeForm()`

```js
const F = makeForm(values);
F.input('descWrong', 'ŠPATNÝ díl – popis', { req: true, rows: 4, hint: 'Co je špatně? Popište fakta.' })
F.select('how', 'JAK byl objeven?', S.lists.how, { req: true, hint: '…' })
F.yesno('safety', 'SAFETY', { req: true })
F.checks('shifts', 'Směny', S.lists.shifts)
F.radio('decision', 'Rozhodnutí', [{ value: 'A', label: '…', sub: '…' }])
F.toggle('active', 'Aktivní')
const data = F.read();   // null (and red fields + message) if something required is missing
```

**Field options:**

| Option | Meaning |
|---|---|
| `req: true` | the field is required |
| `wide: true` | spans both columns |
| `rows: n` | makes a text area |
| `type` | input type: `'number'`, `'date'`, `'datetime-local'`, `'email'` |
| `now: true` | adds a "Teď" button |
| `list: 'people-list'` | name suggestions |
| `ph` | an explicit placeholder |
| `hint` | help text |
| `onchange` | function called when the value changes |

**Where hints appear:**
- In a text field, `hint` becomes the placeholder.
- In any other field, it goes behind the ⓘ icon.

**Show / hide:** `showIf(element, condition)`. Hidden fields are never required and are saved as empty.

### Board columns, statuses, filters

- **Status names and "čeká: …":** `STATUS` in part 1.
- **Board columns:** the `COLUMNS` list in part 4 holds the header and the sort value. `rowEl()` draws the cells, in the same order.
- **Filters and count cards:** `FILTERS`. The cards shown are the `keys` list at the start of `boardPage()`.
- **Steps of the new-QRAP form:** the `steps` list in `newPage()`. Each step has a `name` (tab), an optional `title`, the content `el` and an optional `check`.

---

## 11. Recipes: common changes step by step

Before you start any recipe: **make a copy of the Sheet and test in the copy** (§12).

### A. Add a new field to ① (example: "Číslo zakázky")

1. **Code.gs § 1 `COLS`**, in the `'Problémy'` list next to `supplier`, add:
   `['orderNo', '① Číslo zakázky'],`
2. **Code.gs § 6 `popisFrom_`**, inside `const q = { … }`, add:
   `orderNo: txt_(f.orderNo, 60),`
3. **Index.html part 7 `popisForm`**, next to the `supplier` field, add:
   `F.input('orderNo', 'Číslo zakázky', { hint: 'např. 4500012345' }),`
4. **Index.html part 6 `paperBody`**, in the `numbers` line of ① (under ŠPATNÝ / DOBRÝ díl), add:
   `q.orderNo ? 'zakázka: ' + q.orderNo : '',`
5. *(Optional)* to make it searchable, add `q.orderNo` to `haystack()` in part 4.
6. Run **eQRAP → Nastavit tabulku** (it adds the column), then publish a new version (§12).

### B. Add a value to a dropdown (zone, shift, unit…)

No code needed: **Správa → Seznamy**, add a line, **Uložit**.

### C. Add a whole new dropdown list (example: "Zákazník")

1. **Code.gs `LISTS`:** `['customers', 'Zákazníci', ['Zákazník A', 'Zákazník B']],`
2. Add a column for the value to `COLS` and to `popisFrom_` (as in recipe A). Use `oneOf_` if only listed values are allowed.
3. **Index.html `popisForm`:** `F.select('customer', 'Zákazník', S.lists.customers || []),`
4. Run setup. The list appears in Seznamy and on the Správa page.

### D. Change who may do something

- Edit the one-line rule in **Code.gs § 5**. Example: only managers may assess ⑦:
  ```js
  function canAssess_(me, q) { return me.manager && q.status !== 'ZRUŠENO'; }
  ```
- Then update the table in `helpPage()` in Index.html, so "Jak to funguje" stays true.

### E. Change an e-mail

- **Change the text:** edit the lines in the `mail…_` function (Code.gs § 7).
- **Add Quality to new QRAPs:** in `mailNew_`, add `.concat([setting_('EMAIL_KVALITA')])` to the recipients.

### F. Change colours or sizes

- Edit the variables at the top of `<style>` (§10).
- **For the kiosk only:** edit the `body.kiosk { --tap: 52px; --tap-s: 44px; }` line.

### G. Rename a status, a label or a button

- **Labels and button texts:** search for the text in Index.html and change the string.
- **Status names:** change the `label` in `STATUS`. Don't change the keys (`'OPATŘENÍ'` …), because Code.gs uses them.

### H. Add or reorder a column on the board

1. Add `['key', 'Header', q => sortValue]` to `COLUMNS`.
2. Add a matching `h('td', …)` in `rowEl()` at the same position.
3. For the phone layout, give the cell a class and place it in the `@media (max-width: 760px)` block (the `.list .c-…` rules).

### I. Change the 24 h deadline, the kiosk timeout or the days of closed QRAPs

No code needed: **Správa → Nastavení**.

---

## 12. Testing and publishing a change

### Upgrading a Sheet from an earlier version (before the paper layout)

Run **eQRAP → Nastavit tabulku** once after pasting the new code. It adds the new columns **① CO – jiné**, **① Popis – ŠPATNÝ díl**, **① Popis – DOBRÝ díl** and the list **CO je za problém** in Seznamy. Nothing is deleted:

- Old QRAPs keep their values. Their old free-text "CO" is shown as it was, and old KDE lokace, NOK situace and photo exceptions are still shown on the paper.
- The old Seznamy column "Typy okamžitých opatření" is no longer used (the paper has no type); you may delete that column.
- Existing lists are not changed. If you want the paper's shift "Víkend" or its roles in ② (Údržba, Logistika / nákup…), add them on **Správa → Seznamy**.

### Safe way to change the live app

1. **File → Make a copy** of the Sheet. The copy gets its own Apps Script project.
2. In the copy, set `EMAILY = NE`. Paste your changed code and run **setup**.
3. Open **Deploy → Test deployments** and try the change with **Zobrazit jako** for each role. On the kiosk, also try a signature by name.
4. When it works, paste the same code into the **live** project and run **eQRAP → Nastavit tabulku**.
5. Publish: **Deploy → Manage deployments → ✏ (edit) → Version: New version → Deploy**. The URL stays the same.

> If you only save the code, users still see the old version. You **must** publish a new version (step 5).

### Automatic tests (for developers)

The repository has a local copy of the Google services in `dev-tests/lite/`:

```bash
node dev-tests/lite/lite_server_test.js   # 222 checks of every rule in Code.gs
node dev-tests/lite/lite_e2e.js           # full browser run: report → close, kiosk, phone, Správa
```

- Both must end with **ALL OK**.
- The browser test also saves screenshots to `dev-tests/lite/shots/`.
- An error printed during the browser test ending with "QRAP uzavírá manažer." is expected: the test checks that a leader can't close.

---

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| "Aplikaci se nepodařilo spustit – chybí list / sloupec" | run **eQRAP → Nastavit tabulku**. Check that no header was renamed |
| I changed the code but nothing changed | publish a **new version** (§12, step 5), then reload the page |
| a leader has no "Rozhodnout" button | ③ must be complete first (see "Další krok"). The e-mail in Lidé must match the Google account exactly, and the person must be active |
| kiosk: "Jméno … není v seznamu Lidé" | the person must be active in Lidé. Pick the name from the suggestions |
| nobody can close a QRAP | only MANAŽER / ADMIN can. Give someone the MANAŽER role |
| "Podepsat uzavření" is grey | the checklist under it shows what is missing |
| a pilot can't edit ⑤ | they must be chosen in ④, or added with "+ přidat pilota" |
| saving a person fails with a validation message | use the Správa page, not hand-typed values. Role must be empty or one of VEDOUCÍ / MANAŽER / ADMIN / KIOSK |
| I see admin rights although I set my own role lower | the owner is always ADMIN. Use **Zobrazit jako** to see another role |
| e-mails don't arrive | `EMAILY = ANO`, the address is in Lidé / Nastavení, check spam. Google sends at most about 1,500 e-mails a day |
| "You need permission" | the deployment must be "Anyone within [company]" and the user must be signed in with the company account |
| the first opening takes 2–4 s | normal: Google starts the script. After that, clicks are instant and saves take 1–2 s |
| a script error you don't understand | Apps Script → **Executions** shows every server call with the error and the line number |

---

## 14. Safety and good practice

- **Ownership:** the app runs as its owner. If that account is deleted, the app and the photos stop working. Use a **team account** or a **Shared Drive**, and give a second admin edit access to the Sheet.
- **Users never need access to the Sheet or the photo folder.** Every save is checked on the server.
- **Nothing is deleted from the app:**
  - "Zrušit" keeps the record with a reason.
  - Removed actions stay marked "Odebráno".
  - Historie records everything.
- **Kiosk names are typed, not proven.** They are checked against Lidé and the role, and the cameras cover the rest. Give the kiosk account only the role KIOSK.
- **Personal data:** the app stores names and company e-mails only. Don't write health details of injuries into it.
- **Before replacing the paper QRAP,** run the app in parallel for 2–4 weeks and let Quality approve it.
- **Before editing code,** always test in a copy, keep `EMAILY = NE` while testing, and publish a new version only when it works.
