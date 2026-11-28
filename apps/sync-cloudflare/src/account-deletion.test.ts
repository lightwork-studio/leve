// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  APPLE_AUTH,
  appleClientSecret,
  CLERK_API,
  type DeletionConfig,
  DeletionError,
  deleteSignIn,
  deletionConfig,
} from "./account-deletion.ts";

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const pkcs8 = new Uint8Array(
  (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
);
const PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))
  .match(/.{1,64}/g)
  ?.join("\n")}\n-----END PRIVATE KEY-----`;

const CONFIG: DeletionConfig = {
  clerkSecretKey: "sk_test_secret",
  appleTeamId: "TEAM123456",
  appleKeyId: "KEY1234567",
  applePrivateKey: PEM,
  appleClientId: "app.leve.dev",
};
const APPLE_USER = "001234.abcdef.0001";

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (sub: string) => `${base64Url({ alg: "RS256" })}.${base64Url({ sub })}.sig`;
const decode = (part: string) =>
  JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;

interface Call {
  method: string;
  url: string;
  form?: Record<string, string>;
  authorization?: string | null;
}

/** Clerk's Backend API and Apple's REST API as far as deleting uses them. */
function services({
  user = {
    external_accounts: [{ provider: "oauth_apple", provider_user_id: APPLE_USER }],
  } as Record<string, unknown> | null,
  appleSub = APPLE_USER,
  token = { status: 200 } as { status: number; error?: string },
  revoke = 200,
  clerkDelete = 200,
  clerkDown = false,
} = {}) {
  const calls: Call[] = [];
  let exists = user !== null;
  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const form =
      typeof init.body === "string"
        ? Object.fromEntries(new URLSearchParams(init.body).entries())
        : undefined;
    calls.push({
      method,
      url,
      ...(form ? { form } : {}),
      authorization: headers.get("authorization"),
    });
    const json = (status: number, body: unknown) => Response.json(body, { status });
    if (url.startsWith(CLERK_API)) {
      if (clerkDown) throw new TypeError("fetch failed");
      if (!exists) return json(404, { errors: [{ code: "resource_not_found" }] });
      if (method === "GET") return json(200, user);
      if (method === "DELETE") {
        if (clerkDelete === 200) exists = false;
        return json(clerkDelete, { deleted: clerkDelete === 200 });
      }
    }
    if (url === `${APPLE_AUTH}/token`) {
      if (token.status !== 200) return json(token.status, { error: token.error });
      return json(200, {
        access_token: "access",
        refresh_token: "refresh",
        id_token: idToken(appleSub),
      });
    }
    if (url === `${APPLE_AUTH}/revoke`) return new Response(null, { status: revoke });
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { calls, fetch, deleted: () => !exists };
}

describe("deletionConfig", () => {
  it("needs every secret, so nothing is deleted half configured", () => {
    const env = {
      CLERK_SECRET_KEY: "sk",
      APPLE_TEAM_ID: "T",
      APPLE_KEY_ID: "K",
      APPLE_PRIVATE_KEY: PEM,
      APPLE_CLIENT_ID: "app.leve.dev",
    };
    expect(deletionConfig(env)).not.toBeNull();
    for (const key of Object.keys(env)) {
      expect(deletionConfig({ ...env, [key]: " " }), key).toBeNull();
      expect(deletionConfig({ ...env, [key]: undefined }), key).toBeNull();
    }
  });
});

describe("appleClientSecret", () => {
  it("is an ES256 JWT Apple can verify with the key", async () => {
    const now = Date.UTC(2026, 10, 28, 12);
    const secret = await appleClientSecret(CONFIG, now);
    const [header, claims, signature] = secret.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(decode(claims)).toEqual({
      iss: "TEAM123456",
      iat: now / 1000,
      exp: now / 1000 + 300,
      aud: "https://appleid.apple.com",
      sub: "app.leve.dev",
    });
    const raw = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    expect(raw.length).toBe(64);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      raw,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });
});

describe("deleteSignIn", () => {
  it("revokes the Apple grant, then deletes the Clerk user", async () => {
    const service = services();
    await deleteSignIn(CONFIG, "user_alice", "apple-code", { fetch: service.fetch });
    expect(service.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${CLERK_API}/users/user_alice`,
      `POST ${APPLE_AUTH}/token`,
      `POST ${APPLE_AUTH}/revoke`,
      `DELETE ${CLERK_API}/users/user_alice`,
    ]);
    expect(service.calls[0]?.authorization).toBe("Bearer sk_test_secret");
    const [, exchange, revoke] = service.calls;
    expect(exchange?.form).toMatchObject({
      client_id: "app.leve.dev",
      code: "apple-code",
      grant_type: "authorization_code",
    });
    expect(exchange?.form?.client_secret?.split(".")).toHaveLength(3);
    expect(revoke?.form).toMatchObject({
      client_id: "app.leve.dev",
      token: "refresh",
      token_type_hint: "refresh_token",
    });
    expect(service.deleted()).toBe(true);
  });

  it("counts a user Clerk no longer has as deleted, so a retry after a lost answer succeeds", async () => {
    const service = services({ user: null });
    await deleteSignIn(CONFIG, "user_alice", "apple-code", { fetch: service.fetch });
    expect(service.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("keeps the user when Apple's code belongs to another Apple ID", async () => {
    const service = services({ appleSub: "009999.other.0001" });
    const error = await deleteSignIn(CONFIG, "user_alice", "apple-code", {
      fetch: service.fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeletionError);
    expect((error as DeletionError).reason).toBe("apple");
    expect(service.calls.some((call) => call.url.endsWith("/revoke"))).toBe(false);
    expect(service.deleted()).toBe(false);
  });

  it("asks for a new Apple sign-in when the code was used or expired", async () => {
    const service = services({ token: { status: 400, error: "invalid_grant" } });
    await expect(
      deleteSignIn(CONFIG, "user_alice", "used-code", { fetch: service.fetch }),
    ).rejects.toMatchObject({ reason: "apple" });
    expect(service.deleted()).toBe(false);
  });

  it("refuses without an Apple code while the user signs in with Apple", async () => {
    const service = services();
    await expect(
      deleteSignIn(CONFIG, "user_alice", null, { fetch: service.fetch }),
    ).rejects.toMatchObject({ reason: "apple" });
    expect(service.deleted()).toBe(false);
  });

  it("treats a wrong key or an unrevoked grant as the operator's problem and keeps the user", async () => {
    for (const setup of [
      { token: { status: 400, error: "invalid_client" } },
      { revoke: 500 },
      { clerkDelete: 500 },
    ]) {
      const service = services(setup);
      await expect(
        deleteSignIn(CONFIG, "user_alice", "apple-code", { fetch: service.fetch }),
        JSON.stringify(setup),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(service.deleted(), JSON.stringify(setup)).toBe(false);
    }
  });

  it("deletes a user without Apple sign-in without asking Apple", async () => {
    const service = services({ user: { external_accounts: [] } });
    await deleteSignIn(CONFIG, "user_alice", null, { fetch: service.fetch });
    expect(service.calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(service.deleted()).toBe(true);
  });

  it("says Clerk can't be reached instead of throwing a network error", async () => {
    const service = services({ clerkDown: true });
    await expect(
      deleteSignIn(CONFIG, "user_alice", "apple-code", { fetch: service.fetch }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
});
