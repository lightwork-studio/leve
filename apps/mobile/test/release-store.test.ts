import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";

it("pins store builds and OTA fixes to the release tag", { timeout: 30_000 }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "leve-store-release-"));
  try {
    const script = join(cwd, "scripts", "release-store.sh");
    const bin = join(cwd, "bin");
    mkdirSync(join(cwd, "scripts"));
    mkdirSync(bin);
    cpSync(new URL("../scripts/release-store.sh", import.meta.url), script);
    const config = readFileSync(new URL("../eas.json", import.meta.url), "utf8");
    writeFileSync(join(cwd, "eas.json"), config);
    writeFileSync(
      join(bin, "npx"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[2] === "env:exec" && args[3] === "production" && args[4].includes("runtimeversion:resolve")) {
  console.log('{"runtimeVersion":"native-runtime"}');
} else if (args[2] === "build:list") {
  if (args[args.indexOf("--channel") + 1] !== "production" ||
      args[args.indexOf("--runtime-version") + 1] !== "native-runtime" ||
      args[args.indexOf("--distribution") + 1] !== "store" ||
      args[args.indexOf("--app-version") + 1] !== "1.2.3") process.exit(2);
  const commit = args[args.indexOf("--git-commit-hash") + 1];
  console.log(commit === process.env.TEST_BUILD_COMMIT ? process.env.TEST_BUILDS : "[]");
} else if (args[2] === "build" || args[2] === "update") {
  const config = JSON.parse(require("node:fs").readFileSync("eas.json", "utf8"));
  console.log(JSON.stringify({
    args,
    variant: process.env.LEVE_APP_VARIANT,
    version: process.env.LEVE_STORE_VERSION,
    sampleData: process.env.EXPO_PUBLIC_SAMPLE_DATA,
    buildVersion: config.build.production.env.LEVE_STORE_VERSION,
    submitApp: config.submit.production?.ios.ascAppId,
  }));
} else process.exit(2);
`,
      { mode: 0o755 },
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Leve test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("commit", "-q", "--allow-empty", "-m", "Store release");
    git("tag", "v1.2.3");
    git("update-ref", "refs/remotes/origin/main", "HEAD");

    const tagCommit = git("rev-parse", "v1.2.3").trim();
    const release = (mode: string, builds = "[]", buildCommit = tagCommit) =>
      spawnSync("bash", [script, "v1.2.3", mode], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          LEVE_PRODUCTION_EAS_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
          LEVE_PRODUCTION_ASC_APP_ID: "123",
          LEVE_PRODUCTION_APPLE_TEAM_ID: "test",
          EXPO_TOKEN: "test",
          ASC_API_KEY_PATH: "/tmp/test.p8",
          ASC_API_KEY_ID: "test",
          ASC_API_ISSUER_ID: "test",
          TEST_BUILDS: builds,
          TEST_BUILD_COMMIT: buildCommit,
        },
      });

    const build = release("build");
    expect(build.status, build.stderr).toBe(0);
    expect(JSON.parse(build.stdout)).toMatchObject({
      variant: "production",
      sampleData: "off",
      version: "1.2.3",
      buildVersion: "1.2.3",
      submitApp: "123",
      args: expect.arrayContaining(["build", "--profile", "production", "--auto-submit"]),
    });
    expect(readFileSync(join(cwd, "eas.json"), "utf8")).toBe(config);

    git("commit", "-q", "--allow-empty", "-m", "Hotfix");
    expect(release("ota").stderr).toContain("must use a main commit");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(release("build").status).toBe(1);
    expect(release("ota", '[{"status":"IN_QUEUE"}]').stderr).toContain("No finished EAS build");
    expect(
      release("ota", '[{"status":"FINISHED"}]', git("rev-parse", "HEAD").trim()).stderr,
    ).toContain("No finished EAS build");

    const ota = release("ota", '[{"status":"FINISHED"}]');
    expect(ota.status, ota.stderr).toBe(0);
    expect(JSON.parse(ota.stdout)).toMatchObject({
      version: "1.2.3",
      args: expect.arrayContaining(["update", "--channel", "production", "--environment"]),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
