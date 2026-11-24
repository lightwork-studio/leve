import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const resolve = require("../app.config.js");
const { expo: preview } = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
const eas = JSON.parse(readFileSync(new URL("../eas.json", import.meta.url), "utf8"));

afterEach(() => vi.unstubAllEnvs());

it("uses a local identity and disables official Expo updates in a fresh checkout", () => {
  vi.stubEnv("LEVE_APP_VARIANT", undefined);
  const app = resolve({ config: preview });
  expect(app).toMatchObject({
    name: "Leve Dev",
    scheme: "leve-dev",
    ios: { bundleIdentifier: "app.leve.dev" },
    android: { package: "app.leve.dev" },
    updates: { enabled: false },
  });
  expect(app.owner).toBeUndefined();
  expect(app.extra.eas).toBeUndefined();
  // Only the preview signs in with Apple.
  expect(preview.plugins).toContain("expo-apple-authentication");
  expect(app.plugins).not.toContain("expo-apple-authentication");
});

it("uses the existing TestFlight identity and update endpoint in the preview profile", () => {
  vi.stubEnv("LEVE_APP_VARIANT", eas.build.preview.env.LEVE_APP_VARIANT);
  expect(resolve({ config: preview })).toEqual(preview);
});
