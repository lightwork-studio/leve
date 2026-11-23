/*
 * Fails when frozen material of a shipped release changes. A file under an append-only path (see
 * frozen-paths.json) that exists on the base ref must still exist, be identical to the base, and be
 * identical to the version it had when its release shipped. Editing a frozen file
 * together with its digest or manifest therefore still fails. `registry.json` files may only be
 * appended to.
 *
 * A release counts as shipped once frozen-paths.json lists it under `shipped`, on the base or in
 * the candidate. Until then nobody keeps real data in it, so changes to its material are reported
 * as warnings and the release can be frozen again.
 *
 * Base ref: FROZEN_BASE_REF, else origin/$GITHUB_BASE_REF in pull requests, else HEAD.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = "frozen-paths.json";

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function gitText(cwd: string, args: string[]): string {
  return git(cwd, args).toString("utf8");
}

function showAt(cwd: string, ref: string, file: string): Buffer | null {
  try {
    return git(cwd, ["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

function configList(text: string | null, key: "paths" | "shipped"): string[] {
  if (!text) return [];
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const list = parsed[key];
  return Array.isArray(list) ? list.map(String) : [];
}

function frozenPaths(text: string | null): string[] {
  return configList(text, "paths");
}

/** The release a frozen file belongs to: the first path segment that looks like one. */
function releaseOf(file: string): string | null {
  return file.split("/").find((segment) => /^\d+\.\d+$/.test(segment)) ?? null;
}

type Problem = { release: string | null; message: string };

function registryProblems(file: string, base: Buffer, current: Buffer): Problem[] {
  try {
    type Entry = { release?: unknown };
    const before = JSON.parse(base.toString("utf8")) as { releases: Entry[] };
    const after = JSON.parse(current.toString("utf8")) as { releases: Entry[] };
    if (!Array.isArray(before.releases) || !Array.isArray(after.releases)) {
      return [{ release: null, message: `${file}: registry releases must be a list` }];
    }
    const problems: Problem[] = [];
    before.releases.forEach((entry, index) => {
      if (JSON.stringify(after.releases[index]) !== JSON.stringify(entry)) {
        const release = typeof entry.release === "string" ? entry.release : null;
        problems.push({
          release,
          message: `${file}: the entry for ${release ?? "an unnamed release"} changed; registries are append-only`,
        });
      }
    });
    return problems;
  } catch (error) {
    return [
      { release: null, message: `${file}: unreadable registry (${(error as Error).message})` },
    ];
  }
}

