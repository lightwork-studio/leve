import { beforeEach, describe, expect, it } from "vitest";
import {
  type PairingError,
  pair,
  pairingLinkFrom,
  parsePairingLink,
  serverLabel,
} from "../src/sync/own-server.ts";
import {
  chooseBuiltInServer,
  chooseOwnServer,
  forgetServerChoice,
  ownServer,
  previousServer,
  switchBack,
} from "../src/sync/own-server-store.ts";
import { keychain } from "./support/expo-secure-store.ts";

const CODE = "R0zFbfeNwBJAytY_ILQ3qw";
const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg";

describe("pairing links", () => {
  it("reads the server's page link, the QR code's, with or without a path", () => {
    expect(parsePairingLink(`https://sync.example.com/connect#code=${CODE}`)).toEqual({
      server: "https://sync.example.com",
      code: CODE,
    });
    expect(parsePairingLink(` https://example.com/leve/connect/#code=${CODE} `)).toEqual({
      server: "https://example.com/leve",
      code: CODE,
    });
  });

  it("reads the app link the page opens, in every build", () => {
    for (const scheme of ["leve", "leve-preview", "leve-dev"]) {
      const server = encodeURIComponent("https://sync.example.com/");
      expect(parsePairingLink(`${scheme}://connect?server=${server}&code=${CODE}`)).toEqual({
        server: "https://sync.example.com",
        code: CODE,
      });
    }
  });

  it("refuses anything that isn't a pairing link to an HTTPS server", () => {
    for (const text of [
      "",
      "sync.example.com",
      `http://sync.example.com/connect#code=${CODE}`,
      `https://sync.example.com/elsewhere#code=${CODE}`,
      "https://sync.example.com/connect",
      "https://sync.example.com/connect#code=short",
      `https://sync.example.com/connect#code=${CODE}<script>`,
      `https://user:pw@sync.example.com/connect#code=${CODE}`,
      `other://connect?server=https%3A%2F%2Fx.example&code=${CODE}`,
      `leve://elsewhere?server=https%3A%2F%2Fx.example&code=${CODE}`,
      `leve://connect?server=javascript%3Aalert(1)&code=${CODE}`,
      `leve://connect?server=${encodeURIComponent("https://x.example/?a=1")}&code=${CODE}`,
      // Paths that would make the name the person checks read like another server's.
      `https://evil.example/https://sync.example.com/connect#code=${CODE}`,
      `https://evil.example/@sync.example.com/connect#code=${CODE}`,
      `https://evil.example/sync.example.com:443/connect#code=${CODE}`,
    ]) {
      expect(parsePairingLink(text), text).toBeNull();
    }
    // Plain HTTP only to this machine, for development.
    expect(parsePairingLink(`http://localhost:8787/connect#code=${CODE}`)?.server).toBe(
      "http://localhost:8787",
    );
  });

  it("builds a link from the parts an app link carries", () => {
    expect(pairingLinkFrom("https://sync.example.com//", CODE)).toEqual({
      server: "https://sync.example.com",
      code: CODE,
    });
    expect(pairingLinkFrom("", CODE)).toBeNull();
    expect(pairingLinkFrom("https://sync.example.com", "")).toBeNull();
    expect(pairingLinkFrom(undefined, undefined)).toBeNull();
    expect(serverLabel("https://example.com/leve")).toBe("example.com/leve");
  });
});

describe("pairing", () => {
  const link = { server: "https://sync.example.com", code: CODE };
  const answer =
    (status: number, body: unknown): typeof fetch =>
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("trades the code for this phone's token", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)), redirect: init?.redirect };
      return new Response(
        JSON.stringify({ account: "acc-1", accountName: "Alice", device: "dev-1", token: TOKEN }),
      );
    };
    expect(await pair(link, "Alice's iPhone", fetchFn)).toEqual({
      server: link.server,
      account: "acc-1",
      accountName: "Alice",
      device: "dev-1",
      token: TOKEN,
    });
    expect(sent).toEqual({
      url: "https://sync.example.com/auth/pair",
      body: { code: CODE, device: "Alice's iPhone" },
      redirect: "error",
    });
  });

  it("tells a used code, a server that pairs no one, no answer and a stranger apart", async () => {
    const problem = (fetchFn: typeof fetch) =>
      pair(link, "x", fetchFn).then(
        () => "paired",
        (error: PairingError) => error.problem,
      );
    expect(await problem(answer(401, { error: { code: "unauthorized" } }))).toBe("code");
    expect(await problem(answer(403, { error: { code: "pairing_off" } }))).toBe("off");
    expect(await problem(answer(503, { error: { code: "unavailable" } }))).toBe("offline");
    expect(await problem(answer(502, "<html>Bad gateway</html>"))).toBe("offline");
    expect(
      await problem(async () => {
        throw new TypeError("Network request failed");
      }),
    ).toBe("offline");
    expect(await problem(answer(400, { error: { code: "invalid_request" } }))).toBe("not_leve");
    expect(await problem(answer(404, "<html>Not found</html>"))).toBe("not_leve");
    expect(await problem(answer(200, { ok: true }))).toBe("not_leve");
    // An account id the phone couldn't sync under is not accepted, nor a token it couldn't send.
    expect(await problem(answer(200, { account: "../x", device: "d", token: TOKEN }))).toBe(
      "not_leve",
    );
    expect(await problem(answer(200, { account: "a", device: "d", token: "tok\r\nx: y" }))).toBe(
      "not_leve",
    );
    expect(await problem(answer(200, { account: "a", device: "d", token: "short" }))).toBe(
      "not_leve",
    );
    // An answer that came from somewhere else after a redirect.
    const moved: typeof fetch = async () => {
      const response = new Response(JSON.stringify({ account: "a", device: "d", token: TOKEN }));
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    expect(await problem(moved)).toBe("not_leve");
    // A server that never answers.
    const silent: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    expect(
      await pair(link, "x", silent, 20).then(
        () => "paired",
        (error: PairingError) => error.problem,
      ),
    ).toBe("offline");
  });
});

describe("the server choice", () => {
  const home = { server: "https://home.example", account: "a", device: "d", token: "t" };
  beforeEach(() => {
    keychain.reset();
    forgetServerChoice();
  });

  it("remembers the choice before, to switch back to", () => {
    expect(ownServer()).toBeNull();
    chooseOwnServer(home);
    expect(ownServer()).toEqual(home);
    expect(previousServer()).toBeNull();
    chooseBuiltInServer();
    expect(ownServer()).toBeNull();
    expect(previousServer()).toEqual(home);
    switchBack();
    expect(ownServer()).toEqual(home);
    // It survives the app starting again.
    forgetServerChoice();
    expect(ownServer()).toEqual(home);
  });

  it("changes nothing when the keychain refuses, and reads a damaged entry as none", () => {
    chooseOwnServer(home);
    keychain.failWrites = true;
    expect(() => chooseBuiltInServer()).toThrow();
    expect(ownServer()).toEqual(home);
    keychain.failWrites = false;

    keychain.items.set("sync.ownServer", { value: "{not json", options: undefined });
    forgetServerChoice();
    expect(ownServer()).toBeNull();
    keychain.items.set("sync.ownServer", {
      value: JSON.stringify({ current: { server: "https://x.example" } }),
      options: undefined,
    });
    forgetServerChoice();
    expect(ownServer()).toBeNull();
  });

  it("tries again after a locked keychain instead of forgetting the server", () => {
    chooseOwnServer(home);
    forgetServerChoice();
    keychain.failReads = true;
    expect(ownServer()).toBeNull();
    keychain.failReads = false;
    expect(ownServer()).toEqual(home);
  });
});
