import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const planner = fileURLToPath(
  new URL("../../../.github/scripts/requires-ios-check.sh", import.meta.url),
);

it("requires the native check for committed iOS inputs and fails when the PR base is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "leve-native-scope-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const commit = (file: string, body: string) => {
      const path = join(cwd, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      git("add", "--", file);
      git("commit", "-qm", file);
      return git("rev-parse", "HEAD");
    };
    const requiresIos = (base: string) =>
      execFileSync("bash", [planner, base], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

    git("init", "-q", "-b", "main");
    git("config", "user.name", "Leve Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    const main = commit("README.md", "initial");
    const docs = commit("docs/example.md", "a docs-only change");
    expect(requiresIos(main)).toBe("false");

    const activity = commit("apps/mobile/src/activity/frame.ts", "a native activity change");
    expect(requiresIos(docs)).toBe("true");
    const patch = commit("patches/example.patch", "a change to a build input");
    expect(requiresIos(activity)).toBe("true");

    const expo = commit("apps/mobile/app.config.ts", "a change to Expo configuration");
    expect(requiresIos(patch)).toBe("true");
    commit("apps/mobile/react-native.config.js", "a change to native autolinking");
    expect(requiresIos(expo)).toBe("true");
    expect(() => requiresIos("missing-base")).toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
