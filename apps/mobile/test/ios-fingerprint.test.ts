import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

it("changes the iOS runtime when a workspace dependency patch changes", {
  timeout: 120_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "leve-fingerprint-"));
  try {
    const mobile = join(root, "apps", "mobile");
    const patches = join(root, "patches");
    mkdirSync(mobile, { recursive: true });
    mkdirSync(patches);
    copyFileSync(
      new URL("../fingerprint.config.cjs", import.meta.url),
      join(mobile, "fingerprint.config.cjs"),
    );
    writeFileSync(join(mobile, "package.json"), JSON.stringify({ name: "leve-fixture" }));
    writeFileSync(
      join(mobile, "app.json"),
      JSON.stringify({
        expo: {
          name: "Leve Fixture",
          slug: "leve-fixture",
          sdkVersion: "58.0.0",
          runtimeVersion: { policy: "fingerprint" },
        },
      }),
    );
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve("expo-updates/package.json")), "bin", "cli.js");
    const runtime = () => {
      const output = execFileSync(
        process.execPath,
        [cli, "runtimeversion:resolve", "--platform", "ios", "--workflow", "managed"],
        { cwd: mobile, encoding: "utf8", env: { ...process.env, EXPO_NO_DOTENV: "1" } },
      );
      const result = JSON.parse(output);
      expect(result.runtimeVersion).toMatch(/^[a-f0-9]{40}$/);
      return result.runtimeVersion;
    };

    const patch = join(patches, "expo-widgets.patch");
    writeFileSync(
      patch,
      "--- a/ios/Intent.swift\n+++ b/ios/Intent.swift\n@@ -1 +1 @@\n-old\n+first\n",
    );
    const before = runtime();
    writeFileSync(
      patch,
      "--- a/ios/Intent.swift\n+++ b/ios/Intent.swift\n@@ -1 +1 @@\n-old\n+second\n",
    );
    const after = runtime();
    expect(after).not.toBe(before);

    writeFileSync(join(mobile, "index.js"), "export default 1;\n");
    expect(runtime()).toBe(after);

    rmSync(patches, { recursive: true });
    expect(runtime()).not.toBe(after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
