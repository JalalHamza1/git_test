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

`test/` and `tools/` are for development only. Don't paste them into Apps Script.

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
- Four new sheets appear: **Projects**, **Milestones**, **Notes**, **Updates**.
- Every list whose name starts with `Project - ` (or `Project:`) becomes a project with the prefix removed:
  "Project - QRQC" becomes the project "QRQC". Its tasks move with it. The start date is set from its oldest task.
  Add a goal and target date afterwards with **Edit** on the project page.

Nothing is deleted. To go back, use the original spreadsheet (or paste the old files back in).

## How it works

**Lists vs. projects.** Lists are checklists for ongoing things. Projects have an end:
a "Done when" goal, a target date, a status (Active, Blocked, Planned, Paused, Done) and milestones.
Turn a list into a project from its **⋮** menu.

**Inside a project:** three tabs.
- **Overview:** goal, milestones with progress, burn-up chart and forecast, signals, next action, status updates, pinned notes and decisions.
- **Tasks:** grouped by milestone, each group with its own quick-add. A milestone is marked reached automatically when its last task is done.
- **Notes:** meeting, decision and reference notes. A line starting with `[ ]` becomes an action item, and **Make task** turns it into a task.

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

## Development

```bash
node test/server.test.js
```

```bash
node tools/build-preview.js && node test/ui.test.js
```

`server.test.js` runs the `.gs` files in Node against fake Apps Script services. `build-preview.js` inlines
the HTML files into `dist/preview.html`, which opens in a browser with sample data. `ui.test.js` drives
that page in Chromium (it needs Playwright).
