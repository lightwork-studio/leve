import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { type AuthOutcome, bearerAuthentication } from "@leve/sync/server";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { workout } from "../../../packages/sync/test/support/content.ts";
import { Accounts, deviceAuthenticator } from "../src/accounts.ts";
import { sharedTokenAuth } from "../src/auth.ts";
import { CONNECT_PAGE } from "../src/connect-page.ts";
import { createSyncServer } from "../src/server.ts";

const TOKEN = "t".repeat(64);
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});
afterAll(() => {
  for (const dir of dirs) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

type Authenticate = (request: IncomingMessage) => AuthOutcome | Promise<AuthOutcome>;

async function start(
  options: {
    prepare?: (dir: string) => void;
    benchmark?: boolean;
    pairingOff?: boolean;
    /** Replaces the device-token sign-in, for broken variants. */
    authenticate?: (accounts: Accounts) => Authenticate;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "leve-sync-node-"));
  dirs.push(dir);
  const engine = createNodeSqliteEngine();
  const accounts = Accounts.open({ engine, path: join(dir, "accounts.db") });
  options.prepare?.(dir);
  const errors: unknown[] = [];
  const storage = new ServerStorage({ engine, directory: dir, appVersion: "t" });
  let server: Server;
  if (options.benchmark) {
    server = createSyncServer({
      storage,
      authenticate: sharedTokenAuth(TOKEN),
      benchmark: true,
      onError: (error) => errors.push(error),
    });
  } else {
    server = createSyncServer({
      storage,
      authenticate:
        options.authenticate?.(accounts) ?? bearerAuthentication(deviceAuthenticator(accounts)),
      accounts,
      ...(options.pairingOff ? { pairingOff: true } : {}),
      onError: (error) => errors.push(error),
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await storage.close();
    accounts.close();
  };
  stops.push(stop);
  /** Pairs a new phone with a new account. */
  const phone = async (name: string) => {
    const account = accounts.findAccount(name) ?? accounts.addAccount(name);
    const { code } = accounts.createPairing(name);
    const reply = await post("/auth/pair", { code, device: `${name}'s phone` });
    expect(reply.status).toBe(200);
    const { token, device } = (await reply.json()) as { token: string; device: string };
    return { account: account.id, token, device };
  };
  return { base, post, accounts, phone, errors };
}

type Started = Awaited<ReturnType<typeof start>>;
const hello = { releases: ["1.0"], app: "t" };

/** A sync client of one token, speaking the wire protocol directly. */
function client(post: Started["post"], token: string, extra: Record<string, string> = {}) {
  const headers = { authorization: `Bearer ${token}`, ...extra };
  return {
    hello: () => post("/sync/hello", hello, headers),
    async lineage() {
      const reply = await post("/sync/hello", hello, headers);
      return ((await reply.json()) as { lineage: string }).lineage;
    },
    async push(id: string, title: string) {
      const lineage = await this.lineage();
      const content = workout(title, { initialPlan: null });
      const submission = {
        submissionId: `s-${id}`,
        op: "put",
        kind: "workout",
        id,
        baseRevision: null,
        content,
      };
      return post("/sync/push", { release: "1.0", lineage, submissions: [submission] }, headers);
    },
    async titles(): Promise<string[]> {
      const lineage = await this.lineage();
      const reply = await post("/sync/pull", { release: "1.0", lineage, cursor: 0 }, headers);
      expect(reply.status).toBe(200);
      const { changes } = (await reply.json()) as { changes: { content?: { title: string } }[] };
      return changes.map((change) => change.content?.title ?? "").sort();
    },
  };
}

/**
 * Two accounts on one server, each with a phone. Whatever a request claims besides its token, it
 * reaches the token's account and no other. Throws when the server lets one account see or change
 * the other's data.
 */
async function checkAccountsStaySeparate(server: Started) {
  const alice = await server.phone("Alice");
  const bob = await server.phone("Bob");
  const asAlice = client(server.post, alice.token);
  const asBob = client(server.post, bob.token);
  expect((await asAlice.push("w-alice", "Alice's workout")).status).toBe(200);
  expect((await asBob.push("w-bob", "Bob's workout")).status).toBe(200);

  // Naming the other account, the way the benchmark and the Worker's admin routes do, changes
  // nothing: Alice's token still reaches Alice only.
  const aliceClaimingBob = client(server.post, alice.token, { "x-leve-account": bob.account });
  expect((await aliceClaimingBob.push("w-sneaky", "Written by Alice")).status).toBe(200);
  const seen = {
    "Alice naming Bob": await aliceClaimingBob.titles(),
    Alice: await asAlice.titles(),
    Bob: await asBob.titles(),
  };
  const expected = {
    "Alice naming Bob": ["Alice's workout", "Written by Alice"],
    Alice: ["Alice's workout", "Written by Alice"],
    Bob: ["Bob's workout"],
  };
  if (JSON.stringify(seen) !== JSON.stringify(expected)) {
    throw new Error(`accounts mixed: ${JSON.stringify(seen)}`);
  }
}

describe("a self-hosted server with accounts", () => {
  it("keeps each account's data to its own phones", async () => {
    await checkAccountsStaySeparate(await start());
  });

  it("catches a server that trusts the account a request names (broken variant)", async () => {
    const trustsHeader = (accounts: Accounts) => {
      const real = bearerAuthentication(deviceAuthenticator(accounts));
      return async (request: IncomingMessage): Promise<AuthOutcome> => {
        const outcome = await real(request);
        const named = request.headers["x-leve-account"];
        if (!("principal" in outcome) || typeof named !== "string") return outcome;
        return { principal: { ...outcome.principal, account: named } };
      };
    };
    await expect(
      checkAccountsStaySeparate(await start({ authenticate: trustsHeader })),
    ).rejects.toThrow("accounts mixed");
  });

  it("refuses requests without a token of a paired phone, and phones signed out", async () => {
    const server = await start();
    const alice = await server.phone("Alice");
    const refused = async (headers: Record<string, string>) => {
      const reply = await server.post("/sync/hello", hello, headers);
      expect(reply.status).toBe(401);
      expect(await reply.json()).toMatchObject({ error: { code: "unauthorized" } });
    };
    await refused({});
    await refused({ authorization: alice.token });
    await refused({ authorization: `Basic ${alice.token}` });
    await refused({ authorization: `Bearer ${alice.token}x` });
    // The benchmark's shared token and account header mean nothing here.
    await refused({ authorization: `Bearer ${TOKEN}`, "x-leve-account": alice.account });
    expect((await client(server.post, alice.token).hello()).status).toBe(200);

    server.accounts.revokeDevice(alice.device);
    await refused({ authorization: `Bearer ${alice.token}` });
    // Nor does a code that paired a phone work as a token.
    const { code } = server.accounts.createPairing("Alice");
    await refused({ authorization: `Bearer ${code}` });
  });

  it("pairs a phone once per code, even when two try at the same time", async () => {
    const server = await start();
    server.accounts.addAccount("Alice");
    const { code } = server.accounts.createPairing("Alice");
    const replies = await Promise.all(
      [1, 2, 3].map(() => server.post("/auth/pair", { code, device: "phone" })),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    expect(server.accounts.listDevices("Alice")).toHaveLength(1);
  });

  it("answers bad pairing requests, and lets a good code in however many bad ones came first", async () => {
    const server = await start();
    server.accounts.addAccount("Alice");
    expect((await server.post("/auth/pair", { device: "x" })).status).toBe(400);
    expect((await server.post("/auth/pair", { code: 5 })).status).toBe(400);
    const notJson = await fetch(`${server.base}/auth/pair`, { method: "POST", body: "code=x" });
    expect(notJson.status).toBe(400);
    const tooLarge = await server.post("/auth/pair", { code: "x", device: "y".repeat(5000) });
    expect(tooLarge.status).toBe(400);
    // Codes have 128 random bits, so nothing limits guesses: a shared limit would let anyone
    // keep every new phone from pairing.
    for (let i = 0; i < 50; i++) {
      expect((await server.post("/auth/pair", { code: `guess${i}` })).status).toBe(401);
    }
    const { code } = server.accounts.createPairing("Alice");
    expect((await server.post("/auth/pair", { code })).status).toBe(200);
  });

  it("stops pairing when turned off, and paired phones keep syncing", async () => {
    const server = await start({ pairingOff: true });
    server.accounts.addAccount("Alice");
    const paired = server.accounts.pair(server.accounts.createPairing("Alice").code, "old");
    const { code } = server.accounts.createPairing("Alice");
    const reply = await server.post("/auth/pair", { code });
    expect(reply.status).toBe(403);
    expect(await reply.json()).toMatchObject({ error: { code: "pairing_off" } });
    expect((await client(server.post, paired?.token ?? "").hello()).status).toBe(200);
  });

  it("serves no administration on the public listener", async () => {
    const server = await start();
    const alice = await server.phone("Alice");
    for (const path of ["/admin/stats", "/accounts/list", "/pair", "/devices/list"]) {
      const reply = await server.post(path, {}, { authorization: `Bearer ${alice.token}` });
      expect(reply.status).toBe(400);
      expect(await reply.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("serves the pairing page, which runs only its own script", async () => {
    const server = await start();
    const page = await fetch(`${server.base}/connect`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(CONNECT_PAGE);
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("the benchmark server", () => {
  const benchmarkPost = (server: Started, path: string, token = TOKEN) =>
    server.post(path, path === "/sync/hello" ? hello : {}, {
      authorization: `Bearer ${token}`,
      "x-leve-account": "acc",
    });

  it("answers sync and stats with its timing header, and refuses a wrong token", async () => {
    const server = await start({ benchmark: true });
    const reply = await benchmarkPost(server, "/sync/hello");
    expect(reply.status).toBe(200);
    expect(Number(reply.headers.get("x-server-ms"))).toBeGreaterThanOrEqual(0);
    const stats = await benchmarkPost(server, "/admin/stats");
    expect(await stats.json()).toMatchObject({ revision: 0, records: 0 });
    expect((await benchmarkPost(server, "/admin/stats", "x".repeat(64))).status).toBe(401);
    // No pairing: the benchmark has no accounts.
    expect((await server.post("/auth/pair", { code: "x" })).status).toBe(400);
  });

  it("answers 503 when an account can't be opened, and keeps serving", async () => {
    // The account files can't be created in a read-only directory.
    const server = await start({ benchmark: true, prepare: (dir) => chmodSync(dir, 0o500) });
    expect((await benchmarkPost(server, "/admin/stats")).status).toBe(503);
    expect((await benchmarkPost(server, "/admin/stats")).status).toBe(503);
    expect((await benchmarkPost(server, "/sync/hello")).status).toBe(503);
    expect(server.errors.length).toBe(3);
  });
});
