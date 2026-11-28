// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_HEADER,
  CLIENT_HEADER,
  type GateEnv,
  handleRequest,
  SCOPES_HEADER,
} from "./gate.ts";
import { verifySessionToken } from "./session-token.ts";

const ISSUER = "https://leve-test.clerk.accounts.dev";
const ADMIN_TOKEN = "operator-token-that-is-long-enough-0123456789";

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const base64 = btoa(String.fromCharCode(...spki));
  const pem = `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----`;
  return { privateKey: pair.privateKey, pem };
}

const trusted = await keyPair();
const stranger = await keyPair();

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

const now = () => Math.floor(Date.now() / 1000);

async function sign(
  claims: Record<string, unknown>,
  { key = trusted.privateKey, header = { alg: "RS256", typ: "JWT" } } = {},
) {
  const body = `${encode(header)}.${encode({
    iss: ISSUER,
    sub: "user_alice",
    sid: "sess_1",
    sts: "active",
    v: 2,
    iat: now(),
    nbf: now() - 5,
    exp: now() + 60,
    ...claims,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${base64Url(new Uint8Array(signature))}`;
}

/** An account namespace that records which object each request reached and what it carried. */
function fakeAccounts() {
  const reached: { account: string; header: string | null; auth: string | null; body: string }[] =
    [];
  const accounts: GateEnv["ACCOUNTS"] = {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) =>
      ({
        fetch: async (request: Request) => {
          reached.push({
            account: (id as unknown as { name: string }).name,
            header: request.headers.get(ACCOUNT_HEADER),
            auth: request.headers.get("authorization"),
            body: await request.text(),
          });
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      }) as unknown as DurableObjectStub,
  };
  return { accounts, reached };
}

