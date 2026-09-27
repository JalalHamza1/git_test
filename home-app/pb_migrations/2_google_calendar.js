/// <reference path="../pb_data/types.d.ts" />
// Google Calendar connection: stored on the user (secrets hidden from the API),
// plus a private map of which Google event mirrors which task.

const GOOGLE_FIELDS = [
  "gClientId", "gClientSecret", "gRefresh", "gAccess", "gCalendarId", "gTimeZone", "gState", "gRedirect", "gError",
];

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  GOOGLE_FIELDS.forEach((name) => users.fields.add(new TextField({ name, hidden: true, max: 2000 })));
  users.fields.add(new NumberField({ name: "gAccessExp", hidden: true }));
  app.save(users);

  // No API rules: only the server's own hooks read or write this.
  app.save(new Collection({
    type: "base",
    name: "gcal_map",
    fields: [
      { name: "task", type: "text", required: true, max: 15 },
      { name: "owner", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { name: "hash", type: "text", max: 64 },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_gcal_map_task ON gcal_map (task)"],
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("gcal_map"));
  const users = app.findCollectionByNameOrId("users");
  GOOGLE_FIELDS.concat("gAccessExp").forEach((name) => users.fields.removeByName(name));
  app.save(users);
});
