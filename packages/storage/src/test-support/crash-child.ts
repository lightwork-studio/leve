// Runs one storage operation in its own process and kills that process with SIGKILL at a chosen
// point, like a crash or a phone killing the app. Started by `runCrashChild` in fixtures.ts.
//
// Usage: node crash-child.ts <db path> <mode> <checkpoint> <count>
//   mode = a name from `definitions`: open the storage with it, crash at <checkpoint> #<count>
//   mode = committed-wal: switch to WAL, commit newer metadata into the WAL, crash before checkpoint
//   mode = interrupted-write: rewrite record content in one big transaction, crash after <count> rows
//   mode = server-interrupted-write: the same on a server account database
//   mode = server-committed-wal: switch a server account database to WAL, commit a change into the
//          WAL only, then crash
//   mode = server-restore: <db path> is a server directory; restore account "alice" from its
//          backup.db and crash at <checkpoint> #<count>
import { join } from "node:path";
import { ServerStorage } from "../server-store.ts";
import { openStorage } from "../upgrade.ts";
import { definitions, engine, NEW_APP, RESTORE_TIME, RESTORED_LINEAGE } from "./fixtures.ts";

const [path, mode, point, countText] = process.argv.slice(2);
const count = Number(countText);
if (!path || !mode || !point || !Number.isInteger(count)) {
  console.error("usage: crash-child.ts <db path> <mode> <checkpoint> <count>");
  process.exit(2);
}

function crash(): never {
  process.kill(process.pid, "SIGKILL");
  // SIGKILL cannot be handled; make sure nothing else runs before it lands.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}

if (mode === "committed-wal") {
  const db = engine.open(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.run("UPDATE storage_meta SET storage_version = 7, app_version = '7.0.0' WHERE id = 1");
  // The commit is in the WAL only; a normal close would checkpoint it into the database file.
  crash();
}

if (mode === "interrupted-write") {
  const db = engine.open(path);
  db.exec("BEGIN IMMEDIATE");
  let writes = 0;
  for (const row of db.all("SELECT kind, id FROM records ORDER BY kind, id")) {
    db.run(
      "UPDATE records SET server_content = NULL, server_state = NULL, server_revision = NULL WHERE kind = ? AND id = ?",
      [row.kind ?? null, row.id ?? null],
    );
    if (++writes === count) crash();
  }
  console.log("completed without crashing");
  process.exit(0);
}

if (mode === "server-interrupted-write") {
  const db = engine.open(path);
  db.exec("BEGIN IMMEDIATE");
  let writes = 0;
  for (const row of db.all("SELECT kind, id FROM records WHERE state = 'live' ORDER BY kind, id")) {
    db.run("UPDATE records SET content = '{}' WHERE kind = ? AND id = ?", [
      row.kind ?? null,
      row.id ?? null,
    ]);
    if (++writes === count) crash();
  }
  console.log("completed without crashing");
  process.exit(0);
}

if (mode === "server-committed-wal") {
  const db = engine.open(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.run(
    'UPDATE records SET content = \'{"takenAt":"2026-11-10T08:30:00.000Z","bodyweightKg":79.9,"fatPercent":null}\' WHERE kind = \'body_measurement\' AND id = \'bm-later\'',
  );
  crash();
}

if (mode === "server-restore") {
  const storage = new ServerStorage({
    engine,
    directory: path,
    appVersion: "server-0.1.0",
    onCheckpoint(reached, n) {
      if (reached === point && n === count) crash();
    },
  });
  await storage.restoreAccount("alice", join(path, "backup.db"), {
    randomId: () => RESTORED_LINEAGE,
    now: () => new Date(RESTORE_TIME),
  });
  await storage.close();
  console.log("completed without crashing");
  process.exit(0);
}

const definition = definitions[mode];
if (!definition) {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
try {
  const opened = await openStorage({
    engine,
    path,
    definition,
    appVersion: NEW_APP,
    onCheckpoint(reached, n) {
      if (reached === point && n === count) crash();
    },
  });
  opened.db.close();
  console.log("completed without crashing");
} catch (error) {
  console.log(`failed without crashing: ${(error as Error).name}: ${(error as Error).message}`);
}
