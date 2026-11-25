import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { type Transport, TransportError } from "@leve/sync";
import { SyncService, serviceTransport } from "@leve/sync/server";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  SyncSession,
  type SyncStatus,
  type SyncTiming,
  unsyncedChanges,
} from "../src/sync/sync-session.ts";

/* The app's sync session against a real sync service, reached through a stand-in for the Worker's
   sign-in check: a token names the account, an unknown token is refused with 401. */

const SERVER = "https://sync.test";
let directory: string;
let storage: ServerStorage;
let service: SyncService;
/** Which account each token signs in as. */
let tokens: Map<string, string>;
/** When set, every request fails as if there were no connection. */
let offline: boolean;
/** When set, the server answers update_required. */
let tooOld: boolean;
let requests: string[];
/** Called as a hello goes out, so a test can act in the middle of connecting. */
let onHello: (() => void) | null;
let sessions: SyncSession[];
let ids = 0;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "leve-app-sync-"));
  storage = new ServerStorage({
    engine: createNodeSqliteEngine(),
    directory,
    appVersion: "server-test",
  });
  service = new SyncService({ storage });
  tokens = new Map([
    ["alice-token", "alice"],
    ["bob-token", "bob"],
  ]);
  offline = false;
  tooOld = false;
  requests = [];
  onHello = null;
  sessions = [];
});
afterEach(async () => {
  for (const session of sessions) session.stop();
  await storage.close();
  rmSync(directory, { recursive: true, force: true });
});

const connect =
  (_server: string, headers: () => Record<string, string> | Promise<Record<string, string>>) =>
  async (path: string, body: unknown) => {
    const sent = await headers();
    if (offline) throw new TransportError("no connection");
    const account = tokens.get(sent.authorization?.replace(/^Bearer /, "") ?? "");
    if (path === "/sync/hello") onHello?.();
    // Waits for changes are marked, so tests can tell them from plain downloads.
    const waits = (body as { waitMs?: number } | null)?.waitMs ? " wait" : "";
    requests.push(`${account ?? "?"} ${path}${waits}`);
    if (!account) {
      return { status: 401, body: { error: { code: "unauthorized", message: "sign in again" } } };
    }
    if (tooOld) {
      return {
        status: 400,
        body: { error: { code: "update_required", message: "update", update: "client" } },
      };
    }
    return serviceTransport(service, account)(path, body);
  };

async function phone(): Promise<DeviceStore> {
  return openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/phone.db",
    appVersion: "app-test",
    randomId: () => `id-${++ids}`,
  });
}

const folder = (store: DeviceStore, id: string, title: string) =>
  store.put("routine_folder", id, { title, position: 1 });

/** Another phone that already put data in the account. */
async function otherPhone(account: string, folderId: string): Promise<void> {
  const other = await phone();
  folder(other, folderId, "From the other phone");
  const session = start(other, account).session;
  await until(() => session.status.lastSynced !== null || session.status.prompt !== null);
  if (session.status.prompt?.kind === "combine") session.combine();
  await until(() => session.status.lastSynced !== null);
  session.stop();
}

function start(
  store: DeviceStore,
  account: string,
  options: {
    token?: (fresh: boolean) => Promise<string | null>;
    timing?: Partial<SyncTiming>;
  } = {},
) {
  const events = { pulled: 0, startedOver: 0, statuses: [] as SyncStatus[] };
  const session = new SyncSession({
    store,
    server: SERVER,
    account,
    app: "app-test",
    token: options.token ?? (async () => `${account}-token`),
    onPulled: () => {
      events.pulled += 1;
    },
    onStatus: (status) => events.statuses.push(status),
    startOver: () => {
      events.startedOver += 1;
    },
    connect: connect as (server: string, headers: unknown) => Transport,
    timing: {
      offline: [20],
      error: 20,
      serverUpdate: 20,
      nudge: 10,
      wait: 200,
      busy: 20,
      ...options.timing,
    },
  });
  sessions.push(session);
  session.start();
  return { session, events };
}

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const serverFolders = async (account: string) =>
  (await storage.account(account)).db
    .all("SELECT id FROM records WHERE kind = 'routine_folder' ORDER BY id")
    .map((row) => String(row.id));

it("connects a phone with data to an empty account without asking, and uploads it", async () => {
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  const { session } = start(store, "alice");
  await until(() => session.status.lastSynced !== null);
  expect(session.status.prompt).toBeNull();
  expect(store.syncState()).toMatchObject({ account: "alice", server: SERVER });
  expect(await serverFolders("alice")).toEqual(["f-phone"]);
});

it("downloads an account onto an empty phone without asking", async () => {
  await otherPhone("alice", "f-other");
  const store = await phone();
  const { session, events } = start(store, "alice");
  await until(() => session.status.lastSynced !== null);
  expect(session.status.prompt).toBeNull();
  expect(store.get("routine_folder", "f-other")).toMatchObject({ status: "synced" });
  expect(events.pulled).toBe(1);
});

