/// <reference path="../pb_data/types.d.ts" />
// The secret key in the Claude connector's address (hidden from the API).

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new TextField({ name: "mcpKey", hidden: true, max: 64 }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("mcpKey");
  app.save(users);
});
