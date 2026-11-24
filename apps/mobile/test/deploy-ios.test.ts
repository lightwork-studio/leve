import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";

it("numbers consecutive Preview builds and updates", { timeout: 30_000 }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "leve-deploy-ios-"));
  try {
    const bin = join(cwd, "bin");
    const mobile = join(cwd, "mobile");
    const script = join(mobile, "scripts", "deploy-ios.sh");
    const profile = join(mobile, "eas.json");
    mkdirSync(bin);
    mkdirSync(join(mobile, "scripts"), { recursive: true });
    copyFileSync(new URL("../scripts/deploy-ios.sh", import.meta.url), script);
    const easConfig = readFileSync(new URL("../eas.json", import.meta.url), "utf8");
    writeFileSync(profile, easConfig);
    // Stand in for the runtime lookup and EAS, asserting what would be sent to each command.
    writeFileSync(
      join(bin, "npx"),
      `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (process.env.LEVE_APP_VARIANT !== "preview") process.exit(2);
if (args[2] === "env:exec" && args[3] === "preview" &&
    args[4] === "EXPO_NO_DOTENV=1 pnpm exec expo-updates runtimeversion:resolve --platform ios --workflow managed") {
  console.log('{"runtimeVersion":"test-runtime"}');
} else if (args[2] === "build:list") {
  console.log(process.env.TEST_EAS_BUILDS);
} else if (args[2] === "update" || args[2] === "build") {
  const release = args[2] === "update"
    ? process.env.EXPO_PUBLIC_RELEASE_NUMBER
    : JSON.parse(readFileSync("eas.json", "utf8")).build.preview.env.EXPO_PUBLIC_RELEASE_NUMBER;
  console.log(JSON.stringify({ command: args[2], release, message: args[args.indexOf("--message") + 1] }));
} else {
  process.exit(1);
}
`,
      { mode: 0o755 },
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Leve Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    const deploy = (builds: string, releaseBase = "") => {
      const output = execFileSync("bash", [script], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          CI: "true",
          GITHUB_REF: "",
          GITHUB_SHA: "",
          FORCE_BUILD: "false",
          COMMIT: "",
          LEVE_RELEASE_BASE: releaseBase,
          ASC_API_KEY_PATH: join(cwd, "test.p8"),
          ASC_API_KEY_ID: "test",
          ASC_API_ISSUER_ID: "test",
          TEST_EAS_BUILDS: builds,
        },
      });
      return JSON.parse(output.trim().split("\n").at(-1) ?? "");
    };

    git("commit", "-q", "--allow-empty", "-m", "First merge");
    const first = git("rev-parse", "--short", "HEAD");
    expect(deploy("[]")).toEqual({
      command: "build",
      release: "1",
      message: `Release 1 (${first}) First merge`,
    });
    expect(readFileSync(profile, "utf8")).toBe(easConfig);

    git("commit", "-q", "--allow-empty", "-m", "Second merge");
    const second = git("rev-parse", "--short", "HEAD");
    const expectedUpdate = {
      command: "update",
      release: "2",
      message: `Release 2 (${second}) Second merge`,
    };
    expect(deploy('[{"status":"FINISHED"}]')).toEqual(expectedUpdate);
    expect(deploy('[{"status":"FINISHED"}]')).toEqual(expectedUpdate);
    expect(deploy('[{"status":"FINISHED"}]', "17")).toEqual({
      command: "update",
      release: "19",
      message: `Release 19 (${second}) Second merge`,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
