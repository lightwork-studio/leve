/*
 * Freezes a protocol release: writes its contract description, example messages and an archived
 * copy of the historical peer. Refuses to touch a release that is already frozen, unless
 * --refreeze is given and the release hasn't shipped (see `shipped` in frozen-paths.json).
 *
 * Usage: pnpm contract:freeze <release> [--refreeze]
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describeFrozenRelease, exampleMessages } from "../src/frozen.ts";
import { leveContract, type ReleaseId } from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv[2] as ReleaseId | undefined;
if (!release || !leveContract.releases.includes(release)) {
  console.error(`usage: freeze.ts <release>; known releases: ${leveContract.releases.join(", ")}`);
  process.exit(2);
}

const frozenDir = join(root, "frozen", release);
const historyDir = join(root, "history", release);
const refreeze = process.argv.includes("--refreeze");
const config = JSON.parse(readFileSync(join(root, "..", "..", "frozen-paths.json"), "utf8")) as {
  shipped?: string[];
};
if ((config.shipped ?? []).includes(release)) {
  console.error(`release ${release} is listed as shipped; shipped releases never change`);
  process.exit(1);
}
if (existsSync(frozenDir) || existsSync(historyDir)) {
  if (!refreeze) {
    console.error(
      `release ${release} is already frozen; pass --refreeze to freeze it again before it ships`,
    );
    process.exit(1);
  }
  rmSync(frozenDir, { recursive: true, force: true });
  rmSync(historyDir, { recursive: true, force: true });
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const written: string[] = [];
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { flag: "wx" });
  written.push(path);
};

const contract = describeFrozenRelease(leveContract, release);
write(join(frozenDir, "contract.json"), pretty(contract));
write(join(frozenDir, "examples.json"), pretty(exampleMessages(leveContract, release)));
mkdirSync(historyDir, { recursive: true });
copyFileSync(join(root, "peer", "peer.ts"), join(historyDir, "peer.ts"));
written.push(join(historyDir, "peer.ts"));
write(join(historyDir, "contract.json"), pretty(contract));

const registryPath = join(root, "frozen", "registry.json");
const registry = existsSync(registryPath)
  ? (JSON.parse(readFileSync(registryPath, "utf8")) as { releases: unknown[] })
  : { releases: [] };
const files: Record<string, string> = {};
for (const path of written) {
  // Registry keys are "/"-separated on every OS, so a freeze on Windows matches one on Linux.
  files[relative(root, path).split(sep).join("/")] = createHash("sha256")
    .update(readFileSync(path))
    .digest("hex");
}
const entry = { release, files };
const existing = registry.releases.findIndex(
  (item) => (item as { release?: unknown }).release === release,
);
if (existing >= 0) registry.releases[existing] = entry;
else registry.releases.push(entry);
writeFileSync(registryPath, pretty(registry));
console.log(`froze ${release}:\n${Object.keys(files).join("\n")}`);
