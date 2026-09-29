# eQRAP Logistika – setup guide

Everything is done in the browser: Google Sheets, the Apps Script editor and Google Drive.
You copy and paste the files from `apps-script/`. No clasp, npm or build step.

Time needed: about 45 minutes the first time.

---

## 1. Create the Google Sheet and open Apps Script

1. Open <https://sheets.new> (signed in with your company Google account).
2. Rename the file, e.g. **eQRAP Logistika – DB**.
3. Menu **Extensions → Apps Script**. A new tab opens with the script editor.
4. Click the project name ("Untitled project") and rename it to **eQRAP Logistika**.

The script is now *bound* to this Sheet. The Sheet is the database.

---

## 2. Paste the files

The editor shows a file list on the left. There is already one file, `Code.gs`.

**Script files (`.gs`)**

1. Click the **+** next to *Files* → **Script**.
2. Type the name **without** the extension, e.g. `Config` (the editor adds `.gs` itself).
3. Delete the example code in the new file and paste the whole content of `apps-script/Config.gs`.
4. Press **Ctrl + S** (or ⌘ + S) to save.

Rename the existing `Code.gs` to `Main` (three dots next to the file → *Rename*) and paste
`Main.gs` into it.

**HTML files (`.html`)**

1. Click **+** → **HTML**.
2. Type the name without `.html`, e.g. `Index`.
3. Replace the example content with the file content and save.

Paste all files (the order does not matter, but this order is easy to follow):

| # | Type | Name to type | Paste from |
|---|---|---|---|
| 1 | Script | `Main` (rename Code) | `apps-script/Main.gs` |
| 2 | Script | `Config` | `apps-script/Config.gs` |
| 3 | Script | `Util` | `apps-script/Util.gs` |
| 4 | Script | `Db` | `apps-script/Db.gs` |
| 5 | Script | `Audit` | `apps-script/Audit.gs` |
| 6 | Script | `Auth` | `apps-script/Auth.gs` |
| 7 | Script | `Qrap` | `apps-script/Qrap.gs` |
| 8 | Script | `Wizard` | `apps-script/Wizard.gs` |
| 9 | Script | `Board` | `apps-script/Board.gs` |
| 10 | Script | `Decision` | `apps-script/Decision.gs` |
| 11 | Script | `Escalation` | `apps-script/Escalation.gs` |
| 12 | Script | `Analysis` | `apps-script/Analysis.gs` |
| 13 | Script | `Actions` | `apps-script/Actions.gs` |
| 14 | Script | `Effectiveness` | `apps-script/Effectiveness.gs` |
| 15 | Script | `Assessment` | `apps-script/Assessment.gs` |
| 16 | Script | `Photos` | `apps-script/Photos.gs` |
| 17 | Script | `Mail` | `apps-script/Mail.gs` |
| 18 | Script | `Triggers` | `apps-script/Triggers.gs` |
| 19 | Script | `Manager` | `apps-script/Manager.gs` |
| 20 | Script | `Admin` | `apps-script/Admin.gs` |
| 21 | Script | `Setup` | `apps-script/Setup.gs` |
| 22 | Script | `SeedDemo` | `apps-script/SeedDemo.gs` |
| 23 | HTML | `Index` | `apps-script/Index.html` |
| 24 | HTML | `Styles` | `apps-script/Styles.html` |
| 25 | HTML | `I18n` | `apps-script/I18n.html` |
| 26 | HTML | `ClientCore` | `apps-script/ClientCore.html` |
| 27 | HTML | `ClientForms` | `apps-script/ClientForms.html` |
| 28 | HTML | `ViewBoard` | `apps-script/ViewBoard.html` |
| 29 | HTML | `ViewWizard` | `apps-script/ViewWizard.html` |
| 30 | HTML | `ViewWizardSteps` | `apps-script/ViewWizardSteps.html` |
| 31 | HTML | `ViewQrap` | `apps-script/ViewQrap.html` |
| 32 | HTML | `ViewDecide` | `apps-script/ViewDecide.html` |
| 33 | HTML | `ViewAnalysis` | `apps-script/ViewAnalysis.html` |
| 34 | HTML | `ViewActions` | `apps-script/ViewActions.html` |
| 35 | HTML | `ViewEffect` | `apps-script/ViewEffect.html` |
| 36 | HTML | `ViewAssess` | `apps-script/ViewAssess.html` |
| 37 | HTML | `ViewManager` | `apps-script/ViewManager.html` |
| 38 | HTML | `ViewEscalation` | `apps-script/ViewEscalation.html` |

