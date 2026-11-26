import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "leve-config-"));
  dirs.push(dir);
  return dir;
};

describe("the server's settings", () => {
  it("runs with accounts unless benchmark mode is asked for by name", () => {
    const cwd = temp();
    expect(readConfig({}, cwd).benchmarkTokenFile).toBeNull();
    // An old benchmark unit with only the token file starts with accounts, and says so.
    const old = readConfig({ LEVE_TOKEN_FILE: "/etc/leve/token" }, cwd);
    expect(old.benchmarkTokenFile).toBeNull();
    expect(old.warnings.join(" ")).toContain("LEVE_TOKEN_FILE is ignored");
    for (const value of ["", "Benchmark", "on", "none"]) {
      expect(() => readConfig({ LEVE_AUTH: value, LEVE_TOKEN_FILE: "/t" }, cwd)).toThrow(
        "unknown LEVE_AUTH",
      );
    }
    expect(() => readConfig({ LEVE_AUTH: "benchmark" }, cwd)).toThrow("needs LEVE_TOKEN_FILE");
    expect(
      readConfig({ LEVE_AUTH: "benchmark", LEVE_TOKEN_FILE: "/t" }, cwd).benchmarkTokenFile,
    ).toBe("/t");
  });

  it("refuses benchmark mode on a directory that holds accounts", () => {
    const cwd = temp();
    mkdirSync(join(cwd, "data"));
    writeFileSync(join(cwd, "data", "accounts.db"), "");
    expect(() => readConfig({ LEVE_AUTH: "benchmark", LEVE_TOKEN_FILE: "/t" }, cwd)).toThrow(
      "holds accounts",
    );
  });

  it("puts the admin socket at an absolute path the CLI finds too", () => {
    const cwd = temp();
    expect(readConfig({}, cwd).socket).toBe(join(cwd, "data", "admin.sock"));
    expect(readConfig({ RUNTIME_DIRECTORY: "/run/leve" }, cwd).socket).toBe("/run/leve/admin.sock");
    expect(readConfig({ LEVE_ADMIN_SOCKET: "38917" }, cwd).socket).toBe(join(cwd, "38917"));
    expect(readConfig({ LEVE_DATA: "/var/lib/leve" }, "/").directory).toBe("/var/lib/leve");
  });

  it("checks the public URL, the pairing switch and the port", () => {
    const cwd = temp();
    expect(readConfig({ LEVE_PUBLIC_URL: "https://sync.example.com/leve" }, cwd).publicUrl).toBe(
      "https://sync.example.com/leve",
    );
    expect(() => readConfig({ LEVE_PUBLIC_URL: "sync.example.com" }, cwd)).toThrow(
      "LEVE_PUBLIC_URL",
    );
    expect(readConfig({ LEVE_PAIRING: "off" }, cwd).pairingOff).toBe(true);
    expect(() => readConfig({ LEVE_PAIRING: "no" }, cwd)).toThrow("LEVE_PAIRING");
    expect(() => readConfig({ PORT: "http" }, cwd)).toThrow("PORT");
  });
});
