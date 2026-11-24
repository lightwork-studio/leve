// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { ACCOUNT_HEADER, type GateEnv, handleRequest } from "./gate.ts";
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

  it("allows a web origin that is configured", async () => {
    const { send, reached } = setup({ CLERK_AUTHORIZED_PARTIES: "https://a.test, https://b.test" });
    expect((await send("/sync/hello", await sign({ azp: "https://b.test" }))).status).toBe(200);
    expect((await send("/sync/hello", await sign({ azp: "https://c.test" }))).status).toBe(401);
    expect(reached).toHaveLength(1);
  });

  it("tolerates a few seconds of clock difference", async () => {
    const token = await sign({ iat: now() + 3, nbf: now() + 3, exp: now() + 60 });
    const config = { issuer: ISSUER, publicKeyPem: trusted.pem };
    expect(await verifySessionToken(token, config)).toEqual({ account: "user_alice" });
    const expiredJustNow = await sign({ exp: now() - 2 });
    expect(await verifySessionToken(expiredJustNow, config)).toEqual({ account: "user_alice" });
    expect(await verifySessionToken(expiredJustNow, config, Date.now() + 10_000)).toBeNull();
  });

  it("is unavailable, not open, when sign-in isn't configured", async () => {
    const { send, reached } = setup({ CLERK_JWT_KEY: undefined });
    expect((await send("/sync/hello", await sign({}))).status).toBe(503);
    expect(reached).toEqual([]);
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

  it("are closed when no operator token is set", async () => {
    const { send, reached } = setup({ ADMIN_TOKEN: undefined });
    expect((await send("/admin/stats", "", { [ACCOUNT_HEADER]: "user_bob" })).status).toBe(401);
    expect(reached).toEqual([]);
  });
});

it("answers only POST to known paths", async () => {
  const { send, reached } = setup();
  expect((await send("/sync/hello", await sign({}), {}, "GET")).status).toBe(400);
  expect((await send("/other", await sign({}))).status).toBe(400);
  expect(reached).toEqual([]);
});
