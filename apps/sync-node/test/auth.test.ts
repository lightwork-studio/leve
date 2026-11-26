import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { sharedTokenAuth } from "../src/auth.ts";

const TOKEN = "a".repeat(64);
const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe("the benchmark's shared token sign-in", () => {
  const authenticate = sharedTokenAuth(TOKEN);

  it("gives the named account to a request with the token", () => {
    expect(
      authenticate(request({ authorization: `Bearer ${TOKEN}`, "x-leve-account": "acc_1-x" })),
    ).toEqual({ principal: { account: "acc_1-x", client: { kind: "device", id: "benchmark" } } });
  });

  it("refuses a missing, wrong or shortened token", () => {
    const refused = { refused: true };
    expect(authenticate(request({ "x-leve-account": "a" }))).toEqual(refused);
    expect(
      authenticate(request({ authorization: `Bearer ${"b".repeat(64)}`, "x-leve-account": "a" })),
    ).toEqual(refused);
    expect(
      authenticate(request({ authorization: `Bearer ${TOKEN.slice(1)}`, "x-leve-account": "a" })),
    ).toEqual(refused);
  });

  it("refuses account names that could leave the data directory", () => {
    for (const account of ["", "../x", "a/b", "a".repeat(65)]) {
      expect(
        authenticate(request({ authorization: `Bearer ${TOKEN}`, "x-leve-account": account })),
      ).toEqual({ refused: true });
    }
  });

  it("refuses to start with a short token", () => {
    expect(() => sharedTokenAuth("short")).toThrow("long and random");
  });
});
