// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  APPLE_AUTH,
  appleClientSecret,
  CLERK_API,
  type DeletionConfig,
  DeletionError,
  deleteAccount,
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
  appleClientIds: ["app.leve.dev"],
};
const APPLE_USER = "001234.abcdef.0001";

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (sub: string | null) =>
  `${base64Url({ alg: "RS256" })}.${base64Url(sub === null ? {} : { sub })}.sig`;
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
  appleSub = APPLE_USER as string | null,
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
      APPLE_CLIENT_ID: "app.leve.dev, app.leve.preview",
    };
    expect(deletionConfig(env)?.appleClientIds).toEqual(["app.leve.dev", "app.leve.preview"]);
    for (const key of Object.keys(env)) {
      expect(deletionConfig({ ...env, [key]: " " }), key).toBeNull();
      expect(deletionConfig({ ...env, [key]: undefined }), key).toBeNull();
    }
    expect(deletionConfig({ ...env, APPLE_CLIENT_ID: " , " })).toBeNull();
  });
});

describe("appleClientSecret", () => {
  it("is an ES256 JWT Apple can verify with the key", async () => {
    const now = Date.UTC(2026, 10, 28, 12);
    const secret = await appleClientSecret(CONFIG, "app.leve.dev", now);
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

const CODE = { code: "apple-code", clientId: "app.leve.dev" };

/** Runs a deletion, recording among the calls when the account's data was erased. */
async function run(
  service: ReturnType<typeof services>,
  apple: { code: string; clientId: string | null } | null = CODE,
  config: DeletionConfig = CONFIG,
  erasedBefore = false,
) {
  let erased = false;
  const error = await deleteAccount(
    config,
    "user_alice",
    apple,
    erasedBefore,
    async () => {
      service.calls.push({ method: "ERASE", url: "" });
      erased = true;
    },
    { fetch: service.fetch },
  ).then(
    () => null,
    (e: unknown) => e,
  );
  return { error: error as DeletionError | null, erased };
}

describe("deleteAccount", () => {
  it("checks with Apple first, then erases the data, revokes the grant and deletes the Clerk user", async () => {
    const service = services();
    const { error } = await run(service);
    expect(error).toBeNull();
    expect(service.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${CLERK_API}/users/user_alice`,
      `POST ${APPLE_AUTH}/token`,
      "ERASE ",
      `POST ${APPLE_AUTH}/revoke`,
      `DELETE ${CLERK_API}/users/user_alice`,
    ]);
    expect(service.calls[0]?.authorization).toBe("Bearer sk_test_secret");
    const exchange = service.calls[1];
    const revoke = service.calls[3];
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

  it("redeems the code for the build that asked, among the configured ones", async () => {
    const config = { ...CONFIG, appleClientIds: ["app.leve.dev", "app.leve.preview"] };
    const service = services();
    const preview = await run(service, { code: "c", clientId: "app.leve.preview" }, config);
    expect(preview.error).toBeNull();
    expect(service.calls[1]?.form?.client_id).toBe("app.leve.preview");
    const secret = service.calls[1]?.form?.client_secret ?? "";
    expect(decode(secret.split(".")[1] ?? "").sub).toBe("app.leve.preview");

    const refused = await run(services(), { code: "c", clientId: "com.example.other" }, config);
    expect(refused).toMatchObject({ erased: false, error: { step: "apple" } });
    // Without a bundle id, only a single configured app can be meant.
    const unnamed = await run(services(), { code: "c", clientId: null }, config);
    expect(unnamed).toMatchObject({ erased: false, error: { step: "apple" } });
    expect((await run(services(), { code: "c", clientId: null })).error).toBeNull();
  });

  it("counts a user Clerk no longer has as deleted after an earlier erase, still making sure", async () => {
    const service = services({ user: null });
    const { error, erased } = await run(service, CODE, CONFIG, true);
    expect(error).toBeNull();
    expect(erased).toBe(true);
    expect(service.calls.map((call) => call.method)).toEqual(["GET", "ERASE"]);
  });

  it("deletes nothing when Clerk doesn't know a user nothing was deleted for yet", async () => {
    // Such as a secret key from another Clerk instance.
    const { error, erased } = await run(services({ user: null }));
    expect(error?.step).toBe("configuration");
    expect(erased).toBe(false);
  });

  it("deletes nothing when a code comes for a user without an Apple account", async () => {
    const service = services({ user: { external_accounts: [] } });
    expect(await run(service)).toMatchObject({ erased: false, error: { step: "configuration" } });
    expect(service.deleted()).toBe(false);
  });

  it("deletes nothing when Apple's code belongs to another Apple ID", async () => {
    const service = services({ appleSub: "009999.other.0001" });
    const { error, erased } = await run(service);
    expect(error).toBeInstanceOf(DeletionError);
    expect(error?.step).toBe("apple");
    expect(erased).toBe(false);
    expect(service.calls.some((call) => call.url.endsWith("/revoke"))).toBe(false);
    expect(service.deleted()).toBe(false);
  });

  it("deletes nothing when either side has no Apple user id to compare", async () => {
    const service = services({
      user: { external_accounts: [{ provider: "oauth_apple" }] },
      appleSub: null,
    });
    expect(await run(service)).toMatchObject({ erased: false, error: { step: "apple" } });
    const noSub = services({ appleSub: null });
    expect(await run(noSub)).toMatchObject({ erased: false, error: { step: "apple" } });
  });

  it("deletes nothing when the code was used or expired, or is missing", async () => {
    const used = services({ token: { status: 400, error: "invalid_grant" } });
    expect(await run(used)).toMatchObject({ erased: false, error: { step: "apple" } });
    const junk = services({ token: { status: 400, error: "invalid_request" } });
    expect(await run(junk)).toMatchObject({ erased: false, error: { step: "apple" } });
    const missing = services();
    expect(await run(missing, null)).toMatchObject({ erased: false, error: { step: "apple" } });
    expect(used.deleted() || missing.deleted()).toBe(false);
  });

  it("deletes nothing while the Worker's keys can't be used", async () => {
    const badKey = await run(services(), CODE, { ...CONFIG, applePrivateKey: "not a key" });
    expect(badKey).toMatchObject({ erased: false, error: { step: "configuration" } });
    const badClient = await run(services({ token: { status: 400, error: "invalid_client" } }));
    expect(badClient).toMatchObject({ erased: false, error: { step: "configuration" } });
  });

  it("keeps the user after erasing when revoking or deleting it fails, for a retry to finish", async () => {
    for (const setup of [{ revoke: 500 }, { clerkDelete: 500 }]) {
      const service = services(setup);
      const { error, erased } = await run(service);
      expect(erased, JSON.stringify(setup)).toBe(true);
      expect(error?.step, JSON.stringify(setup)).toBe("sign_in");
      expect(service.deleted(), JSON.stringify(setup)).toBe(false);
    }
  });

  it("deletes a user without Apple sign-in without asking Apple", async () => {
    const service = services({ user: { external_accounts: [] } });
    expect((await run(service, null)).error).toBeNull();
    expect(service.calls.map((call) => call.method)).toEqual(["GET", "ERASE", "DELETE"]);
    expect(service.deleted()).toBe(true);
  });

  it("says Clerk can't be reached, before deleting anything", async () => {
    const { error, erased } = await run(services({ clerkDown: true }));
    expect(error?.step).toBe("unavailable");
    expect(erased).toBe(false);
  });
});