> **Names matter.** `Index.html` includes the others by name (`include('Styles')` …).
> A typo (e.g. `viewBoard`, or `Styles.html.html`) gives the error *"No HTML file named …"*.

---

## 3. Paste the manifest (`appsscript.json`)

1. Click the **gear icon** (Project Settings) on the left.
2. Tick **Show "appsscript.json" manifest file in editor**.
3. Go back to the editor (`< >` icon). A file `appsscript.json` is now visible.
4. Replace its content with `apps-script/appsscript.json` and save.

It sets the time zone **Europe/Prague**, the V8 runtime and the web app settings
(execute as the owner, access for the whole domain).

---

## 4. Run `setup()` and authorize

1. Open the file **Setup**.
2. In the toolbar, choose the function **setup** in the drop-down next to *Debug*.
3. Click **Run**.
4. The first run asks for permissions: **Review permissions** → choose your account →
   if you see *"Google hasn't verified this app"*, click **Advanced → Go to eQRAP Logistika (unsafe)** →
   **Allow**. (It is your own script, so this warning is expected.)
5. The *Execution log* shows `setup() done`.

Go back to the Sheet: it now has tabs `SET_CONFIG`, `SET_AREAS`, … `QRAP`, `AUDIT_LOG`, … with
headers and example settings. Running `setup()` again is safe: it only adds what is missing.

---

## 5. Create the photo folder

1. Open Google Drive and create a folder, e.g. **eQRAP fotky**.
2. Open the folder. The URL looks like `https://drive.google.com/drive/folders/1AbCdEf…`.
   The part after `/folders/` is the **folder ID**.
3. In the Sheet, tab **SET_CONFIG**, put the ID into the value of `PHOTO_FOLDER_ID`.

Only you (the owner) need access to the folder. Users see photos through the app.

---

## 6. Fill the settings tabs

All settings are edited directly in the Sheet. Changes are picked up within seconds
(the simple `onEdit` trigger clears the settings cache). If something looks stale, run
`clearCaches()` from the editor.

| Tab | What to enter |
|---|---|
| `SET_CONFIG` | `APP_URL` (step 7), `PHOTO_FOLDER_ID` (step 5), `DIGEST_TIME` 06:30, `IDLE_MINUTES` 3, `OVERDUE_N1_DAYS` 3, `ARCHIVE_AFTER_DAYS` 90, `BOARD_CLOSED_DAYS` 7, `ASSESSMENT_OPEN_TO_ALL` TRUE, `SENDER_NAME` |
| `SET_AREAS` | `area_code` (2–6 characters, starts the QRAP number), `name`, `level` (AREA / APU / PLANT), `parent_code` (the APU of a line area), `active` |
| `SET_LOCATIONS` | area, zone (Příjem, Sklad, Vychystávání, Balení, Expedice / Rampa), location code |
| `SET_SHIFTS` | `R`, `O`, `N` (and `V`), start / end `HH:MM`, `days` as digits: `12345` = Mon–Fri, `67` = weekend |
| `SET_PEOPLE` | name, e-mail (may be empty for operators), badge, roles (comma list), areas (comma list or `*`), `n1_email` (the boss, for overdue reminders) |
| `SET_ROUTING` | who gets the e-mails: area + shift (`*` = any shift) + role key (SUPERVISOR, MANAGER, QUALITY, EHS, TL, APU_MANAGER) + e-mail |
| `SET_LISTS` | the pick lists; `code` is stored in the data, `value_cz` / `value_en` are shown |

