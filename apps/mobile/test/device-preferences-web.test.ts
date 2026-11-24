// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const build = vi.hoisted(() => ({ webDemo: false }));
vi.mock("../src/build-info.ts", () => ({ buildInfo: build }));
vi.mock("../src/data/device-preferences", () => import("../src/data/device-preferences.web.ts"));

async function openTab() {
  vi.resetModules();
  return import("../src/data/device-preference-store.ts");
}

afterEach(() => {
  build.webDemo = false;
  localStorage.clear();
});

it("preserves the other tab's changes when Appearance and Track RIR are written separately", async () => {
  const legacyKey = "leve-device-preferences";
  localStorage.setItem(legacyKey, JSON.stringify({ trackRir: false, futureSetting: "keep" }));
  const appearanceTab = await openTab();
  const rirTab = await openTab();
  expect(appearanceTab.readDevicePreference("trackRir")).toBe(false);
  expect(rirTab.readDevicePreference("appearance")).toBeUndefined();

  rirTab.writeDevicePreference("trackRir", true);
  appearanceTab.writeDevicePreference("appearance", "dark");
  const freshTab = await openTab();
  expect(freshTab.readDevicePreference("trackRir")).toBe(true);
  expect(freshTab.readDevicePreference("appearance")).toBe("dark");

  rirTab.writeDevicePreference("trackRir", false);
  const reopenedTab = await openTab();
  expect(reopenedTab.readDevicePreference("appearance")).toBe("dark");
  expect(JSON.parse(localStorage.getItem(legacyKey) ?? "{}")).toEqual({
    trackRir: false,
    futureSetting: "keep",
  });
});

it("leaves unreadable shared preferences in storage even when setting Track RIR succeeds in memory", async () => {
  const legacyKey = "leve-device-preferences";
  const unreadable = '{"trackRir":true';
  localStorage.setItem(legacyKey, unreadable);
  const tab = await openTab();
  tab.writeDevicePreference("trackRir", false);
  expect(tab.readDevicePreference("trackRir")).toBe(false);
  expect(localStorage.getItem(legacyKey)).toBe(unreadable);
});

it("keeps demo preferences in the session and never reads or writes the browser's saved settings", async () => {
  const key = "leve-device-preferences:appearance";
  localStorage.setItem(key, '"dark"');
  build.webDemo = true;

  const demo = await openTab();
  expect(demo.readDevicePreference("appearance")).toBeUndefined();
  demo.writeDevicePreference("appearance", "light");
  expect(demo.readDevicePreference("appearance")).toBe("light");
  expect(localStorage.getItem(key)).toBe('"dark"');
  expect((await openTab()).readDevicePreference("appearance")).toBeUndefined();
});
