import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { httpTransport, SyncClient } from "@leve/sync";
import { bearerAuthentication } from "@leve/sync/server";
import { afterEach, describe, expect, it } from "vitest";
import { workout } from "../../../packages/sync/test/support/content.ts";
import { Accounts, deviceAuthenticator } from "../src/accounts.ts";
import { listenAdmin } from "../src/admin.ts";
import { runAdmin } from "../src/cli.ts";
import { createSyncServer } from "../src/server.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "leve-backups-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "data");
  const engine = createNodeSqliteEngine();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(data);
  const accounts = Accounts.open({ engine, path: join(data, "accounts.db") });
  const storage = new ServerStorage({ engine, directory: data, appVersion: "t" });
  const http = createSyncServer({
    storage,
    authenticate: bearerAuthentication(deviceAuthenticator(accounts)),
    accounts,
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const socket = join(dir, "admin.sock");
  const admin = await listenAdmin(socket, {
    accounts,
    data: { storage, engine, directory: data },
  });
  cleanups.push(async () => {
    await close(admin);
    await close(http);
    await storage.close();
    accounts.close();
  });
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  /** A phone with its own device database, paired with `name` and syncing over HTTP. */
  const phone = async (name: string) => {
    if (!accounts.findAccount(name)) await runAdmin(socket, ["accounts", "add", name]);
    const { code } = JSON.parse(await runAdmin(socket, ["pair", name, "--json"]));
    const paired = accounts.pair(code, "phone");
    if (!paired) throw new Error("pairing failed");
    const store = await openDeviceStore({
      engine,
      path: join(dir, `${name}-phone.db`),
      appVersion: "t",
    });
    cleanups.push(() => store.close());
    const client = new SyncClient({
      store,
      server: base,
      account: paired.account,
      app: "t",
      transport: httpTransport(base, { authorization: `Bearer ${paired.token}` }),
    });
    const sync = async () => {
      const outcome = await client.sync();
      expect(outcome).toMatchObject({ state: "synced" });
      return outcome;
    };
    return { store, sync, account: paired.account, token: paired.token };
  };

  /** The workout titles the server holds for a token, read over the wire. */
  const serverTitles = async (token: string) => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<{ lineage: string; changes: unknown[] }>);
    const { lineage } = await post("/sync/hello", { releases: ["1.0"], app: "t" });
    const page = await post("/sync/pull", { release: "1.0", lineage, cursor: 0 });
    return (page.changes as { kind: string; content?: { title: string } }[])
      .filter((c) => c.kind === "workout" && c.content)
      .map((c) => c.content?.title)
      .sort();
  };

  return { dir, data, socket, phone, serverTitles };
}

describe("backups and restores", () => {
  it("restores an account from a backup, and its phone brings back what came after", async () => {
    const { dir, socket, phone, serverTitles } = await start();
    const alice = await phone("Alice");
    alice.store.put("workout", "w-before", workout("Before the backup", { initialPlan: null }));
    await alice.sync();

    const backup = JSON.parse(await runAdmin(socket, ["backup", join(dir, "backups"), "--json"]));
    expect(statSync(backup.folder).mode & 0o777).toBe(0o700);
    expect(backup.manifest.accounts).toEqual([
      expect.objectContaining({ id: alice.account, name: "Alice", revision: 1 }),
    ]);
    expect(existsSync(join(backup.folder, "accounts.db"))).toBe(true);

    alice.store.put("workout", "w-after", workout("After the backup", { initialPlan: null }));
    await alice.sync();
    expect(await serverTitles(alice.token)).toEqual(["After the backup", "Before the backup"]);

    const file = join(backup.folder, `account-${alice.account}.db`);
    const restored = JSON.parse(await runAdmin(socket, ["restore", "Alice", file, "--json"]));
    expect(restored).toMatchObject({ account: "Alice", revision: 1 });
    expect(existsSync(restored.replaced)).toBe(true);
    // The server lost the later workout ...
    expect(await serverTitles(alice.token)).toEqual(["Before the backup"]);
    const stats = JSON.parse(await runAdmin(socket, ["stats", "Alice"]));
    expect(stats.restoredFrom).toMatchObject({ restorePoint: 1 });

    // ... and the phone, seeing the new lineage, offers it back without asking anything.
    await alice.sync();
    await alice.sync();
    expect(await serverTitles(alice.token)).toEqual(["After the backup", "Before the backup"]);
    expect(alice.store.summary()).toMatchObject({ conflict: 0, pending: 0 });
  });

  it("never restores one account's backup into another unless told to", async () => {
    const { dir, socket, phone, serverTitles } = await start();
    const alice = await phone("Alice");
    const bob = await phone("Bob");
    alice.store.put("workout", "w-a", workout("Alice's", { initialPlan: null }));
    await alice.sync();
    bob.store.put("workout", "w-b", workout("Bob's", { initialPlan: null }));
    await bob.sync();
    const backup = JSON.parse(await runAdmin(socket, ["backup", join(dir, "b"), "--json"]));
    const bobsFile = join(backup.folder, `account-${bob.account}.db`);

    await expect(runAdmin(socket, ["restore", "Alice", bobsFile])).rejects.toThrow(
      "isn't a backup of Alice",
    );
    expect(await serverTitles(alice.token)).toEqual(["Alice's"]);
  });

  it("refuses a damaged backup and leaves the account as it was", async () => {
    const { dir, socket, phone, serverTitles } = await start();
    const alice = await phone("Alice");
    alice.store.put("workout", "w-a", workout("Kept", { initialPlan: null }));
    await alice.sync();
    const damaged = join(dir, `account-${alice.account}.db`);
    writeFileSync(damaged, "not a database");
    await expect(runAdmin(socket, ["restore", "Alice", damaged])).rejects.toThrow("cannot restore");
    await expect(runAdmin(socket, ["restore", "Alice", join(dir, "missing.db")])).rejects.toThrow();
    expect(await serverTitles(alice.token)).toEqual(["Kept"]);
    await alice.sync();
  });

  it("backs up accounts.db, and skips accounts no phone has synced with", async () => {
    const { dir, data, socket } = await start();
    await runAdmin(socket, ["accounts", "add", "Nobody yet"]);
    const backup = JSON.parse(await runAdmin(socket, ["backup", join(dir, "b"), "--json"]));
    expect(backup.manifest.accounts).toEqual([]);
    // Backing up didn't create the account's database.
    expect(readFileSync(join(backup.folder, "manifest.json"), "utf8")).toContain('"format": 1');
    const stats = JSON.parse(await runAdmin(socket, ["stats", "Nobody yet"]));
    expect(stats).toMatchObject({ synced: false });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(data).filter((f) => f.startsWith("account-"))).toEqual([]);
  });
});
