// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/data/device-preferences", () => import("../src/data/device-preferences.web.ts"));

async function openTab() {
  vi.resetModules();
  return import("../src/data/device-preference-store.ts");
}

afterEach(() => localStorage.clear());

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
