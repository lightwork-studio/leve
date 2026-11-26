import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { afterAll, describe, expect, it } from "vitest";
import { Accounts } from "../src/accounts.ts";
import { adminRequest, listenAdmin, pairingLink } from "../src/admin.ts";
import { runAdmin, UsageError } from "../src/cli.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function start(publicUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), "leve-admin-"));
  const accounts = Accounts.open({
    engine: createNodeSqliteEngine(),
    path: join(dir, "accounts.db"),
  });
  const socket = join(dir, "admin.sock");
  const server: Server = await listenAdmin(socket, {
    accounts,
    ...(publicUrl ? { publicUrl } : {}),
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => accounts.close());
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { dir, socket, accounts, server };
}

describe("administration", () => {
  it("listens on a socket only its own user can open", async () => {
    const { socket } = await start();
    expect(statSync(socket).isSocket()).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });

  it("creates accounts, pairs phones and signs them out through the CLI", async () => {
    const { socket, accounts } = await start("https://sync.example.com/leve/");
    expect(await runAdmin(socket, ["accounts", "add", "Alice", "Smith"])).toContain(
      "Created Alice Smith",
    );
    const pairing = JSON.parse(await runAdmin(socket, ["pair", "Alice", "Smith", "--json"]));
    expect(pairing.link).toBe(`https://sync.example.com/leve/connect#code=${pairing.code}`);
    const paired = accounts.pair(pairing.code, "phone");
    expect(paired).not.toBeNull();
    expect(await runAdmin(socket, ["accounts", "list"])).toMatch(/Alice Smith\t.+\t1 phone$/);
    expect(await runAdmin(socket, ["devices", "list", "Alice Smith"])).toContain(paired?.device);
    expect(await runAdmin(socket, ["devices", "revoke", paired?.device ?? ""])).toBe(
      "Signed out 1 phone.",
    );
    expect(accounts.deviceForToken(paired?.token ?? "")).toBeNull();
  });

  it("explains refused commands instead of failing silently", async () => {
    const { socket } = await start();
    await expect(runAdmin(socket, ["pair", "Nobody"])).rejects.toThrow("no account named Nobody");
    await expect(runAdmin(socket, ["devices", "revoke", "nope"])).rejects.toThrow("no device");
    await expect(runAdmin(socket, ["frobnicate"])).rejects.toBeInstanceOf(UsageError);
    await expect(adminRequest(socket, "/sync/hello")).rejects.toThrow("unknown command");
    // Without a public URL, the operator gets the code to type in.
    await runAdmin(socket, ["accounts", "add", "Bob"]);
    expect(await runAdmin(socket, ["pair", "Bob"])).toContain("Set LEVE_PUBLIC_URL");
  });

  it("says when no server is listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leve-admin-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(adminRequest(join(dir, "admin.sock"), "/accounts/list")).rejects.toThrow(
      "is leve-sync running?",
    );
  });

  it("replaces a socket a crashed server left, but nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leve-admin-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socket = join(dir, "admin.sock");
    // A process killed while listening leaves its socket file behind.
    const child = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => console.log("up"))`,
    ]);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(statSync(socket).isSocket()).toBe(true);

    const accounts = Accounts.open({ engine: createNodeSqliteEngine(), path: join(dir, "a.db") });
    cleanups.push(() => accounts.close());
    const notSocket = join(dir, "file");
    writeFileSync(notSocket, "keep me");
    await expect(listenAdmin(notSocket, { accounts })).rejects.toThrow("isn't a socket");
    expect(readFileSync(notSocket, "utf8")).toBe("keep me");
    const again = await listenAdmin(socket, { accounts });
    cleanups.push(() => new Promise<void>((resolve) => again.close(() => resolve())));
    expect(await adminRequest(socket, "/accounts/list")).toEqual([]);
  });

  it("builds pairing links with the code in the fragment", () => {
    expect(pairingLink("https://h.example", "abc")).toBe("https://h.example/connect#code=abc");
  });
});

describe("the admin socket's guards", () => {
  it("won't take over a socket another server still answers on", async () => {
    const first = await start();
    await expect(listenAdmin(first.socket, { accounts: first.accounts })).rejects.toThrow(
      "another leve-sync server is running",
    );
    // The first server still answers.
    expect(await adminRequest(first.socket, "/accounts/list")).toEqual([]);
  });

  it("listens only on an absolute path, never on a port", async () => {
    const { accounts } = await start();
    for (const path of ["38917", "admin.sock", "./admin.sock"]) {
      await expect(listenAdmin(path, { accounts })).rejects.toThrow("absolute path");
    }
  });

  it("signs every phone out with one command", async () => {
    const { socket, accounts } = await start();
    accounts.addAccount("Alice");
    accounts.addAccount("Bob");
    accounts.pair(accounts.createPairing("Alice").code, "a");
    accounts.pair(accounts.createPairing("Bob").code, "b");
    expect(await runAdmin(socket, ["devices", "revoke", "--everyone"])).toBe(
      "Signed out 2 phones.",
    );
    expect(accounts.listDevices()).toEqual([]);
  });
});
