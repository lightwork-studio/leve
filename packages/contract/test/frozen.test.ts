import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeFrozenRelease, exampleMessages } from "../src/frozen.ts";
import {
  CLIENT_RELEASES,
  createContract,
  LEVE_CONTRACT_DEFINITION,
  leveContract,
  type ReleaseId,
  releaseMessages,
  SERVER_RELEASES,
  s,
  validate,
} from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const registry = readJson(join(root, "frozen", "registry.json")) as {
  releases: { release: ReleaseId; files: Record<string, string> }[];
};
const frozenReleases = registry.releases.map((entry) => entry.release);

describe("frozen releases", () => {
  it("lists every frozen directory in the registry with matching digests", () => {
    const directories = readdirSync(join(root, "frozen")).filter(
      (name) => name !== "registry.json",
    );
    expect(directories.sort()).toEqual([...frozenReleases].sort());
    for (const entry of registry.releases) {
      for (const [file, digest] of Object.entries(entry.files)) {
        const actual = createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex");
        expect(actual, file).toBe(digest);
      }
    }
  });

  it("lists every file of a frozen release in its registry entry", () => {
    for (const entry of registry.releases) {
      const files = ["frozen", "history"].flatMap((top) =>
        sourceOrDataFiles(join(root, top, entry.release)).map((file) =>
          file
            .slice(root.length + 1)
            .split(sep)
            .join("/"),
        ),
      );
      expect(files.sort()).toEqual(Object.keys(entry.files).sort());
    }
  });

  it("advertises only frozen releases that have an archived peer", () => {
    for (const release of new Set([...SERVER_RELEASES, ...CLIENT_RELEASES])) {
      expect(frozenReleases).toContain(release);
      expect(existsSync(join(root, "history", release, "peer.ts"))).toBe(true);
    }
  });

  it.each(frozenReleases)("shared definitions still produce frozen release %s", (release) => {
    const frozen = readJson(join(root, "frozen", release, "contract.json"));
    expect(describeFrozenRelease(leveContract, release)).toEqual(frozen);
    expect(readJson(join(root, "history", release, "contract.json"))).toEqual(frozen);
  });

  it.each(frozenReleases)("frozen examples of %s still validate and re-encode", (release) => {
    const examples = readJson(join(root, "frozen", release, "examples.json"));
    const messages = releaseMessages(leveContract, release);
    expect(validate(messages.pushRequest, examples.pushRequest)).toEqual([]);
    expect(validate(messages.pushResponse, examples.pushResponse)).toEqual([]);
    expect(validate(messages.pullRequest, examples.pullRequest)).toEqual([]);
    expect(validate(messages.pullResponse, examples.pullResponse)).toEqual([]);
    for (const submission of examples.pushRequest.submissions) {
      if (submission.op !== "put") continue;
      expect(leveContract.decode(submission.kind, submission.content, release)).toEqual([]);
    }
    expect(exampleMessages(leveContract, release)).toEqual(examples);
  });

  it.each(frozenReleases)("the example page of %s is one the server could send", (release) => {
    const { changes, cursor } = readJson(join(root, "frozen", release, "examples.json"))
      .pullResponse as {
      changes: { kind: string; id: string; revision: number }[];
      cursor: number;
    };
    // Each record at most once, at its latest revision, in revision order up to the cursor.
    const keys = changes.map((change) => `${change.kind}/${change.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const revisions = changes.map((change) => change.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(cursor).toBe(revisions.at(-1));
  });

  it.each(frozenReleases)(
    "the archived %s peer accepts the frozen example exchanges",
    async (release) => {
      const examples = readJson(join(root, "frozen", release, "examples.json"));
      const peer = await import(join(root, "history", release, "peer.ts"));
      const frozen = peer.loadContract(new URL(`../history/${release}/`, import.meta.url));
      for (const [request, response] of [
        [examples.pushRequest, examples.pushResponse],
        [examples.rejectedRequest, examples.rejectedResponse],
      ]) {
        const client = new peer.HistoricalPeer(frozen, async () => ({
          status: 200,
          body: response,
        }));
        client.lineage = request.lineage;
        await expect(client.push(request.submissions)).resolves.toEqual(response);
      }
      const reader = new peer.HistoricalPeer(frozen, async () => ({
        status: 200,
        body: examples.pullResponse,
      }));
      reader.lineage = examples.pullRequest.lineage;
      await expect(reader.pull()).resolves.toHaveLength(examples.pullResponse.changes.length);
    },
  );

  it("gives every field of every release a frozen meaning", () => {
    for (const release of frozenReleases) {
      const frozen = readJson(join(root, "frozen", release, "contract.json"));
      for (const [kind, description] of Object.entries(frozen.kinds) as [
        string,
        { content: { properties: object }; meanings?: Record<string, string> },
      ][]) {
        expect(Object.keys(description.meanings ?? {}).sort(), kind).toEqual(
          Object.keys(description.content.properties).sort(),
        );
      }
    }
  });

  it("keeps the negotiation envelope identical in every release", () => {
    const envelopes = frozenReleases.map(
      (release) => readJson(join(root, "frozen", release, "contract.json")).negotiation,
    );
    for (const envelope of envelopes) expect(envelope).toEqual(envelopes[0]);
  });
});

describe("drift detection", () => {
  const frozen10 = readJson(join(root, "frozen", "1.0", "contract.json"));

  it("is not triggered by adding an optional field in a new minor release", () => {
    const latest = frozenReleases.at(-1);
    if (!latest) throw new Error("Missing frozen release");
    const [major, minor] = latest.split(".");
    const future: ReleaseId = `${Number(major)}.${Number(minor) + 1}`;
    const next = createContract({
      ...LEVE_CONTRACT_DEFINITION,
      releases: [...LEVE_CONTRACT_DEFINITION.releases, future],
      kinds: {
        ...LEVE_CONTRACT_DEFINITION.kinds,
        workout: {
          ...LEVE_CONTRACT_DEFINITION.kinds.workout,
          fields: {
            ...LEVE_CONTRACT_DEFINITION.kinds.workout.fields,
            effortRating: { schema: s.nullable(s.integer(1, 10)), since: future },
          },
        },
      },
    });
    for (const release of frozenReleases) {
      expect(describeFrozenRelease(next, release)).toEqual(
        readJson(join(root, "frozen", release, "contract.json")),
      );
    }
    expect(describeFrozenRelease(next, future).kinds).toHaveProperty(
      "workout.content.properties.effortRating",
    );
  });

  it("catches a changed bound, unit name or enum in a frozen release", () => {
    const mutations = [
      {
        ...LEVE_CONTRACT_DEFINITION.kinds.workout_set.fields,
        reps: { schema: s.nullable(s.integer(0, 99)), since: "1.0" },
      },
      {
        ...LEVE_CONTRACT_DEFINITION.kinds.workout_set.fields,
        weightLbs: LEVE_CONTRACT_DEFINITION.kinds.workout_set.fields.weightKg,
      },
      {
        ...LEVE_CONTRACT_DEFINITION.kinds.workout_set.fields,
        type: {
          schema: s.enumOf(["normal", "warmup", "failure", "drop", "cluster"]),
          since: "1.0",
          required: true,
        },
      },
    ];
    for (const fields of mutations) {
      const mutated = createContract({
        ...LEVE_CONTRACT_DEFINITION,
        kinds: {
          ...LEVE_CONTRACT_DEFINITION.kinds,
          workout_set: { ...LEVE_CONTRACT_DEFINITION.kinds.workout_set, fields },
        },
      } as typeof LEVE_CONTRACT_DEFINITION);
      expect(describeFrozenRelease(mutated, "1.0")).not.toEqual(frozen10);
    }
  });
});

const importsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    (match) => match[1] as string,
  );

function sourceOrDataFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceOrDataFiles(path) : [path];
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("historical peers", () => {
  it.each(frozenReleases)("peer %s imports only node built-ins and its own files", (release) => {
    for (const file of sourceFiles(join(root, "history", release))) {
      for (const specifier of importsOf(file)) {
        expect(
          specifier.startsWith("node:") || /^\.\/[^/]+$/.test(specifier),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("are never imported by production code", () => {
    const sources = ["packages", "apps"].flatMap((top) =>
      existsSync(join(repo, top))
        ? readdirSync(join(repo, top)).flatMap((name) =>
            ["src", "scripts"].map((dir) => join(repo, top, name, dir)),
          )
        : [],
    );
    for (const src of sources) {
      if (!existsSync(src)) continue;
      for (const file of sourceFiles(src)) {
        if (/\.test\.tsx?$/.test(file) || file.includes("test-support")) continue;
        for (const specifier of importsOf(file)) {
          expect(/history|peer\//.test(specifier), `${file} imports ${specifier}`).toBe(false);
        }
      }
    }
  });
});
