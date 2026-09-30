# Tests for eQRAP Lite (not needed in Apps Script)

These files only run on a developer computer. You never paste them into Apps Script.

```
TZ=Europe/Prague node lite_server_test.js   # 108 checks of Code.gs against a fake Google Sheet
TZ=Europe/Prague node lite_e2e.js           # opens Index.html in Chromium (needs Playwright) and clicks through the whole flow
```

- `lite_gas.js` is a small imitation of Google's services (SpreadsheetApp, MailApp, DriveApp, …).
- The browser test saves screenshots to `shots/`. That folder is ignored by git.