it("asks before combining a phone's data with an account that has data, and combines on yes", async () => {
  await otherPhone("alice", "f-other");
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  const { session } = start(store, "alice");
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "combine" });
  // Asking changed nothing on either side.
  expect(store.syncState()).toMatchObject({ account: null, server: null });
  expect(await serverFolders("alice")).toEqual(["f-other"]);

  session.combine();
  await until(() => session.status.lastSynced !== null);
  expect(await serverFolders("alice")).toEqual(["f-other", "f-phone"]);
  expect(store.get("routine_folder", "f-other")).toMatchObject({ status: "synced" });
  expect(store.syncState().account).toBe("alice");
});

it("replaces the phone's data on request instead, without sending any of it", async () => {
  await otherPhone("alice", "f-other");
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  const { session, events } = start(store, "alice");
  await until(() => session.status.prompt !== null);
  session.replaceLocalData();
  expect(events.startedOver).toBe(1);
  expect(await serverFolders("alice")).toEqual(["f-other"]);
});

it("moves to another account at once when everything synced", async () => {
  const store = await phone();
  folder(store, "f-alice", "Alice's");
  const alice = start(store, "alice").session;
  await until(() => alice.status.lastSynced !== null);
  alice.stop();

  const { session, events } = start(store, "bob");
  await until(() => events.startedOver > 0);
  expect(session.status.prompt).toBeNull();
  expect(await serverFolders("bob")).toEqual([]);
});

it("asks before deleting another account's unsynced changes, and sends none of them", async () => {
  const store = await phone();
  folder(store, "f-alice", "Alice's");
  const alice = start(store, "alice").session;
  await until(() => alice.status.lastSynced !== null);
  alice.stop();
  folder(store, "f-alice", "Alice's, edited");
  folder(store, "f-alice-2", "Alice's second");

  const { session, events } = start(store, "bob");
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "switch", reason: "account" });
  expect(unsyncedChanges(store)).toBe(2);
  expect(events.startedOver).toBe(0);
  expect(await serverFolders("bob")).toEqual([]);
  expect(requests.filter((line) => line.startsWith("bob"))).toEqual([]);

  session.replaceLocalData();
  expect(events.startedOver).toBe(1);
});

it("never takes a workout in progress away, even when all of it synced", async () => {
  const store = await phone();
  store.put("workout", "w-live", {
    title: "Push",
    startedAt: "2026-11-25T08:00:00.000Z",
    endedAt: null,
  });
  const alice = start(store, "alice").session;
  await until(() => store.get("workout", "w-live")?.status === "synced");
  alice.stop();

  const { session, events } = start(store, "bob");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(events.startedOver).toBe(0);
  expect(session.status.prompt).toBeNull();
  expect(requests.filter((line) => line.startsWith("bob"))).toEqual([]);

  store.put("workout", "w-live", {
    title: "Push",
    startedAt: "2026-11-25T08:00:00.000Z",
    endedAt: "2026-11-25T09:00:00.000Z",
  });
  // The finished workout hasn't synced: now it asks.
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "switch", reason: "account" });
});

it("sends nothing more once stopped, even from a sync already under way", async () => {
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  const { session } = start(store, "alice", {
    token: async () => {
      asked += 1;
      // The second request (connecting, after the probe) waits for its token while it stops.
      if (asked === 2) await held;
      return "alice-token";
    },
  });
  await until(() => asked === 2);
  session.stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(requests).toEqual(["alice /sync/hello"]);
  expect(store.get("routine_folder", "f-phone")).toMatchObject({ status: "pending" });
});

it("stays quiet while offline, and catches up once the connection is back", async () => {
  const store = await phone();
  offline = true;
  folder(store, "f-phone", "On the phone");
  const { session } = start(store, "alice");
  await until(() => session.status.failingSince !== null);
  expect(session.status.prompt).toBeNull();
  offline = false;
  await until(() => session.status.lastSynced !== null);
  expect(session.status).toMatchObject({ prompt: null, failingSince: null });
  expect(await serverFolders("alice")).toEqual(["f-phone"]);
});

it("tries a fresh token once before asking to sign in again, and resumes after", async () => {
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  const asked: boolean[] = [];
  let stale = true;
  const { session } = start(store, "alice", {
    token: async (fresh) => {
      asked.push(fresh);
      if (fresh) stale = false;
      return stale ? "expired" : "alice-token";
    },
  });
  await until(() => session.status.lastSynced !== null);
  expect(session.status.prompt).toBeNull();
  expect(asked).toContain(true);

  // A sign-in the server keeps refusing asks the person.
  tokens.delete("alice-token");
  folder(store, "f-phone", "Edited");
  session.nudge();
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "sign_in" });
  expect(store.get("routine_folder", "f-phone")).toMatchObject({ status: "pending" });

  tokens.set("alice-token", "alice");
  session.retry();
  await until(() => store.get("routine_folder", "f-phone")?.status === "synced");
  expect(session.status.prompt).toBeNull();
});

