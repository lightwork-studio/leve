import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { afterAll, describe, expect, it } from "vitest";
import { Accounts, cleanDeviceName, deviceAuthenticator, PAIRING_MS } from "../src/accounts.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function open(now = { t: Date.parse("2026-11-26T08:00:00.000Z") }) {
  const dir = mkdtempSync(join(tmpdir(), "leve-accounts-"));
  dirs.push(dir);
  const engine = createNodeSqliteEngine();
  const path = join(dir, "accounts.db");
  const accounts = Accounts.open({ engine, path, now: () => new Date(now.t) });
  return { accounts, engine, path, now };
}

describe("accounts and pairing", () => {
  it("pairs a phone once per code, and the token signs in as that account only", async () => {
    const { accounts } = open();
    const alice = accounts.addAccount("Alice");
    const bob = accounts.addAccount("Bob");
    const { code } = accounts.createPairing("Alice");
    const paired = accounts.pair(code, "Alice's iPhone");
    expect(paired).toMatchObject({ account: alice.id });
    // The same code never pairs a second phone, not even for the same account.
    expect(accounts.pair(code, "Another phone")).toBeNull();

    const auth = deviceAuthenticator(accounts);
    expect(await auth(paired?.token ?? "")).toEqual({
      principal: {
        account: alice.id,
        client: { kind: "device", id: paired?.device, name: "Alice's iPhone" },
      },
    });
    expect(alice.id).not.toBe(bob.id);
    expect(await auth("not-a-token")).toEqual({ refused: true });
    expect(await auth(code)).toEqual({ refused: true });
  });

  it("refuses an expired code, and clears it", () => {
    const { accounts, now } = open();
    accounts.addAccount("Alice");
    const { code } = accounts.createPairing("Alice");
    now.t += PAIRING_MS;
    expect(accounts.pair(code, "late")).toBeNull();
    now.t -= 1;
    expect(accounts.pair(code, "now it's gone")).toBeNull();
  });

  it("keeps only hashes: neither a code nor a token is stored as given", () => {
    const { accounts } = open();
    accounts.addAccount("Alice");
    const { code } = accounts.createPairing("Alice");
    const second = accounts.createPairing("Alice");
    const paired = accounts.pair(code, "phone");
    const dump = JSON.stringify([
      accounts.db.all("SELECT * FROM devices"),
      accounts.db.all("SELECT * FROM pairings"),
    ]);
    expect(dump).not.toContain(paired?.token);
    expect(dump).not.toContain(second.code);
  });

  it("signs a revoked phone out at once, and revoking all ends open codes too", async () => {
    const { accounts } = open();
    accounts.addAccount("Alice");
    const auth = deviceAuthenticator(accounts);
    const one = accounts.pair(accounts.createPairing("Alice").code, "one");
    const two = accounts.pair(accounts.createPairing("Alice").code, "two");
    expect(accounts.revokeDevice(one?.device ?? "")).toBe(true);
    expect(await auth(one?.token ?? "")).toEqual({ refused: true });
    expect(await auth(two?.token ?? "")).toHaveProperty("principal");

    const pending = accounts.createPairing("Alice");
    expect(accounts.revokeAllDevices("Alice")).toBe(1);
    expect(await auth(two?.token ?? "")).toEqual({ refused: true });
    expect(accounts.pair(pending.code, "three")).toBeNull();
  });

  it("checks account names and refuses duplicates", () => {
    const { accounts } = open();
    accounts.addAccount("Alice");
    expect(() => accounts.addAccount("Alice")).toThrow("already");
    for (const name of ["", " ", "../x", "a/b", "x".repeat(65), "-leading", "tab\there"]) {
      expect(() => accounts.addAccount(name)).toThrow("account name");
    }
    expect(() => accounts.createPairing("Nobody")).toThrow("no account");
  });

  it("reopens what it wrote, and refuses a database from a newer server", () => {
    const { accounts, engine, path } = open();
    const alice = accounts.addAccount("Alice");
    const paired = accounts.pair(accounts.createPairing("Alice").code, "phone");
    accounts.close();

    const again = Accounts.open({ engine, path });
    expect(again.listAccounts()).toEqual([{ ...alice, devices: 1 }]);
    expect(again.deviceForToken(paired?.token ?? "")?.account).toBe(alice.id);
    again.db.run("UPDATE meta SET version = 2");
    again.close();

    const before = readFileSync(path);
    expect(() => Accounts.open({ engine, path, wal: true })).toThrow("newer Leve server");
    expect(readFileSync(path)).toEqual(before);
    // Refusing changed nothing, even when the service requests WAL mode.
    const raw = engine.open(path, { readOnly: true });
    expect(raw.get("SELECT version FROM meta")?.version).toBe(2);
    raw.close();
  });
});

describe("names", () => {
  it("cleans what a phone calls itself before the operator's terminal shows it", () => {
    const { accounts } = open();
    accounts.addAccount("Alice");
    const evil = "\u001b]0;pwned\u0007\u001b[2Jevil\nphone";
    const paired = accounts.pair(accounts.createPairing("Alice").code, evil);
    const [device] = accounts.listDevices("Alice");
    expect(device?.id).toBe(paired?.device);
    expect(device?.name).toBe("]0;pwned [2Jevil phone");
    expect(cleanDeviceName("😀".repeat(70))).toBe("😀".repeat(64));
    expect(cleanDeviceName(" ​\t")).toBe("Phone");
    // Joiners hold emoji sequences and many scripts together.
    expect(cleanDeviceName("\u{1F468}\u200d\u{1F4BB} phone")).toBe(
      "\u{1F468}\u200d\u{1F4BB} phone",
    );
    expect(cleanDeviceName("a\u0007\u200db")).toBe("a \u200db");
  });

  it("never mistakes a name for an id", () => {
    const { accounts } = open();
    const alice = accounts.addAccount("Alice");
    expect(() => accounts.addAccount(alice.id)).toThrow("account name");
    expect(accounts.findAccount(alice.id)?.name).toBe("Alice");
  });

  it("signs every phone of every account out at once", async () => {
    const { accounts } = open();
    accounts.addAccount("Alice");
    accounts.addAccount("Bob");
    const a = accounts.pair(accounts.createPairing("Alice").code, "a");
    const b = accounts.pair(accounts.createPairing("Bob").code, "b");
    const pending = accounts.createPairing("Bob");
    expect(accounts.revokeEveryDevice()).toBe(2);
    const auth = deviceAuthenticator(accounts);
    expect(await auth(a?.token ?? "")).toEqual({ refused: true });
    expect(await auth(b?.token ?? "")).toEqual({ refused: true });
    expect(accounts.pair(pending.code, "c")).toBeNull();
  });
});
