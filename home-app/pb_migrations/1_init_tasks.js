/// <reference path="../pb_data/types.d.ts" />
// Creates the lists and tasks collections. Every record belongs to one user
// and is only visible to that user.

const COLORS = ["BLUE", "GREEN", "RED", "ORANGE", "YELLOW", "MAUVE", "CYAN", "PALE_BLUE", "PALE_GREEN", "PALE_RED", "GRAY"];
const OWNER_ONLY = "owner = @request.auth.id";
const CREATE_OWN = "@request.auth.id != '' && @request.body.owner = @request.auth.id";
const UPDATE_OWN = "owner = @request.auth.id && (@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new TextField({ name: "calToken", hidden: true, max: 64 }));
  users.authToken.duration = 90 * 24 * 60 * 60; // stay signed in on the phone for 90 days (refreshed on every open)
  app.save(users);

  const owner = { name: "owner", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true };
  const stamps = [
    { name: "created", type: "autodate", onCreate: true },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  app.save(new Collection({
    type: "base",
    name: "lists",
    listRule: OWNER_ONLY, viewRule: OWNER_ONLY, createRule: CREATE_OWN, updateRule: UPDATE_OWN, deleteRule: OWNER_ONLY,
    fields: [
      owner,
      { name: "name", type: "text", required: true, max: 60 },
      { name: "color", type: "select", values: COLORS, maxSelect: 1 },
      { name: "sort", type: "number" },
      ...stamps,
    ],
    indexes: ["CREATE INDEX idx_lists_owner ON lists (owner)"],
  }));

  app.save(new Collection({
    type: "base",
    name: "tasks",
    listRule: OWNER_ONLY, viewRule: OWNER_ONLY, createRule: CREATE_OWN, updateRule: UPDATE_OWN, deleteRule: OWNER_ONLY,
    fields: [
      owner,
      { name: "title", type: "text", required: true, max: 500 },
      { name: "desc", type: "text", max: 5000 },
      { name: "due", type: "text", max: 10, pattern: "^(\\d{4}-\\d{2}-\\d{2})?$" },
      { name: "time", type: "text", max: 5, pattern: "^(([01]\\d|2[0-3]):[0-5]\\d)?$" },
      { name: "status", type: "select", values: ["Not started", "In progress", "Blocked", "Done"], maxSelect: 1 },
      { name: "priority", type: "select", values: ["High", "Medium", "Low"], maxSelect: 1 },
      { name: "list", type: "text", required: true, max: 60 },
      { name: "starred", type: "bool" },
      { name: "parent", type: "text", max: 15 },
      { name: "position", type: "number" },
      { name: "repeat", type: "select", values: ["daily", "weekdays", "weekly", "monthly", "yearly"], maxSelect: 1 },
      { name: "completed", type: "text", max: 40 },
      { name: "archType", type: "select", values: ["Completed", "Deleted"], maxSelect: 1 },
      { name: "createdAt", type: "text", max: 40 },
      ...stamps,
    ],
    indexes: ["CREATE INDEX idx_tasks_owner ON tasks (owner)"],
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("tasks"));
  app.delete(app.findCollectionByNameOrId("lists"));
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("calToken");
  app.save(users);
});
