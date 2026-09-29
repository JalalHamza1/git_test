# dev-tests (optional)

You do **not** need this folder to run the app. It is a small local test that runs the server code of
`apps-script/*.gs` in Node.js against simple fakes of the Google services (Sheets, Drive, Mail, Cache,
Lock, Properties, Session). It checks about 100 rules end to end: setup, demo data, the wizard steps,
every guard of the decision, escalation, 5 Why, actions, effectiveness rounds, closure, admin tools,
the e-mails E1–E11 (sent once), triggers, and that no `Date` object is ever returned to the browser.

Run it (Node 18 or newer, no npm packages needed):

```
node dev-tests/test-server.js
```

The last line says `ALL OK` or lists what failed. The fakes are much simpler than the real services,
so a green run does not replace the manual checks in `TESTING.md`.
