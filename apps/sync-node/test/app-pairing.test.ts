import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { httpTransport, SyncClient } from "@leve/sync";
import { bearerAuthentication } from "@leve/sync/server";
import { afterAll, expect, it } from "vitest";
import { workout } from "../../../packages/sync/test/support/content.ts";
import { pair, parsePairingLink } from "../../mobile/src/sync/own-server.ts";
import { Accounts, deviceAuthenticator } from "../src/accounts.ts";
import { pairingLink } from "../src/admin.ts";
import { createSyncServer } from "../src/server.ts";

/* The app's half of pairing (apps/mobile/src/sync/own-server.ts) against this server. */

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

it("pairs the app from the operator's link, syncs, and stops once the phone is signed out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leve-app-pairing-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const engine = createNodeSqliteEngine();
  const accounts = Accounts.open({ engine, path: join(dir, "accounts.db") });
  const storage = new ServerStorage({ engine, directory: dir, appVersion: "t" });
  const http = createSyncServer({
    storage,
    authenticate: bearerAuthentication(deviceAuthenticator(accounts)),
    accounts,
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise((resolve) => http.close(resolve));
    await storage.close();
    accounts.close();
  });
  // The app allows plain HTTP only to this machine, which the test server is.
  const base = `http://localhost:${(http.address() as AddressInfo).port}`;

  accounts.addAccount("Alice");
  const link = parsePairingLink(pairingLink(base, accounts.createPairing("Alice").code));
  if (!link) throw new Error("the app can't read the operator's link");
  const own = await pair(link, "Alice's iPhone");
  expect(own).toMatchObject({ server: base, accountName: "Alice" });
  // The same link never pairs a second phone.
  await expect(pair(link, "Another phone")).rejects.toMatchObject({ problem: "code" });

  const store = await openDeviceStore({ engine, path: join(dir, "phone.db"), appVersion: "t" });
  cleanups.push(() => store.close());
  const client = new SyncClient({
    store,
    server: own.server,
    account: own.account,
    app: "t",
    transport: httpTransport(own.server, { authorization: `Bearer ${own.token}` }),
  });
  store.put("workout", "w1", workout("Paired", { initialPlan: null }));
  expect(await client.sync()).toMatchObject({ state: "synced" });

  accounts.revokeDevice(own.device);
  expect(await client.sync()).toMatchObject({ state: "signed_out" });
});

it("follows no redirect: the code and the workouts go only to the server confirmed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leve-app-pairing-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const engine = createNodeSqliteEngine();
  const accounts = Accounts.open({ engine, path: join(dir, "accounts.db") });
  const storage = new ServerStorage({ engine, directory: dir, appVersion: "t" });
  const real = createSyncServer({
    storage,
    authenticate: bearerAuthentication(deviceAuthenticator(accounts)),
    accounts,
  });
  await new Promise<void>((resolve) => real.listen(0, "127.0.0.1", resolve));
  const target = `http://localhost:${(real.address() as AddressInfo).port}`;
  // A server (or a proxy in front of one) that sends every request on elsewhere.
  const { createServer } = await import("node:http");
  const forwarder = createServer((request, response) => {
    request.resume();
    response.writeHead(307, { location: `${target}${request.url}` }).end();
  });
  await new Promise<void>((resolve) => forwarder.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise((resolve) => forwarder.close(resolve));
    await new Promise((resolve) => real.close(resolve));
    await storage.close();
    accounts.close();
  });
  const confirmed = `http://localhost:${(forwarder.address() as AddressInfo).port}`;

  accounts.addAccount("Alice");
  const { code } = accounts.createPairing("Alice");
  await expect(pair({ server: confirmed, code }, "phone")).rejects.toMatchObject({
    problem: "offline",
  });
  // The code never reached the other server: it still pairs there directly.
  expect(await pair({ server: target, code }, "phone")).toMatchObject({ server: target });

  const send = httpTransport(confirmed, { authorization: "Bearer x" });
  await expect(send("/sync/hello", { releases: ["1.0"], app: "t" })).rejects.toThrow();
});