Roles: `KIOSK`, `OPERATOR`, `TL`, `SUPERVISOR`, `PILOT`, `QUALITY`, `EHS`, `MANAGER`,
`APU_MANAGER`, `ADMIN`.

### For testing: use your own e-mail

1. **SET_ROUTING:** put **your own e-mail** in every row of the `email` column
   (select the column → *Edit → Find and replace* → Find `.*@example\.com`, tick
   *Search using regular expressions*, Replace with your e-mail → *Replace all*).
   Then every e-mail of the app arrives in your mailbox.
2. **SET_PEOPLE:** add a row for yourself, e.g.
   `Me | me@yourcompany.cz | | SUPERVISOR,PILOT,MANAGER,ADMIN,TL | * | | TRUE`.
3. To try the **kiosk**, change your roles to `KIOSK` and your areas to `WH1`, reload the page,
   and change them back later. (The kiosk account can never sign, even if it has other roles.)
   A second test account in your domain is even better.

---

## 7. Deploy as a web app

1. In the editor: **Deploy → New deployment**.
2. Click the gear next to *Select type* → **Web app**.
3. Description: `v1`.
4. **Execute as: Me** (your account).
5. **Who has access: Anyone within *your domain***.
   (With a private @gmail.com account this option does not exist; choose *Only myself* for testing.)
6. Click **Deploy** and allow the permissions again if asked.
7. Copy the **Web app URL** (ends with `/exec`).
8. Paste it into `SET_CONFIG` → `APP_URL`. E-mail buttons and QR codes use this URL.

Open the URL: you should see the app. `?page=board&area=WH1` opens the board of WH1.

---

## 8. Install the triggers

1. In the editor open the file **Triggers**, choose the function `installTriggers`, click **Run**.
2. Check the clock icon (**Triggers**) on the left: three triggers exist:
   `checkReminders` (every hour), `dailyDigest` (every day at `DIGEST_TIME`),
   `archiveOld` (Sunday 23:00).
3. Run `installTriggers()` again whenever you change `DIGEST_TIME`. `removeTriggers()` deletes them.

Then run **`selfTest()`** (file *Setup*). The log lists every check with ✓ or ✗
(tabs, config keys, photo folder, time zones, routing for every area × shift × role, triggers).

Optional: run **`seedDemoData()`** (file *SeedDemo*) to create 9 demo QRAPs in all states.
It runs once; to run it again, delete the script property `DEMO_SEEDED`
(Project Settings → Script properties).

---

## 9. Set up the kiosk tablet

1. Sign the tablet's browser in with the **kiosk account of the area** (e.g. `kiosk.wh1@yourcompany.cz`,
   listed in `SET_PEOPLE` with role `KIOSK` and area `WH1`). It must be a domain account, otherwise the
   app shows *"Neznámý uživatel"*.
2. Open `APP_URL?page=board&area=WH1`.
3. Full screen: Chrome menu → *Add to Home screen* (Android) or press F11 (Windows).
   Chrome kiosk mode (`chrome --kiosk <url>`) also works.
4. Allow the camera when the browser asks (the photo buttons open the rear camera).

Supervisors open the same URL on their phone (signed in with their own account), or scan the
QR code on the QRAP detail page.

---

## 10. After every code change: new version

The `/exec` URL runs the **last deployed version**, not your latest saved code.

- After pasting a change: **Deploy → Manage deployments → pencil icon (Edit) → Version: New version → Deploy**.
  The URL stays the same.
- While developing, use **Deploy → Test deployments** → the `/dev` URL. It always runs the latest
  saved code (only for people who can edit the script).

If the app "does not change" after you pasted code, you forgot this step.