function setup(overrides: Partial<GateEnv> = {}) {
  const { accounts, reached } = fakeAccounts();
  const env: GateEnv = {
    ACCOUNTS: accounts,
    CLERK_ISSUER: ISSUER,
    CLERK_JWT_KEY: trusted.pem,
    ADMIN_TOKEN,
    ...overrides,
  };
  const send = (
    path: string,
    token: string | null,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    handleRequest(
      new Request(`https://sync.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...headers,
        },
        ...(method === "POST" ? { body: '{"releases":["1.0"]}' } : {}),
      }),
      env,
    );
  return { send, reached };
}

describe("signing in to sync", () => {
  it("reaches the signed-in user's own account and passes the body on", async () => {
    const { send, reached } = setup();
    const response = await send("/sync/hello", await sign({}));
    expect(response.status).toBe(200);
    expect(reached).toEqual([
      { account: "user_alice", header: "user_alice", auth: null, body: '{"releases":["1.0"]}' },
    ]);
  });

  it("ignores an account the client names: a user can't reach anyone else's", async () => {
    const { send, reached } = setup();
    const response = await send("/sync/pull", await sign({}), { [ACCOUNT_HEADER]: "user_bob" });
    expect(response.status).toBe(200);
    expect(reached.map((r) => [r.account, r.header])).toEqual([["user_alice", "user_alice"]]);
  });

  it("refuses tokens that aren't this instance's valid session tokens", async () => {
    const forged = await sign({}, { key: stranger.privateKey });
    const valid = await sign({});
    const [header, , signature] = valid.split(".");
    const cases: Record<string, string | null> = {
      "no token": null,
      "not a token": "abc",
      "another key": forged,
      "changed claims": `${header}.${encode({ iss: ISSUER, sub: "user_bob", exp: now() + 60 })}.${signature}`,
      "unsigned (alg none)": `${encode({ alg: "none" })}.${encode({ iss: ISSUER, sub: "user_bob", exp: now() + 60 })}.`,
      "header names another algorithm": await sign({}, { header: { alg: "HS256", typ: "JWT" } }),
      "other issuer": await sign({ iss: "https://someone-else.clerk.accounts.dev" }),
      expired: await sign({ iat: now() - 120, nbf: now() - 120, exp: now() - 60 }),
      "not yet valid": await sign({ nbf: now() + 60, exp: now() + 120 }),
      "no expiry": await sign({ exp: undefined }),
      "unfinished session": await sign({ sts: "pending" }),
      "JWT template (no session)": await sign({ sid: undefined, sts: undefined, v: undefined }),
      "other token version": await sign({ v: 3 }),
      "access token": await sign({}, { header: { alg: "RS256", typ: "at+jwt" } }),
      "unknown critical header": await sign(
        {},
        { header: { alg: "RS256", typ: "JWT", crit: ["x"] } as never },
      ),
      "unknown web origin": await sign({ azp: "https://evil.test" }),
      "odd account id": await sign({ sub: "../user_bob" }),
      "operator token": ADMIN_TOKEN,
    };
    for (const [name, token] of Object.entries(cases)) {
      const { send, reached } = setup();
      const response = await send("/sync/hello", token);
      expect([name, response.status]).toEqual([name, 401]);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
      expect([name, reached]).toEqual([name, []]);
    }
  });

  it("deletes only the signed-in user's own account, and only with a session token", async () => {
    const { send, reached } = setup();
    const response = await send(ACCOUNT_DELETE_PATH, await sign({}), {
      [ACCOUNT_HEADER]: "user_bob",
    });
    expect(response.status).toBe(200);
    expect(reached.map((r) => [r.account, r.header, r.auth])).toEqual([
      ["user_alice", "user_alice", null],
    ]);
    const refused: Record<string, string | null> = {
      "no token": null,
      "operator token": ADMIN_TOKEN,
      "access token": await sign({}, { header: { alg: "RS256", typ: "at+jwt" } }),
      expired: await sign({ iat: now() - 120, nbf: now() - 120, exp: now() - 60 }),
    };
    for (const [name, token] of Object.entries(refused)) {
      const attempt = setup();
      const answer = await attempt.send(ACCOUNT_DELETE_PATH, token, {
        [ACCOUNT_HEADER]: "user_bob",
      });
      expect([name, answer.status]).toEqual([name, 401]);
      expect([name, attempt.reached]).toEqual([name, []]);
    }
  });

  it("allows a web origin that is configured", async () => {
    const { send, reached } = setup({ CLERK_AUTHORIZED_PARTIES: "https://a.test, https://b.test" });
    expect((await send("/sync/hello", await sign({ azp: "https://b.test" }))).status).toBe(200);
    expect((await send("/sync/hello", await sign({ azp: "https://c.test" }))).status).toBe(401);
    expect(reached).toHaveLength(1);
  });

  it("tolerates a few seconds of clock difference", async () => {
    const t = 1_800_000_000;
    const config = { issuer: ISSUER, publicKeyPem: trusted.pem };
    const issued = await sign({ iat: t, nbf: t, exp: t + 60 });
    // Issued by a clock 3 seconds ahead: accepted. Expired 3 seconds ago: still accepted.
    expect(await verifySessionToken(issued, config, (t - 3) * 1000)).toEqual({
      account: "user_alice",
      session: "sess_1",
    });
    expect(await verifySessionToken(issued, config, (t + 63) * 1000)).toEqual({
      account: "user_alice",
      session: "sess_1",
    });
    expect(await verifySessionToken(issued, config, (t - 10) * 1000)).toBeNull();
    expect(await verifySessionToken(issued, config, (t + 70) * 1000)).toBeNull();
  });

  it("accepts the scheme name in any case", async () => {
    const { send } = setup();
    const token = await sign({});
    const response = await handleRequest(
      new Request("https://sync.test/sync/hello", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `bearer ${token}` },
        body: "{}",
      }),
      { ACCOUNTS: fakeAccounts().accounts, CLERK_ISSUER: ISSUER, CLERK_JWT_KEY: trusted.pem },
    );
    expect(response.status).toBe(200);
    expect((await send("/sync/hello", token)).status).toBe(200);
  });

  it("can't reach the admin endpoints through a sync path", async () => {
    const { send, reached } = setup();
    for (const path of ["/sync/../admin/delete", "/sync/%2e%2e/admin/delete"]) {
      const response = await send(path, await sign({}), { "x-leve-account": "user_bob" });
      expect([path, response.status]).toEqual([path, 401]);
    }
    expect(reached).toEqual([]);
  });

  it("is unavailable, not open, when sign-in isn't configured or its key is broken", async () => {
    const broken = "-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----";
    for (const overrides of [
      { CLERK_JWT_KEY: undefined },
      { CLERK_ISSUER: undefined },
      { CLERK_JWT_KEY: broken },
    ]) {
      const { send, reached } = setup(overrides);
      expect((await send("/sync/hello", await sign({}))).status).toBe(503);
      expect(reached).toEqual([]);
    }
  });

  it("still requires JSON after signing in", async () => {
    const { send } = setup();
    const response = await send("/sync/push", await sign({}), { "content-type": "text/plain" });
    expect(response.status).toBe(400);
  });
});

describe("the operator's admin endpoints", () => {
  it("need the operator token and reach the named account", async () => {
    const { send, reached } = setup();
    const response = await send("/admin/stats", ADMIN_TOKEN, { [ACCOUNT_HEADER]: "user_bob" });
    expect(response.status).toBe(200);
    expect(reached.map((r) => [r.account, r.header, r.auth])).toEqual([
      ["user_bob", "user_bob", null],
    ]);
  });

  it("refuse a user's session token, a wrong token, and a missing account", async () => {
    const { send, reached } = setup();
    const asUser = await send("/admin/delete", await sign({}), { [ACCOUNT_HEADER]: "user_alice" });
    expect(asUser.status).toBe(401);
    const wrong = await send("/admin/stats", `${ADMIN_TOKEN}x`, { [ACCOUNT_HEADER]: "user_bob" });
    expect(wrong.status).toBe(401);
    expect((await send("/admin/stats", ADMIN_TOKEN)).status).toBe(400);
    expect(reached).toEqual([]);
  });

  it("take an operator token of any characters, as they always have", async () => {
    const spaced = "operator pass phrase with spaces and ümlauts 0123456789";
    const { send, reached } = setup({ ADMIN_TOKEN: spaced });
    expect((await send("/admin/stats", spaced, { [ACCOUNT_HEADER]: "user_alice" })).status).toBe(
      200,
    );
    expect(
      (await send("/admin/stats", "operator", { [ACCOUNT_HEADER]: "user_alice" })).status,
    ).toBe(401);
    expect(reached).toHaveLength(1);
  });

  it("are closed when no operator token, or a short one, is set", async () => {
    for (const token of [undefined, "short"]) {
      const { send, reached } = setup({ ADMIN_TOKEN: token });
      const response = await send("/admin/stats", token ?? "", { [ACCOUNT_HEADER]: "user_bob" });
      expect(response.status).toBe(401);
      expect(reached).toEqual([]);
    }
  });
});

it("answers only POST to known paths", async () => {
  const { send, reached } = setup();
  expect((await send("/sync/hello", await sign({}), {}, "GET")).status).toBe(400);
  expect((await send("/other", await sign({}))).status).toBe(400);
  expect(reached).toEqual([]);
});

// ——— MCP ———

const RESOURCE = "https://sync.test/mcp";
const METADATA = "https://sync.test/.well-known/oauth-protected-resource/mcp";

/** An OAuth access token as Clerk issues it to an MCP client (RFC 9068). */
function signAccess(
  claims: Record<string, unknown> = {},
  {
    key = trusted.privateKey,
    header = { alg: "RS256", typ: "at+jwt" } as Record<string, unknown>,
  } = {},
) {
  return sign(
    {
      sid: undefined,
      sts: undefined,
      v: undefined,
      aud: [RESOURCE],
      client_id: "https://client.test/meta.json",
      scp: ["leve:read"],
      jti: "oat_1",
      ...claims,
    },
    { key, header: header as { alg: string; typ: string } },
  );
}

function mcpSetup(overrides: Partial<GateEnv> = {}) {
  const reached: { account: string; headers: Record<string, string>; body: string }[] = [];
  const env: GateEnv = {
    ACCOUNTS: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: DurableObjectId) =>
        ({
          fetch: async (request: Request) => {
            reached.push({
              account: (id as unknown as { name: string }).name,
              headers: Object.fromEntries(request.headers),
              body: await request.text(),
            });
            return new Response("{}", { headers: { "content-type": "application/json" } });
          },
        }) as unknown as DurableObjectStub,
    },
    CLERK_ISSUER: ISSUER,
    CLERK_JWT_KEY: trusted.pem,
    ADMIN_TOKEN,
    MCP_RESOURCE_URL: RESOURCE,
    ...overrides,
  };
  const send = (
    token: string | null,
    {
      path = "/mcp",
      headers = {},
      method = "POST",
    }: { path?: string; headers?: Record<string, string>; method?: string } = {},
  ) =>
    handleRequest(
      new Request(`https://sync.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...headers,
        },
        ...(method === "POST" ? { body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' } : {}),
      }),
      env,
    );
  return { send, reached, env };
}

describe("signing in to MCP", () => {
  it("reaches the token's user's account as an agent with its scopes, whatever the client names", async () => {
    const { send, reached } = mcpSetup();
    const response = await send(await signAccess({ sub: "user_alice" }), {
      headers: {
        [ACCOUNT_HEADER]: "user_bob",
        [CLIENT_HEADER]: "phone",
        [SCOPES_HEADER]: "leve:write",
        "X-Leve-Account": "user_carol",
      },
    });
    expect(response.status).toBe(200);
    expect(reached).toHaveLength(1);
    const [forwarded] = reached;
    expect(forwarded?.account).toBe("user_alice");
    expect(forwarded?.headers[ACCOUNT_HEADER]).toBe("user_alice");
    expect(decodeURIComponent(forwarded?.headers[CLIENT_HEADER] ?? "")).toBe(
      "https://client.test/meta.json",
    );
    expect(forwarded?.headers[SCOPES_HEADER]).toBe("leve:read");
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.body).toContain("tools/list");
  });

  it("reads scopes from a space-separated scope claim too", async () => {
    const { send, reached } = mcpSetup();
    const token = await signAccess({ scp: undefined, scope: "profile leve:write" });
    expect((await send(token)).status).toBe(200);
    expect(reached[0]?.headers[SCOPES_HEADER]).toBe("leve:write");
  });

  it("forwards only exact Leve scopes and refuses other browser origins", async () => {
    const { send, reached } = mcpSetup();
    const token = await signAccess({ scp: ["leve:read", "profile leve:write"] });
    expect((await send(token, { headers: { origin: "https://other.test" } })).status).toBe(403);
    expect(reached).toEqual([]);
    expect((await send(token, { headers: { origin: new URL(RESOURCE).origin } })).status).toBe(200);
    expect(reached[0]?.headers[SCOPES_HEADER]).toBe("leve:read");
  });

  it("challenges a client without a token to sign in, naming the metadata and scope", async () => {
    const { send, reached } = mcpSetup();
    const response = await send(null);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer scope="leve:read", resource_metadata="${METADATA}"`,
    );
    expect(reached).toEqual([]);
  });

  it("advertises write access only when the Worker explicitly enables it", async () => {
    for (const value of ["false", "TRUE", "true"]) {
      const { send } = mcpSetup({ MCP_WRITES_ENABLED: value });
      const response = await send(null, {
        method: "GET",
        path: "/.well-known/oauth-protected-resource/mcp",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        scopes_supported: value === "true" ? ["leve:read", "leve:write"] : ["leve:read"],
      });
    }
  });

  it("refuses tokens that aren't access tokens this instance issued for this server", async () => {
    const { send, reached } = mcpSetup();
    const valid = await signAccess();
    const [header, payload, signature] = valid.split(".");
    const refused = [
      // A phone's session token is not an MCP token.
      await sign({}),
      await sign({}, { header: { alg: "RS256", typ: "JWT" } }),
      // Issued for another resource, or for none.
      await signAccess({ aud: ["https://other.test/mcp"] }),
      await signAccess({ aud: "https://sync.test/mcp/" }),
      await signAccess({ aud: undefined }),
      await signAccess({ aud: [] }),
      // Wrong issuer, signer, time, type or algorithm.
      await signAccess({ iss: `${ISSUER}/` }),
      await signAccess({}, { key: stranger.privateKey }),
      await signAccess({ exp: now() - 60 }),
      await signAccess({ nbf: now() + 600 }),
      await signAccess({}, { header: { alg: "RS256", typ: "JWT" } }),
      await signAccess({}, { header: { alg: "RS256" } }),
      await signAccess({}, { header: { alg: "RS256", typ: { toString: null } } }),
      await signAccess({}, { header: { alg: "RS256", typ: "at+jwt", crit: ["x"] } }),
      `${encode({ alg: "none", typ: "at+jwt" })}.${payload}.`,
      `${encode({ alg: "HS256", typ: "at+jwt" })}.${payload}.${signature}`,
      `${header}.${payload}.${signature?.slice(0, -4)}AAAA`,
      // No client, an account id storage would refuse, malformed scopes.
      await signAccess({ client_id: undefined }),
      await signAccess({ client_id: "" }),
      await signAccess({ sub: "../user_bob" }),
      await signAccess({ scp: "leve:read" }),
      await signAccess({ scp: undefined, scope: ["leve:read"] }),
      "not-a-token",
    ];
    for (const token of refused) {
      const response = await send(token);
      expect(response.status, token).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer error="invalid_token", scope="leve:read", resource_metadata="${METADATA}"`,
      );
    }
    expect(reached).toEqual([]);
  });

  it("refuses a token without a Leve scope with a step-up challenge", async () => {
    const { send, reached } = mcpSetup();
    for (const scp of [[], ["profile", "email"], ["leve:reader"]]) {
      const response = await send(await signAccess({ scp }));
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer error="insufficient_scope", scope="leve:read", resource_metadata="${METADATA}"`,
      );
    }
    expect(reached).toEqual([]);
    // Writing includes reading.
    expect((await send(await signAccess({ scp: ["leve:write"] }))).status).toBe(200);
  });

  it("keeps sync for phones: an MCP access token can't sync", async () => {
    const { send, reached } = mcpSetup();
    const response = await send(await signAccess(), { path: "/sync/hello" });
    expect(response.status).toBe(401);
    expect(reached).toEqual([]);
  });

  it("publishes where to sign in and which scopes exist", async () => {
    const { send } = mcpSetup();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const response = await send(null, { path, method: "GET" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ["leve:read"],
        bearer_methods_supported: ["header"],
        resource_name: "Leve",
      });
    }
  });

  it("is off, and sync unaffected, without a resource URL or with a bad one", async () => {
    for (const MCP_RESOURCE_URL of [
      undefined,
      "",
      "http://sync.test/mcp",
      "https://sync.test/",
      "https://sync.test/mcp#x",
      "not a url",
    ]) {
      const { send, reached } = mcpSetup({ MCP_RESOURCE_URL });
      expect((await send(await signAccess())).status, String(MCP_RESOURCE_URL)).toBe(503);
      const metadata = await send(null, {
        path: "/.well-known/oauth-protected-resource/mcp",
        method: "GET",
      });
      expect(metadata.status).toBe(503);
      expect(reached).toEqual([]);
      expect((await send(await sign({}), { path: "/sync/hello" })).status).toBe(200);
    }
  });

  it("is unavailable, not open, when the key is broken or sign-in isn't configured", async () => {
    const broken = "-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----";
    for (const overrides of [
      { CLERK_JWT_KEY: broken },
      { CLERK_JWT_KEY: undefined },
      { CLERK_ISSUER: undefined },
    ]) {
      const { send, reached } = mcpSetup(overrides);
      expect((await send(await signAccess())).status).toBe(503);
      expect(reached).toEqual([]);
    }
  });
});