it("tries a refused sign-in again on return to the app, keeping the question up until it works", async () => {
  const store = await phone();
  tokens.delete("alice-token");
  const { session, events } = start(store, "alice");
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "sign_in" });
  const asked = events.statuses.length;

  // Still refused: the question stays, without going away in between.
  const sent = requests.length;
  session.setForeground(true);
  await until(() => requests.length > sent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events.statuses.slice(asked).every((status) => status.prompt !== null)).toBe(true);

  tokens.set("alice-token", "alice");
  session.setForeground(true);
  await until(() => session.status.prompt === null);
  expect(session.status.lastSynced).not.toBeNull();
  expect(
    events.statuses.slice(asked).find((status) => status.prompt === null)?.lastSynced,
  ).not.toBeNull();
});

it("still asks before combining after a refused sign-in starts working again", async () => {
  await otherPhone("alice", "f-other");
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  tokens.delete("alice-token");
  const { session } = start(store, "alice");
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "sign_in" });

  tokens.set("alice-token", "alice");
  session.setForeground(true);
  await until(() => session.status.prompt?.kind === "combine");
  // Unanswered, the question holds everything back: nothing is tied, downloaded or sent.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(store.syncState().account).toBeNull();
  expect(store.get("routine_folder", "f-other")).toBeNull();
  session.stop();

  const again = start(store, "alice").session;
  await until(() => again.status.prompt !== null);
  expect(again.status.prompt).toEqual({ kind: "combine" });
  expect(await serverFolders("alice")).toEqual(["f-other"]);
});

it("tries a fresh token again after a combine answer, if the cached one lapsed meanwhile", async () => {
  await otherPhone("alice", "f-other");
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  let cached = "expired";
  const { session } = start(store, "alice", {
    token: async (fresh) => {
      if (fresh) cached = "alice-token";
      return cached;
    },
  });
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "combine" });
  // Answered a while later, when the cached token has lapsed.
  cached = "expired";
  session.combine();
  await until(() => session.status.prompt !== null || session.status.lastSynced !== null);
  expect(session.status.prompt).toBeNull();
  expect(await serverFolders("alice")).toEqual(["f-other", "f-phone"]);
});

it("doesn't start waiting for changes once the app went to the back while connecting", async () => {
  const store = await phone();
  folder(store, "f-phone", "On the phone");
  const { session } = start(store, "alice", { timing: { wait: 1_500 } });
  await until(() => session.status.lastSynced !== null);
  requests = [];
  onHello = () => {
    onHello = null;
    session.setForeground(false);
  };
  await until(() => requests.some((line) => line.endsWith("/sync/hello")));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(requests.filter((line) => line.endsWith(" wait"))).toEqual([]);
});

it("doesn't count a fresh-token retry that never reached the server", async () => {
  const store = await phone();
  let fresh = 0;
  // Like Clerk: a cached token until a fresh one is asked for, which is then cached.
  let cached = "expired";
  const { session } = start(store, "alice", {
    token: async (wantsFresh) => {
      if (!wantsFresh) return cached;
      fresh += 1;
      // The first fresh token can't be had (no connection); the next one works.
      if (fresh === 1) throw new Error("no connection");
      cached = "alice-token";
      return cached;
    },
  });
  await until(() => session.status.lastSynced !== null || session.status.prompt !== null);
  expect(session.status.prompt).toBeNull();
  expect(fresh).toBe(2);
});

it("asks for an update when the server no longer syncs with this version", async () => {
  const store = await phone();
  tooOld = true;
  const { session } = start(store, "alice");
  await until(() => session.status.prompt !== null);
  expect(session.status.prompt).toEqual({ kind: "update" });
});

it("sends an edit soon after it is made, and hears about changes made elsewhere", async () => {
  const store = await phone();
  // Waits on the server far longer than the test allows below, so only giving up the wait for the
  // edit, and the server's answer to the other phone's change, can pass it.
  const { session, events } = start(store, "alice", { timing: { wait: 10_000 } });
  await until(() => session.status.lastSynced !== null);
  await until(() => requests.at(-1) === "alice /sync/pull wait");

  // An edit while the session waits on the server for changes.
  folder(store, "f-phone", "On the phone");
  session.nudge();
  await until(() => store.get("routine_folder", "f-phone")?.status === "synced", 2_000);

  await otherPhone("alice", "f-other");
  await until(() => store.get("routine_folder", "f-other") !== null, 2_000);
  expect(events.pulled).toBeGreaterThan(0);
  expect(session.status.prompt).toBeNull();
});
