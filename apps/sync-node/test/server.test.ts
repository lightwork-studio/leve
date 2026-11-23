import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { afterAll, describe, expect, it } from "vitest";
import { sharedTokenAuth } from "../src/auth.ts";
import { createSyncServer } from "../src/server.ts";

const TOKEN = "t".repeat(64);
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

async function start(prepare?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "leve-sync-node-"));
  dirs.push(dir);
  prepare?.(dir);
  const errors: unknown[] = [];
  const storage = new ServerStorage({
    engine: createNodeSqliteEngine(),
    directory: dir,
    appVersion: "t",
  });
  const server = createSyncServer({
    storage,
    authenticate: sharedTokenAuth(TOKEN),
    onError: (error) => errors.push(error),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const post = (path: string, body: unknown = {}, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-leve-account": "acc",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await storage.close();
  };
  return { post, stop, errors };
}

describe("the benchmark sync server", () => {
  it("answers sync and stats with its timing header, and refuses a wrong token", async () => {
    const { post, stop } = await start();
    const hello = await post("/sync/hello", { releases: ["1.0"], app: "t" });
    expect(hello.status).toBe(200);
    expect(Number(hello.headers.get("x-server-ms"))).toBeGreaterThanOrEqual(0);
    const stats = await post("/admin/stats");
    expect(await stats.json()).toMatchObject({ revision: 0, records: 0 });
    expect((await post("/admin/stats", {}, "x".repeat(64))).status).toBe(401);
    await stop();
  });

  it("answers 503 when an account can't be opened, and keeps serving", async () => {
    // The account files can't be created in a read-only directory.
    const { post, stop, errors } = await start((dir) => chmodSync(dir, 0o500));
    expect((await post("/admin/stats")).status).toBe(503);
    expect((await post("/admin/stats")).status).toBe(503);
    expect((await post("/sync/hello", { releases: ["1.0"], app: "t" })).status).toBe(503);
    expect(errors.length).toBe(3);
    await stop();
  });
});
