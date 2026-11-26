import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lockDataDirectory } from "../src/lock.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "leve-lock-"));
  dirs.push(dir);
  return dir;
};

/** Another process holding the lock, as a second server would. */
async function holder(dir: string) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { lockDataDirectory } from ${JSON.stringify(new URL("../src/lock.ts", import.meta.url).href)};
     lockDataDirectory(${JSON.stringify(dir)}); console.log("locked"); setInterval(() => {}, 1000);`,
  ]);
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (code) => reject(new Error(`the holder exited (${code})`)));
  });
  return child;
}

describe("one server per data directory", () => {
  it("refuses a second server while the first runs, in this process or another", async () => {
    const dir = temp();
    const release = lockDataDirectory(dir);
    expect(() => lockDataDirectory(dir)).toThrow("another leve-sync server");
    release();
    lockDataDirectory(dir)();

    const other = await holder(dir);
    expect(() => lockDataDirectory(dir)).toThrow("another leve-sync server");
    other.kill("SIGTERM");
    await new Promise((resolve) => other.once("exit", resolve));
  });

  it("is free again once a server that held it is killed, whatever its pid", async () => {
    const dir = temp();
    const crashed = await holder(dir);
    crashed.kill("SIGKILL");
    await new Promise((resolve) => crashed.once("exit", resolve));
    lockDataDirectory(dir)();
  });
});
