import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import {
  buildDeviceFixture,
  openWith,
  removeTempDirs,
  runCrashChild,
  tempDir,
} from "../../../packages/storage/src/test-support/fixtures.ts";
import { deviceV1 } from "../../../packages/storage/src/test-support/versions.ts";
import { openEngine } from "../src/data/engine.ts";

const phone = vi.hoisted(() => ({ root: "", cache: "", evictWal: false }));
vi.mock("expo-sqlite", () => ({
  get defaultDatabaseDirectory() {
    return phone.root;
  },
  openDatabaseSync(name: string, _options: unknown, uri?: string) {
    const parent = uri ? fileURLToPath(uri) : phone.root;
    if (phone.evictWal && parent.startsWith(phone.cache + "/")) {
      rmSync(join(parent, name + "-wal"), { force: true });
    }
    const db = new DatabaseSync(join(parent, name));
    return {
      execSync: (sql: string) => db.exec(sql),
      runSync: (sql: string, args: string[]) => db.prepare(sql).run(...args),
      getFirstSync: (sql: string, args: string[]) => db.prepare(sql).get(...args),
      getAllSync: (sql: string, args: string[]) => db.prepare(sql).all(...args),
      closeSync: () => db.close(),
    };
  },
}));
vi.mock("expo-file-system", () => {
  class Entry {
    readonly path: string;
    constructor(parent: Entry | string, name?: string) {
      const base = typeof parent === "string" ? fileURLToPath(parent) : parent.path;
      this.path = name ? join(base, name) : base;
    }
    get uri() {
      return pathToFileURL(this.path).href;
    }
    get exists() {
      return existsSync(this.path);
    }
  }
  class File extends Entry {
    delete() {
      rmSync(this.path);
    }
    copySync(target: File) {
      copyFileSync(this.path, target.path);
    }
  }
  class Directory extends Entry {
    create() {
      mkdirSync(this.path, { recursive: true });
    }
    list() {
      return readdirSync(this.path, { withFileTypes: true }).map((e) =>
        e.isDirectory()
          ? new Directory(this, e.name)
          : Object.assign(new File(this, e.name), { name: e.name }),
      );
    }
    delete() {
      rmSync(this.path, { recursive: true });
    }
  }
  return {
    File,
    Directory,
    Paths: {
      get cache() {
        return new Directory(pathToFileURL(phone.cache).href);
      },
    },
  };
});
afterAll(removeTempDirs);

it("refuses newer WAL metadata during cache eviction and reclaims only its own abandoned inspection files", async () => {
  phone.root = tempDir();
  phone.cache = tempDir();
  const scratch = join(phone.root, "leve-preview-protocol-1-sqlite-inspection");
  mkdirSync(scratch);
  writeFileSync(join(scratch, "interrupted-copy.db"), "discarded staging copy");
  writeFileSync(join(phone.cache, "other"), "unrelated");
  const source = join(phone.root, "leve-preview-protocol-1__device.db");
  await buildDeviceFixture(source);
  const crash = await runCrashChild({ path: source, mode: "committed-wal" });
  expect(crash.signal, crash.output).toBe("SIGKILL");
  const hashes = () =>
    readdirSync(phone.root)
      .filter((name) => name.startsWith("leve-preview-protocol-1__"))
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(phone.root, name)))
          .digest("hex"),
      ]);
  const before = hashes();
  phone.evictWal = true;
  const opened = await openEngine();
  await expect(
    openWith("/leve-preview-protocol-1/device.db", deviceV1, "older", opened.engine),
  ).rejects.toMatchObject({ found: { storageVersion: 7, unsyncedWork: true } });
  expect(hashes()).toEqual(before);
  expect(existsSync(scratch)).toBe(false);
  mkdirSync(scratch);
  opened.paths();
  expect(existsSync(scratch)).toBe(false);
  expect(readFileSync(join(phone.cache, "other"), "utf8")).toBe("unrelated");
});

it("resets only the current database and keeps the previous preview readable", async () => {
  phone.root = tempDir();
  const legacyPath = join(phone.root, "leve__device.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE sessions AS SELECT 'Previous workout' AS title");
  legacy.close();
  writeFileSync(join(phone.root, "leve__device.db.pre-v3"), "previous recovery copy");

  const opened = await openEngine();
  const current = "/leve-preview-protocol-1/device.db";
  const db = opened.engine.open(current);
  db.exec("CREATE TABLE sessions AS SELECT 'Fresh workout' AS title");
  db.close();

  expect(opened.paths()).toEqual([current]);
  for (const path of opened.paths()) opened.engine.remove(path);
  expect(opened.engine.exists(current)).toBe(false);
  const reopened = new DatabaseSync(legacyPath, { readOnly: true });
  try {
    expect(reopened.prepare("SELECT title FROM sessions").get()).toEqual({
      title: "Previous workout",
    });
  } finally {
    reopened.close();
  }
  expect(readFileSync(join(phone.root, "leve__device.db.pre-v3"), "utf8")).toBe(
    "previous recovery copy",
  );
});
