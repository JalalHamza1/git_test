# Tasks: project tracker

A Google Apps Script app backed by a Google Sheet. Plain lists (like General) stay simple checklists.
Projects add a goal, milestones, progress, notes, status updates, and blocking with a reason.

## Files

| File | What it is | In the Apps Script editor |
|---|---|---|
| `Code.gs` | Server: tasks, lists, calendar, digest | Replace your existing `Code.gs` |
| `Projects.gs` | Server: projects, milestones, notes, updates, blocking | New **Script** file named `Projects` |
| `index.html` | Page shell | Replace your existing `index` |
| `styles.html` | Styles | New **HTML** file named `styles` |
| `app.html` | App logic | New **HTML** file named `app` |
| `optional/quill.html` | Offline copy of the note editor ([Quill](https://quilljs.com) 2.0.3, BSD licence) | **Only if notes show "The note editor couldn't load":** new **HTML** file named `quill` |

`test/` and `tools/` are for development only. Don't paste them into Apps Script.

The note editor normally loads from `cdn.jsdelivr.net` in the background, so the app never waits for it, and the
browser checks the file against a pinned checksum before running it. If your company network blocks that site,
notes open read-only with a warning. Adding `optional/quill.html` (the exact same file) as an HTML file named `quill`
makes the app use that copy instead, with no outside download.

## Install (try it on a copy first)

1. **Make a copy of your spreadsheet**: *File → Make a copy*. The copy gets its own copy of the script.
2. In the copy, open *Extensions → Apps Script*.
3. Replace `Code.gs` and `index` with the new versions.
4. Add `Projects` (*+ → Script*), then `styles` and `app` (*+ → HTML*). Use exactly those names, without extensions; the editor adds them.
5. Save, reload the spreadsheet, then open *Task Manager → Open full screen*.
6. If you also use it as a web app: *Deploy → Manage deployments → Edit → Version: New version → Deploy*.

### What happens the first time it runs

- The **Tasks** sheet gets ten new columns after column Q (R–AA): Milestone, Plan Date, Size, Blocked By,
  Block Reason, Blocked Since, Waiting On, Waiting Since, Block Log, Updated. Existing columns and rows are not touched.
  If you keep your own columns in R–AA, the app stops and tells you to move them first.
- Four new sheets appear: **Projects**, **Milestones**, **Notes**, **Updates**. (If you installed an earlier
  version of this update, the Notes sheet gets three more columns, **Body2–Body4**, used by long notes.)
- Every list whose name starts with `Project - ` (or `Project:`) becomes a project with the prefix removed:
  "Project - QRQC" becomes the project "QRQC". Its tasks move with it. The start date is set from its oldest task.
  Add a goal and target date afterwards with **Edit** on the project page.

Nothing is deleted. To go back, use the original spreadsheet (or paste the old files back in).

## How it works

**Lists vs. projects.** Lists are checklists for ongoing things. Projects have an end:
a "Done when" goal, a target date, a status (Active, Blocked, Planned, Paused, Done) and milestones.
Turn a list into a project from its **⋮** menu.

**Inside a project:** three tabs.
- **Overview:** goal, progress, target and forecast, next action, milestones, status updates, and (when there's something to show) attention items and pinned notes.
- **Tasks:** grouped by milestone, each group with its own quick-add. A milestone is marked reached automatically when its last task is done.
- **Notes:** meeting, decision and reference notes with formatting (see **Notes** below).

**Notes.** The editor works like a simple Word or Google Docs:
- **Toolbar:** bold, italic, underline, strikethrough, highlight; headings H1–H3; bullets, numbered lists and checkboxes;
  indent and outdent; quote, divider line, link, clear formatting.
- **Tab / Shift+Tab** indent or outdent a list item wherever the cursor is. Bullets change style per level (• ◦ ▪),
  numbers go 1 → a → i. Enter on an empty nested item steps out one level.
- **Type to format:** `- ` or `* ` starts bullets, `1. ` numbers, `[ ] ` a checkbox, `# ` / `## ` / `### ` a heading,
  `> ` a quote, and `---` then Enter draws a divider.
- **Checkboxes and tasks:** hover a checkbox and click **Make task**, or put the cursor on any line(s) and click **Task** in the
  toolbar (Ctrl+Shift+Enter). The task goes into the project's current milestone and the line gets a small TASK tag.
  Ticking the checkbox completes the task, and completing the task anywhere ticks the checkbox, even in notes that aren't open.
  The task's details panel links back to its note.
- **Links:** select text and press Ctrl+K (or the link button). Click a link to see where it goes, edit or remove it.
- **Paste** from Word, Gmail or web pages keeps bold, italics, lists and links, and drops fonts, colours and sizes.
- **Size:** drag the bottom-right corner of the editor to make it narrower/wider and taller; double-click the corner to reset.
  Drag the line between the note list and the editor to resize the list, hide the list with the first toolbar button,
  or press **Ctrl+.** for focus mode (just the note; Esc to leave). Sizes are remembered on this computer.
- **Older notes** (plain text from the first version) open formatted: `[ ]` lines become checkboxes, `- ` lines bullets,
  and existing task links are kept. They're saved in the new format the first time you change them.
- **How long can a note be?** Roughly 30 pages if it's all bullet points, up to about 55 pages of plain paragraphs. A note is stored in up to four cells of the Notes sheet
  (Body, Body2–Body4); formatting takes some of that space. The editor warns at 80%, and a note over the limit
  isn't saved (nothing is cut off) until you shorten it or split it into two.

**Blocking.** Choosing **Blocked…** on a task (or a project's status menu) asks:
1. *Why is it blocked?* This is required.
2. *What will unblock it?* Any mix of:
   - **Something I need to do first.** Each line becomes a new task placed before it.
   - **Another task** that has to finish first.
   - **Waiting on a person or team.** The app counts the days and flags it after 5. Use **It arrived** or **I followed up**.

When every unblocking task is done (or deleted) and nothing is still awaited, the task or project unblocks by itself and you see a message.
The reason moves into **Block history**. **Unblock now** clears a block by hand.
A block can be saved without a plan, but it shows "No unblock plan" until you add one.

**Progress and health.** Progress is done points ÷ total points, where task sizes are S = 1, M = 2, L = 3.
The app shows **signals**: overdue work, milestones past their date, a forecast past the target, nothing moving for 10+ days,
long waits, blocked with no plan, no next action, and no update for a week. From these it suggests a health.
You set the actual health when you post a status update, on the project or in **Weekly review**.

**Plan date vs. due date.** Plan date is when you intend to work on a task; it puts the task in **My Day**.
Due date is a real deadline; it drives overdue warnings and signals.

**Calendar.** Tasks in lists sync as before. Inside projects, only tasks with a **time** get events. Milestones
appear as all-day events (`◆ [Project] Milestone`). Existing events for date-only project tasks are removed the next time
those tasks change or you run *Sync to Calendar*.

**Digest email.** Adds "Projects needing attention" and a reminder on your weekly review day (Settings).

### Quick-add

`Call Sam tomorrow 3pm !high #Excel ^Sheets ~L *`

- `tomorrow`, `fri`, `oct 5`, `in 2 weeks`, `every monday`: due date and repeat
- `!high` / `!low`: priority
- `#Name`: list or project
- `^Name`: milestone (prefix is enough)
- `~S` / `~M` / `~L`: size
- `*`: star

### Keyboard

`/` search · `c` create · `n` quick-add · `j`/`k` move · `Enter` open · `x` complete · `s` star · `b` block ·
`Del` trash · `Alt+↑/↓` reorder · `1–6` Home, My Day, Upcoming, Starred, Review, Trash · `Esc` close

In notes: `Ctrl+B / I / U` · `Ctrl+Z / Y` undo, redo · `Ctrl+K` link · `Ctrl+Shift+7 / 8 / 9` numbers, bullets, checkbox ·
`Ctrl+Alt+1 / 2 / 3` headings (`Ctrl+Alt+0` normal text) · `Tab / Shift+Tab` indent · `Ctrl+Shift+Enter` line → task · `Ctrl+.` focus mode

## What changed from the old version

- The board of list cards is replaced by **Home** (attention list and project table) plus one page per list or project.
- **Insights** is folded into Home (done in the last 7 days) and each project's progress card.
- Drag-and-drop reordering is replaced by **Move up / Move down** in the task panel and `Alt+↑/↓`.
- Calendar: see above.

## Checklist for the copied sheet

- [ ] It opens without errors. Your "Project - " lists now appear under **Projects**, and General is still under **Lists**.
- [ ] The **Projects / Milestones / Notes / Updates** sheets exist, and the Tasks sheet has the new columns R–AA.
- [ ] Add a goal, target date and 2–3 milestones to one project, and move a few tasks into milestones.
- [ ] Block a task with a reason and a "do first" task. Complete that task and check it unblocks.
- [ ] Block a project while waiting on a person, then use **It arrived**.
- [ ] Post a status update, and run through **Weekly review** once.
- [ ] *Sync to Calendar*: milestones appear, and date-only project tasks disappear from the calendar.
- [ ] *Email me today's digest*: the email includes the project section.
- [ ] Open a project's **Notes**: the toolbar shows (if you see "The note editor couldn't load", add `optional/quill.html`).
  Type a few bullets, press Tab on one, add a checkbox, turn it into a task, then tick it and check the task is completed.

## Development

```bash
node test/server.test.js
```

```bash
node tools/build-preview.js && node test/ui.test.js
```

`server.test.js` runs the `.gs` files in Node against fake Apps Script services. `build-preview.js` inlines
the HTML files into `dist/preview.html` (editor from the CDN, like Apps Script) and `dist/preview-local.html`
(offline editor copy). Both open in a browser with sample data. `ui.test.js` drives them in Chromium (it needs Playwright).
