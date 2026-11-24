import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../.github/scripts/release-credentials.sh", import.meta.url),
);

const names = ["TEST_RELEASE_TOKEN", "TEST_RELEASE_ACCOUNT"];

function check(env: Record<string, string>) {
  const base = { ...process.env };
  for (const name of names) delete base[name];
  return spawnSync("bash", [script, ...names], {
    encoding: "utf8",
    env: { ...base, ...env },
  });
}

it("publishes only with every credential, skips without any, and rejects a partial setup", () => {
  const ready = check({ TEST_RELEASE_TOKEN: "token", TEST_RELEASE_ACCOUNT: "account" });
  expect(ready.status).toBe(0);
  expect(ready.stdout).toBe("true\n");

  // A fork has none of the upstream secrets, so its release jobs skip instead of failing.
  const fork = check({});
  expect(fork.status).toBe(0);
  expect(fork.stdout).toBe("false\n");

  // Actions passes a missing secret as an empty string rather than leaving the variable unset.
  const empty = check({ TEST_RELEASE_TOKEN: "", TEST_RELEASE_ACCOUNT: "" });
  expect(empty.status).toBe(0);
  expect(empty.stdout).toBe("false\n");

  const partial = check({ TEST_RELEASE_TOKEN: "token", TEST_RELEASE_ACCOUNT: "" });
  expect(partial.status).toBe(1);
  expect(partial.stdout).toBe("");
  expect(partial.stderr).toContain("TEST_RELEASE_ACCOUNT");
  expect(partial.stderr).not.toContain("TEST_RELEASE_TOKEN");

  expect(spawnSync("bash", [script], { encoding: "utf8" }).status).toBe(2);
});