/** Fails for shipped releases; reports changes to releases that haven't shipped as warnings. */
export function frozenReport(
  cwd: string,
  baseRef: string,
): { errors: string[]; warnings: string[] } {
  // Without the base or the full history there is nothing trustworthy to compare with, and the
  // check would pass without looking.
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  } catch {
    return {
      errors: [`base ref ${baseRef} was not found; fetch it before checking`],
      warnings: [],
    };
  }
  if (gitText(cwd, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    return {
      errors: ["the repository is a shallow clone; fetch its full history before checking"],
      warnings: [],
    };
  }
  const found: Problem[] = [];
  // Problems with the configuration itself always count.
  const broken = (message: string) => found.push({ release: null, message });
  const currentConfig = existsSync(join(cwd, CONFIG))
    ? readFileSync(join(cwd, CONFIG), "utf8")
    : null;
  const baseConfig = showAt(cwd, baseRef, CONFIG)?.toString("utf8") ?? null;
  if (baseConfig && !currentConfig) broken(`${CONFIG} was removed`);
  for (const [side, text] of [
    ["base", baseConfig],
    ["candidate", currentConfig],
  ] as const) {
    const listed = text ? (JSON.parse(text) as Record<string, unknown>).shipped : undefined;
    const valid =
      listed === undefined ||
      (Array.isArray(listed) &&
        listed.every((item) => typeof item === "string" && /^\d+\.\d+$/.test(item)));
    if (!valid) broken(`${CONFIG} (${side}): shipped must be a list of releases such as "1.0"`);
  }
  const shipped = new Set([
    ...configList(baseConfig, "shipped"),
    ...configList(currentConfig, "shipped"),
  ]);
  // The commit that shipped each release: the oldest on the base's mainline whose configuration
  // lists it. A shipped file must still match that version, whatever came before it. One pass over
  // the configuration's history finds them all.
  const shipCommits = new Map<string, string>();
  const pending = new Set(shipped);
  const configCommits = gitText(cwd, [
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H",
    baseRef,
    "--",
    CONFIG,
  ])
    .split("\n")
    .filter(Boolean);
  for (const hash of configCommits) {
    if (pending.size === 0) break;
    let listed: string[] = [];
    try {
      listed = configList(showAt(cwd, hash, CONFIG)?.toString("utf8") ?? null, "shipped");
    } catch {
      continue;
    }
    for (const release of listed) {
      if (pending.delete(release)) shipCommits.set(release, hash);
    }
  }
  const shipCommitOf = (release: string): string | null => shipCommits.get(release) ?? null;
  // A release can only ship once it is frozen: listing it earlier would bind files that don't
  // exist yet and lock every later change.
  const registered = new Set<string>();
  for (const root of [...new Set([...frozenPaths(baseConfig), ...frozenPaths(currentConfig)])]) {
    const path = join(cwd, root, "registry.json");
    if (!existsSync(path)) continue;
    try {
      const registry = JSON.parse(readFileSync(path, "utf8")) as { releases?: unknown };
      if (!Array.isArray(registry.releases)) continue;
      for (const entry of registry.releases as { release?: unknown }[]) {
        if (typeof entry?.release === "string") registered.add(entry.release);
      }
    } catch {
      // An unreadable registry is reported where it is compared.
    }
  }
  for (const release of shipped) {
    if (!registered.has(release)) {
      broken(`${CONFIG}: release ${release} is listed as shipped but hasn't been frozen`);
    }
  }
  const roots = [...new Set([...frozenPaths(baseConfig), ...frozenPaths(currentConfig)])];
  for (const root of frozenPaths(baseConfig)) {
    if (!frozenPaths(currentConfig).includes(root)) broken(`${CONFIG}: ${root} was removed`);
  }
  for (const root of roots) {
    const listed = gitText(cwd, ["ls-tree", "-r", "--name-only", baseRef, "--", root])
      .split("\n")
      .filter(Boolean);
    for (const file of listed) {
      const path = join(cwd, file);
      const release = releaseOf(file);
      if (!existsSync(path)) {
        found.push({ release, message: `${file}: frozen file was deleted` });
        continue;
      }
      const current = readFileSync(path);
      const base = showAt(cwd, baseRef, file) as Buffer;
      if (file.endsWith("registry.json")) {
        found.push(...registryProblems(file, base, current));
        // Shipped entries must also match the registry as it was when each release shipped.
        for (const entry of shipped) {
          const commit = shipCommitOf(entry);
          const then = commit ? showAt(cwd, commit, file) : null;
          if (then) {
            found.push(...registryProblems(file, then, current).filter((p) => p.release === entry));
          }
        }
        continue;
      }
      if (!current.equals(base)) {
        found.push({ release, message: `${file}: frozen file differs from ${baseRef}` });
        continue;
      }
      // Releases that haven't shipped may be frozen again; one that ships in this change is
      // compared with the base above.
      const commit = release && shipped.has(release) ? shipCommitOf(release) : null;
      if (!commit) continue;
      const original = showAt(cwd, commit, file);
      if (!original || !current.equals(original)) {
        found.push({
          release,
          message: `${file}: changed since release ${release} shipped in ${commit}`,
        });
      }
    }
  }
  for (const release of configList(baseConfig, "shipped")) {
    if (!configList(currentConfig, "shipped").includes(release)) {
      broken(`${CONFIG}: shipped release ${release} was removed from shipped`);
    }
  }
  const binding = (problem: Problem) => problem.release === null || shipped.has(problem.release);
  const unique = (messages: string[]) => [...new Set(messages)];
  return {
    errors: unique(found.filter(binding).map((problem) => problem.message)),
    warnings: unique(
      found
        .filter((problem) => !binding(problem))
        .map((problem) => `${problem.message} (release ${problem.release} hasn't shipped yet)`),
    ),
  };
}

/** The errors only: changes to frozen material of shipped releases, and broken configuration. */
export function checkFrozen(cwd: string, baseRef: string): string[] {
  return frozenReport(cwd, baseRef).errors;
}

export function defaultBaseRef(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FROZEN_BASE_REF) return env.FROZEN_BASE_REF;
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  return "HEAD";
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const cwd = gitText(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const baseRef = defaultBaseRef();
  const { errors, warnings } = frozenReport(cwd, baseRef);
  if (warnings.length > 0) {
    console.warn(
      `Warning: frozen material of unshipped releases changed (compared with ${baseRef}):\n- ${warnings.join("\n- ")}`,
    );
  }
  if (errors.length > 0) {
    console.error(`Frozen material changed (compared with ${baseRef}):\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Frozen material of shipped releases unchanged (compared with ${baseRef}).`);
}
