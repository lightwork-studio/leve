// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPLE_AUTH, CLERK_API } from "./account-deletion.ts";
import { AccountObject, RestoreMarker } from "./account-object.ts";
import { ACCOUNT_DELETE_PATH, ACCOUNT_HEADER } from "./gate.ts";
import { fakeObjectStorage } from "./object-storage-fake.ts";

// The account object on Node (cloudflare:workers is a stand-in, see vitest.config.ts) with its
// storage on Node's SQLite, its marker object in memory, and Clerk and Apple faked at fetch.

const ACCOUNT = "user_alice";
const APPLE_USER = "001234.abcdef.0001";

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const pkcs8 = new Uint8Array(
  (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
);
const SECRETS = {
  CLERK_SECRET_KEY: "sk_test_secret",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`,
  APPLE_CLIENT_ID: "app.leve.dev",
};

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Clerk's user and the Apple grant, as the fake services see them. */
let clerkUser: boolean;
let appleGrant: boolean;
let appleAccepts: boolean;
let calls: string[];

beforeEach(() => {
  clerkUser = true;
  appleGrant = true;
  appleAccepts = true;
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === `${CLERK_API}/users/${ACCOUNT}`) {
      if (!clerkUser) return Response.json({}, { status: 404 });
      if (method === "DELETE") clerkUser = false;
      return Response.json({
        external_accounts: [{ provider: "oauth_apple", provider_user_id: APPLE_USER }],
      });
    }
    if (url === `${APPLE_AUTH}/token`) {
      if (!appleAccepts) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        refresh_token: "refresh",
        id_token: `${base64Url({ alg: "RS256" })}.${base64Url({ sub: APPLE_USER })}.sig`,
      });
    }
    if (url === `${APPLE_AUTH}/revoke`) {
      appleGrant = false;
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** One account's object and its marker, which a restart replaces with a new object on the same storage. */
function account(env: Record<string, string> = SECRETS) {
  const fake = fakeObjectStorage();
  const markerStorage = new Map<string, unknown>();
  const faults = Object.assign(fake.faults, { marker: false });
  const marker = new RestoreMarker(
    {
      storage: {
        get: async (key: string) => markerStorage.get(key),
        put: async (key: string, value: unknown) => {
          if (faults.marker) throw new Error("the marker object was reset");
          markerStorage.set(key, value);
        },
        delete: async (key: string) => markerStorage.delete(key),
      },
    } as never,
    {} as never,
  );
  const fullEnv = {
    ...env,
    RESTORES: { idFromName: (name: string) => name, get: () => marker },
  };
  const start = () =>
    new AccountObject({ storage: fake.storage, abort: () => {} } as never, fullEnv as never);
  return { ...fake, faults, marker, markerStorage, start };
}

async function post(object: AccountObject, path: string, body: unknown) {
  const response = await object.fetch(
    new Request(`https://sync.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [ACCOUNT_HEADER]: ACCOUNT },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Syncs one workout into the account, so there is data to delete. */
async function withData(object: AccountObject) {
  const hello = await post(object, "/sync/hello", { releases: ["1.0"], app: "test" });
  const lineage = hello.body.lineage as string;
  const push = await post(object, "/sync/push", {
    release: "1.0",
    lineage,
    submissions: [
      {
        submissionId: "s1",
        op: "put",
        kind: "workout",
        id: "w1",
        baseRevision: null,
        content: {
          title: "Push",
          startedAt: "2026-11-10T08:00:00.000Z",
          endedAt: "2026-11-10T09:00:00.000Z",
          routineId: null,
          initialPlan: null,
        },
      },
    ],
  });
  expect(push.body).toMatchObject({ results: [{ status: "accepted" }] });
  return lineage;
}

const deleted = { status: 410, body: { error: { code: "account_deleted" } } };

describe("deleting an account from the phone", () => {
  it("deletes the synced data, revokes Apple and deletes the Clerk user; the account never comes back", async () => {
    const one = account();
    const object = one.start();
    const lineage = await withData(object);
    expect(one.tables()).toContain("records");

    const reply = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "code" });
    expect(reply).toEqual({ status: 200, body: { deleted: true } });
    expect(one.tables()).toEqual([]);
    expect(appleGrant).toBe(false);
    expect(clerkUser).toBe(false);
    // Only the time of the deletion is kept, outside the deleted storage.
    expect([...one.markerStorage.keys()]).toEqual(["deleted"]);

    // Another phone still holding a session: told the account is gone, and nothing is recreated.
    expect(await post(object, "/sync/hello", { releases: ["1.0"], app: "test" })).toMatchObject(
      deleted,
    );
    expect(
      await post(object, "/sync/push", { release: "1.0", lineage, submissions: [] }),
    ).toMatchObject(deleted);
    expect(one.tables()).toEqual([]);

    // The same after the object restarts.
    const restarted = one.start();
    expect(await post(restarted, "/sync/hello", { releases: ["1.0"], app: "test" })).toMatchObject(
      deleted,
    );
    expect(one.tables()).toEqual([]);
  });

  it("finishes a deletion that stopped halfway on the next request, whoever sends it", async () => {
    const one = account();
    const object = one.start();
    await withData(object);
    one.faults.deleteAll = true;

    const reply = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "code" });
    expect(reply.status).toBe(503);
    // The marker was set first; the data is still there, and so is the sign-in.
    expect(one.markerStorage.has("deleted")).toBe(true);
    expect(one.tables()).toContain("records");
    expect(clerkUser).toBe(true);

    // The object restarts; the first request from another phone finds the account deleted, and
    // nothing of it is left.
    const restarted = one.start();
    expect(await post(restarted, "/sync/hello", { releases: ["1.0"], app: "test" })).toMatchObject(
      deleted,
    );
    expect(one.tables()).toEqual([]);

    // Trying again from the phone deletes the sign-in too.
    const retry = await post(restarted, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "code2" });
    expect(retry.status).toBe(200);
    expect(clerkUser).toBe(false);
    expect(appleGrant).toBe(false);
  });

  it("deletes nothing when Apple refuses the code, and deletes everything on a retry", async () => {
    const one = account();
    const object = one.start();
    await withData(object);
    appleAccepts = false;

    const reply = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "used" });
    expect(reply).toMatchObject({ status: 400, body: { step: "apple" } });
    expect(one.tables()).toContain("records");
    expect(one.markerStorage.size).toBe(0);
    expect(clerkUser).toBe(true);
    expect(await post(object, "/sync/hello", { releases: ["1.0"], app: "test" })).toMatchObject({
      status: 200,
    });

    appleAccepts = true;
    const retry = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "fresh" });
    expect(retry.status).toBe(200);
    expect(one.tables()).toEqual([]);
    expect(clerkUser).toBe(false);
  });

  it("doesn't claim a deletion when recording it failed", async () => {
    const one = account();
    one.faults.marker = true;
    const object = one.start();
    await withData(object);

    const reply = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "code" });
    expect(reply.status).toBe(503);
    expect(reply.body.step).toBeUndefined();
    expect(one.tables()).toContain("records");
    expect(clerkUser).toBe(true);
    // Other phones keep syncing: nothing was deleted.
    expect(await post(object, "/sync/hello", { releases: ["1.0"], app: "test" })).toMatchObject({
      status: 200,
    });
  });

  it("answers MCP and the operator's endpoints that the account is gone", async () => {
    const one = account();
    const object = one.start();
    await withData(object);
    await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "code" });
    for (const path of ["/mcp", "/admin/export", "/admin/stats", "/admin/restore"]) {
      expect(await post(object, path, { bookmark: "b" }), path).toMatchObject(deleted);
    }
    expect(one.tables()).toEqual([]);
  });

  it("answers the same after a lost answer, once the sign-in is already gone", async () => {
    const one = account();
    const object = one.start();
    await withData(object);
    expect((await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "c" })).status).toBe(
      200,
    );
    const again = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "c2" });
    expect(again).toEqual({ status: 200, body: { deleted: true } });
  });

  it("deletes nothing while the Worker isn't set up for it", async () => {
    const { APPLE_PRIVATE_KEY: _, ...partial } = SECRETS;
    const one = account(partial);
    const object = one.start();
    await withData(object);

    const reply = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: "code" });
    expect(reply).toMatchObject({ status: 503, body: { step: "configuration" } });
    expect(one.tables()).toContain("records");
    expect(one.markerStorage.size).toBe(0);
    expect(calls).toEqual([]);
    expect(await post(object, "/sync/hello", { releases: ["1.0"], app: "test" })).toMatchObject({
      status: 200,
    });
  });

  it("refuses a malformed code before deleting anything", async () => {
    const one = account();
    const object = one.start();
    await withData(object);
    const reply = await post(object, ACCOUNT_DELETE_PATH, { appleAuthorizationCode: 42 });
    expect(reply.status).toBe(400);
    expect(reply.body.step).toBeUndefined();
    expect(one.tables()).toContain("records");
  });
});
