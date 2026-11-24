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
  vi.stubEnv("EXPO_PUBLIC_WEB_DEMO", undefined);
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
  expect(app.experiments).toEqual(preview.experiments);
});

it("exports the landing demo under /demo using the local Dev identity", () => {
  vi.stubEnv("LEVE_APP_VARIANT", "development");
  vi.stubEnv("EXPO_PUBLIC_WEB_DEMO", "1");
  const demo = resolve({ config: preview });
  expect(demo).toMatchObject({
    name: "Leve Dev",
    updates: { enabled: false },
    experiments: { typedRoutes: false, baseUrl: "/demo" },
  });
  expect(demo.owner).toBeUndefined();
  expect(demo.extra.eas).toBeUndefined();
});

it("uses the existing TestFlight identity and update endpoint in the preview profile", () => {
  vi.stubEnv("LEVE_APP_VARIANT", eas.build.preview.env.LEVE_APP_VARIANT);
  expect(resolve({ config: preview })).toEqual(preview);
});
