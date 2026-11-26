import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LOCK_FILE, lockDataDirectory } from "../src/lock.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "leve-lock-"));
  dirs.push(dir);
  return dir;
};

describe("one server per data directory", () => {
  it("refuses a second server while the first runs", () => {
    const dir = temp();
    // A running process other than this one holds it: the test runner's parent.
    writeFileSync(join(dir, LOCK_FILE), `${process.ppid}\n`);
    expect(() => lockDataDirectory(dir)).toThrow("another leve-sync server");
  });

  it("takes over a lock a stopped server left, including its own pid from a previous run", () => {
    const dir = temp();
    const exited = spawnSync(process.execPath, ["-e", "console.log(process.pid)"]);
    writeFileSync(join(dir, LOCK_FILE), exited.stdout);
    const release = lockDataDirectory(dir);
    release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);

    writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);
    lockDataDirectory(dir)();
  });
});
