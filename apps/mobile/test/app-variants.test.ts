import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const resolve = require("../app.config.js");
const { expo: preview } = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
const devProject = "11111111-1111-4111-8111-111111111111";
const storeProject = "22222222-2222-4222-8222-222222222222";
const resolveApp = () => resolve({ config: preview });

afterEach(() => vi.unstubAllEnvs());

it("uses a local app identity with updates off on a fresh checkout", () => {
  vi.stubEnv("LEVE_APP_VARIANT", undefined);
  vi.stubEnv("LEVE_DEV_EAS_PROJECT_ID", undefined);
  vi.stubEnv("EXPO_PUBLIC_WEB_DEMO", undefined);
  const app = resolveApp();
  expect(app).toMatchObject({
    name: "Leve Dev",
    icon: "./assets/icon-dev.png",
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
  vi.stubEnv("LEVE_DEV_EAS_PROJECT_ID", undefined);
  vi.stubEnv("EXPO_PUBLIC_WEB_DEMO", "1");
  const demo = resolveApp();
  expect(demo).toMatchObject({
    name: "Leve Dev",
    updates: { enabled: false },
    experiments: { typedRoutes: false, baseUrl: "/demo" },
  });
  expect(demo.owner).toBeUndefined();
  expect(demo.extra.eas).toBeUndefined();
});

it("keeps the existing identity and update endpoint when publishing to TestFlight", () => {
  vi.stubEnv("LEVE_APP_VARIANT", "preview");
  vi.stubEnv("LEVE_DEV_EAS_PROJECT_ID", devProject);
  vi.stubEnv("LEVE_PRODUCTION_EAS_PROJECT_ID", storeProject);
  expect(resolveApp()).toEqual(preview);
});

it("keeps a configured native branch preview isolated from the App Store app", () => {
  vi.stubEnv("LEVE_DEV_EAS_PROJECT_ID", devProject);
  vi.stubEnv("LEVE_PRODUCTION_EAS_PROJECT_ID", storeProject);
  vi.stubEnv("LEVE_STORE_VERSION", "1.2.3");

  vi.stubEnv("LEVE_APP_VARIANT", "development");
  expect(resolveApp()).toMatchObject({
    ios: { bundleIdentifier: "app.leve.dev" },
    updates: { url: `https://u.expo.dev/${devProject}` },
    extra: { eas: { projectId: devProject } },
  });

  vi.stubEnv("LEVE_APP_VARIANT", "production");
  expect(resolveApp()).toMatchObject({
    name: "Leve",
    icon: "./assets/icon.png",
    version: "1.2.3",
    ios: { bundleIdentifier: "app.leve.production" },
    android: { package: "app.leve" },
    updates: { url: `https://u.expo.dev/${storeProject}` },
    extra: { eas: { projectId: storeProject } },
  });
});

it("fails closed when production has no version or project ID", () => {
  vi.stubEnv("LEVE_APP_VARIANT", "production");
  vi.stubEnv("LEVE_PRODUCTION_EAS_PROJECT_ID", undefined);
  vi.stubEnv("LEVE_STORE_VERSION", "1.2.3");
  expect(resolveApp).toThrow("requires its EAS project ID");
  vi.stubEnv("LEVE_PRODUCTION_EAS_PROJECT_ID", storeProject);
  vi.stubEnv("LEVE_STORE_VERSION", undefined);
  expect(resolveApp).toThrow("requires its EAS project ID");
});

it("rejects reusing the TestFlight project for a development build", () => {
  vi.stubEnv("LEVE_APP_VARIANT", "development");
  vi.stubEnv("LEVE_DEV_EAS_PROJECT_ID", preview.extra.eas.projectId);
  expect(resolveApp).toThrow("separate from TestFlight");
});
