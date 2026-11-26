// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  type Authenticator,
  allows,
  authenticateBearer,
  bearerToken,
  type Principal,
  SCOPES,
} from "../src/server/index.ts";

const device: Principal = { account: "user_a", client: { kind: "device", id: "sess_1" } };
const agent = (scopes: string[]): Principal => ({
  account: "user_a",
  client: { kind: "agent", id: "https://client.test/meta.json", name: "Coach" },
  scopes,
});

/** Accepts exactly one token, as `principal`. */
const only =
  (token: string, principal: Principal): Authenticator =>
  async (given) =>
    given === token ? { principal } : { refused: true };

describe("bearer tokens", () => {
  it("reads the token after the scheme, in any case", () => {
    expect(bearerToken("Bearer abc.def-_~+/=")).toBe("abc.def-_~+/=");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("BEARER  abc ")).toBe("abc");
  });

  it("finds no token in other schemes, empty headers or tokens with spaces", () => {
    for (const header of [
      null,
      undefined,
      "",
      "Bearer",
      "Bearer ",
      "Basic dXNlcjpwYXNz",
      "Bearerabc",
      "Bearer abc def",
      "Bearer abc\ndef",
      "Bearer abé",
      " Bearer abc",
    ]) {
      expect(bearerToken(header), String(header)).toBe("");
    }
  });
});

describe("authenticating a request", () => {
  it("hands back the principal the authenticator vouches for", async () => {
    expect(await authenticateBearer(only("good", device), "Bearer good")).toEqual({
      principal: device,
    });
    expect(await authenticateBearer(only("good", device), "Bearer bad")).toEqual({ refused: true });
  });

  it("refuses a request without a token without asking the authenticator", async () => {
    let asked = 0;
    const counting: Authenticator = async () => {
      asked += 1;
      return { principal: device };
    };
    expect(await authenticateBearer(counting, null)).toEqual({ refused: true });
    expect(await authenticateBearer(counting, "Basic Z29vZA==")).toEqual({ refused: true });
    expect(asked).toBe(0);
  });

  it("turns a failing authenticator into unavailable, never a way in", async () => {
    const errors: unknown[] = [];
    const broken: Authenticator = async () => {
      throw new Error("key can't be read");
    };
    expect(await authenticateBearer(broken, "Bearer good", (e) => errors.push(e))).toEqual({
      unavailable: true,
    });
    expect(errors).toHaveLength(1);
    // A failing error hook changes nothing.
    expect(
      await authenticateBearer(broken, "Bearer good", () => {
        throw new Error("hook");
      }),
    ).toEqual({ unavailable: true });
  });

  it("passes unavailable on as it is", async () => {
    expect(await authenticateBearer(async () => ({ unavailable: true }), "Bearer x")).toEqual({
      unavailable: true,
    });
  });

  it("refuses a principal naming an account id storage would refuse", async () => {
    for (const account of ["", "../user_b", "user b", "a".repeat(65), 42 as unknown as string]) {
      const principal = { ...device, account };
      expect(await authenticateBearer(only("t", principal), "Bearer t"), String(account)).toEqual({
        refused: true,
      });
    }
  });

  it("treats an answer that isn't an outcome as unavailable, and reports it", async () => {
    const throwing = {
      get principal() {
        throw new Error("getter");
      },
    };
    for (const answer of [
      null,
      undefined,
      {},
      "yes",
      { refused: false },
      { ok: true },
      // Two answers at once, or one only inherited, is not an outcome.
      { principal: device, refused: true },
      Object.create({ principal: device }),
      throwing,
    ]) {
      const errors: unknown[] = [];
      const odd = (async () => answer) as unknown as Authenticator;
      expect(
        await authenticateBearer(odd, "Bearer t", (e) => errors.push(e)),
        String(answer),
      ).toEqual({
        unavailable: true,
      });
      expect(errors).toHaveLength(1);
    }
  });

  it("refuses principals that aren't well formed", async () => {
    const bad = [
      null,
      { account: "user_a" },
      { ...device, client: { kind: "device", id: "" } },
      { ...device, client: { kind: "device" } },
      { ...device, client: { kind: "agent", id: "c", name: 7 } },
      // An OAuth scope claim passed through as one string would make includes() a substring match.
      { ...agent([]), scopes: "leve:write-drafts" },
      { ...agent([]), scopes: [SCOPES.read, 7] },
      // A device with scopes would look limited, but devices reach everything.
      { ...device, scopes: [SCOPES.read] },
    ];
    for (const principal of bad) {
      expect(
        await authenticateBearer(only("t", principal as unknown as Principal), "Bearer t"),
        JSON.stringify(principal),
      ).toEqual({ refused: true });
    }
  });

  it("hands back only the fields the seam defines", async () => {
    const extra = { ...agent([SCOPES.read]), admin: true } as unknown as Principal;
    const outcome = await authenticateBearer(only("t", extra), "Bearer t");
    expect(outcome).toEqual({ principal: agent([SCOPES.read]) });
  });

  it("refuses a principal of an unknown client kind", async () => {
    const principal = { ...device, client: { kind: "admin", id: "x" } } as unknown as Principal;
    expect(await authenticateBearer(only("t", principal), "Bearer t")).toEqual({ refused: true });
  });
});

describe("scopes", () => {
  it("lets a device do everything in its account", () => {
    expect(allows(device, SCOPES.read)).toBe(true);
    expect(allows(device, SCOPES.write)).toBe(true);
  });

  it("lets an agent do only what it was granted, writing including reading", () => {
    expect(allows(agent([]), SCOPES.read)).toBe(false);
    expect(allows(agent(["profile"]), SCOPES.read)).toBe(false);
    expect(allows(agent([SCOPES.read]), SCOPES.read)).toBe(true);
    expect(allows(agent([SCOPES.read]), SCOPES.write)).toBe(false);
    expect(allows(agent([SCOPES.write]), SCOPES.read)).toBe(true);
    expect(allows(agent([SCOPES.write]), SCOPES.write)).toBe(true);
  });

  it("never matches part of a scope", () => {
    const sneaky = { ...agent([]), scopes: "leve:write-drafts" as unknown as string[] };
    expect(allows(sneaky, SCOPES.write)).toBe(false);
    expect(allows(sneaky, SCOPES.read)).toBe(false);
  });

  it("gives an agent without scopes nothing", () => {
    const bare: Principal = { account: "user_a", client: { kind: "agent", id: "c" } };
    expect(allows(bare, SCOPES.read)).toBe(false);
  });
});
