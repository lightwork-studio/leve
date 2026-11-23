// The DOM test bundler cannot resolve node:sqlite on Node 22. Use the runner's real SQLite.
export const { backup, DatabaseSync } = process.getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");
