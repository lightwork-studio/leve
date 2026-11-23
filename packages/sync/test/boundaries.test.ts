import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Import boundaries: the HTTP handler and the in-process transport only route to the write
 * service and never touch storage; the phone's sync client (and everything it pulls in) uses no
 * server storage and no Node built-ins.
 */

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const syncSrc = join(packages, "sync", "src");

/** Every module specifier a TypeScript source mentions, including type-only and re-exports. */
export function importsOf(text: string): string[] {
  const pattern =
    /(?:^|[;\s])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  return [...text.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);
}

const WORKSPACE: Record<string, string> = {
  "@leve/contract": join(packages, "contract", "src", "index.ts"),
  "@leve/core": join(packages, "core", "src", "index.ts"),
  "@leve/storage": join(packages, "storage", "src", "index.ts"),
  "@leve/storage/node": join(packages, "storage", "src", "node-sqlite.ts"),
  "@leve/storage/server": join(packages, "storage", "src", "server.ts"),
  "@leve/sync": join(packages, "sync", "src", "index.ts"),
  "@leve/sync/server": join(packages, "sync", "src", "server", "index.ts"),
};

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Every specifier reachable from `entry` through relative and workspace imports. */
function reachable(entry: string): { file: string; specifier: string }[] {
  const seen = new Set<string>();
  const found: { file: string; specifier: string }[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      found.push({ file, specifier });
      const next = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : WORKSPACE[specifier];
      if (next && existsSync(next)) visit(next);
    }
  };
  visit(entry);
  return found;
}

describe("import boundaries", () => {
  it("finds every kind of import, so the rules below can't pass by missing one", () => {
    const sample = [
      'import { a } from "one";',
      'import type { B } from "two";',
      'import * as c from "three";',
      'import "four";',
      'export * from "five";',
      'export { d } from "six";',
      "import {\n  e,\n  type F,\n} from 'seven';",
      'const g = await import("eight");',
    ].join("\n");
    expect(importsOf(sample)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
    ]);
    expect(reachable(join(syncSrc, "server", "http.ts")).length).toBeGreaterThan(0);
  });

  it.each(["http.ts", "in-memory.ts"])("server/%s imports nothing from storage", (name) => {
    const specifiers = importsOf(readFileSync(join(syncSrc, "server", name), "utf8"));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => s.startsWith("@leve/storage"))).toEqual([]);
  });

  it("the client uses no server storage and no Node built-ins, directly or through its imports", () => {
    const entries = filesUnder(join(syncSrc, "client"));
    expect(entries.length).toBeGreaterThan(0);
    for (const file of entries) {
      const bad = reachable(file).filter(
        ({ specifier }) =>
          specifier.startsWith("node:") ||
          specifier === "@leve/storage/server" ||
          specifier === "@leve/storage/node" ||
          specifier.startsWith("@leve/sync/server") ||
          /(^|\/)server(\/|\.ts$|$)/.test(specifier),
      );
      expect(bad, file).toEqual([]);
    }
  });
});
