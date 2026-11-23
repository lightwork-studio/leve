import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFrozen, defaultBaseRef, frozenReport } from "../scripts/check-frozen.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(shipped: string[] = ["1.0"]) {
  const cwd = mkdtempSync(join(tmpdir(), "leve-frozen-"));
  dirs.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped }));
  write("frozen/1.0/contract.json", '{"a":1}\n');
  write(
    "frozen/registry.json",
    JSON.stringify({ releases: [{ release: "1.0", files: { x: "d1" } }] }),
  );
  commit("freeze 1.0");
  return { cwd, git, write, commit, rm: (file: string) => rmSync(join(cwd, file)) };
}

describe("frozen file check", () => {
  it("refuses to pass without its base or the full history", () => {
    const r = repo();
    expect(checkFrozen(r.cwd, "origin/nope")).toEqual([
      "base ref origin/nope was not found; fetch it before checking",
    ]);
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    r.commit("edit a frozen file");
    const shallow = mkdtempSync(join(tmpdir(), "leve-frozen-"));
    dirs.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${r.cwd}`, shallow]);
    expect(checkFrozen(shallow, "HEAD")).toEqual([
      "the repository is a shallow clone; fetch its full history before checking",
    ]);
  });

  it("passes when frozen files are untouched and new releases are added", () => {
    const r = repo();
    r.write("frozen/1.1/contract.json", '{"b":1}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({
        releases: [
          { release: "1.0", files: { x: "d1" } },
          { release: "1.1", files: { y: "d2" } },
        ],
      }),
    );
    expect(checkFrozen(r.cwd, "HEAD")).toEqual([]);
  });

  it("fails on an edited, deleted or rewritten-registry frozen file", () => {
    const r = repo();
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    expect(checkFrozen(r.cwd, "HEAD")).toEqual([
      "frozen/1.0/contract.json: frozen file differs from HEAD",
    ]);
    r.rm("frozen/1.0/contract.json");
    expect(checkFrozen(r.cwd, "HEAD")[0]).toMatch(/was deleted/);
    r.write("frozen/1.0/contract.json", '{"a":1}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({ releases: [{ release: "1.0", files: { x: "d9" } }] }),
    );
    expect(checkFrozen(r.cwd, "HEAD")[0]).toMatch(/append-only/);
  });

  it("still fails after the edit and its digest were committed together", () => {
    const r = repo();
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({ releases: [{ release: "1.0", files: { x: "d2" } }] }),
    );
    r.commit("rewrite history and digest");
    const problems = checkFrozen(r.cwd, "HEAD");
    expect(problems.some((problem) => /changed since release 1\.0 shipped/.test(problem))).toBe(
      true,
    );
  });

  it("cannot be switched off by removing a path from the configuration", () => {
    const r = repo();
    r.write("frozen-paths.json", JSON.stringify({ paths: [] }));
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    const problems = checkFrozen(r.cwd, "HEAD");
    expect(problems).toContain("frozen-paths.json: frozen was removed");
    expect(problems).toContain("frozen/1.0/contract.json: frozen file differs from HEAD");
  });

  it("only warns about releases that haven't shipped, which can be frozen again", () => {
    const r = repo([]);
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({ releases: [{ release: "1.0", files: { x: "d2" } }] }),
    );
    r.commit("freeze 1.0 again");
    r.write("frozen/1.0/contract.json", '{"a":3}\n');
    const report = frozenReport(r.cwd, "HEAD");
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      "frozen/1.0/contract.json: frozen file differs from HEAD (release 1.0 hasn't shipped yet)",
    ]);
  });

  it("binds a release once shipped, on either side, and never unships it", () => {
    const r = repo([]);
    // Shipping it in the same change already makes it binding.
    r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped: ["1.0"] }));
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    expect(checkFrozen(r.cwd, "HEAD")).toEqual([
      "frozen/1.0/contract.json: frozen file differs from HEAD",
    ]);
    r.write("frozen/1.0/contract.json", '{"a":1}\n');
    r.commit("ship 1.0");
    r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"] }));
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    expect(checkFrozen(r.cwd, "HEAD")).toEqual([
      "frozen/1.0/contract.json: frozen file differs from HEAD",
      "frozen-paths.json: shipped release 1.0 was removed from shipped",
    ]);
  });

  it("ships a release that was frozen again, and binds it from then on", () => {
    const r = repo([]);
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({ releases: [{ release: "1.0", files: { x: "d2" } }] }),
    );
    r.commit("freeze 1.0 again");
    r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped: ["1.0"] }));
    r.commit("ship 1.0");
    expect(frozenReport(r.cwd, "HEAD")).toEqual({ errors: [], warnings: [] });
    // Once shipped, an edit committed together with its digest still fails.
    r.write("frozen/1.0/contract.json", '{"a":3}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({ releases: [{ release: "1.0", files: { x: "d3" } }] }),
    );
    r.commit("edit shipped 1.0");
    expect(checkFrozen(r.cwd, "HEAD")).toEqual([
      expect.stringMatching(/^frozen\/1\.0\/contract\.json: changed since release 1\.0 shipped/),
      "frozen/registry.json: the entry for 1.0 changed; registries are append-only",
    ]);
  });

  it("refuses a shipped list it can't read", () => {
    for (const shipped of [[1.0], ["v1.0"], [" 1.0"], "1.0"]) {
      const r = repo();
      r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped }));
      expect(checkFrozen(r.cwd, "HEAD"), JSON.stringify(shipped)).toContain(
        'frozen-paths.json (candidate): shipped must be a list of releases such as "1.0"',
      );
    }
  });

  it("maps registry entries to the release the base names", () => {
    const r = repo();
    r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped: ["1.0"] }));
    r.write(
      "frozen/registry.json",
      JSON.stringify({
        releases: [
          { release: "1.0", files: { x: "d1" } },
          { release: "1.1", files: { y: "d2" } },
          { files: { z: "d3" } },
        ],
      }),
    );
    r.commit("add 1.1 and an unnamed entry");
    const rewrite = (releases: unknown) => {
      r.write("frozen/registry.json", JSON.stringify({ releases }));
      return frozenReport(r.cwd, "HEAD");
    };
    // An unshipped entry may be rewritten when its release is frozen again.
    expect(
      rewrite([
        { release: "1.0", files: { x: "d1" } },
        { release: "1.1", files: { y: "d9" } },
        { files: { z: "d3" } },
      ]),
    ).toMatchObject({
      errors: [],
      warnings: [expect.stringMatching(/release 1\.1 hasn't shipped/)],
    });
    // A shipped entry can't be relabelled, and an unnamed one always counts.
    expect(
      rewrite([
        { release: "9.9", files: { x: "d1" } },
        { release: "1.1", files: { y: "d2" } },
        { files: { z: "d9" } },
      ]).errors,
    ).toEqual([
      "frozen-paths.json: release 1.0 is listed as shipped but hasn't been frozen",
      "frozen/registry.json: the entry for 1.0 changed; registries are append-only",
      "frozen/registry.json: the entry for an unnamed release changed; registries are append-only",
    ]);
    expect(rewrite({ 0: { release: "1.0" }, length: 1 }).errors).toEqual([
      "frozen-paths.json: release 1.0 is listed as shipped but hasn't been frozen",
      "frozen/registry.json: registry releases must be a list",
    ]);
  });

  it("refuses to ship a release that hasn't been frozen", () => {
    const r = repo();
    r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped: ["1.0", "1.1"] }));
    expect(checkFrozen(r.cwd, "HEAD")).toEqual([
      "frozen-paths.json: release 1.1 is listed as shipped but hasn't been frozen",
    ]);
  });

  it("compares with the version that first shipped, not a later change to the list", () => {
    const r = repo();
    // An edit that reached the base without the check, followed by another release shipping.
    r.write("frozen/1.0/contract.json", '{"a":2}\n');
    r.commit("edit shipped 1.0");
    r.write("frozen/1.1/contract.json", '{"b":1}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({
        releases: [
          { release: "1.0", files: { x: "d1" } },
          { release: "1.1", files: { y: "d2" } },
        ],
      }),
    );
    r.commit("freeze 1.1");
    r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped: ["1.0", "1.1"] }));
    r.commit("ship 1.1");
    expect(checkFrozen(r.cwd, "HEAD")).toEqual([
      expect.stringMatching(/^frozen\/1\.0\/contract\.json: changed since release 1\.0 shipped/),
    ]);
  });

  it("lets an unshipped release that existed when another shipped be frozen again", () => {
    const r = repo([]);
    r.write("frozen/1.1/contract.json", '{"b":1}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({
        releases: [
          { release: "1.0", files: { x: "d1" } },
          { release: "1.1", files: { y: "d2" } },
        ],
      }),
    );
    r.write("frozen-paths.json", JSON.stringify({ paths: ["frozen"], shipped: ["1.0"] }));
    r.commit("ship 1.0 with 1.1 frozen");
    r.write("frozen/1.1/contract.json", '{"b":2}\n');
    r.write(
      "frozen/registry.json",
      JSON.stringify({
        releases: [
          { release: "1.0", files: { x: "d1" } },
          { release: "1.1", files: { y: "d9" } },
        ],
      }),
    );
    expect(frozenReport(r.cwd, "HEAD").errors).toEqual([]);
  });

  it("compares pull requests with their target branch", () => {
    expect(defaultBaseRef({ GITHUB_BASE_REF: "integration/data-layer" })).toBe(
      "origin/integration/data-layer",
    );
    expect(defaultBaseRef({ FROZEN_BASE_REF: "abc", GITHUB_BASE_REF: "main" })).toBe("abc");
    expect(defaultBaseRef({})).toBe("HEAD");
  });
});
