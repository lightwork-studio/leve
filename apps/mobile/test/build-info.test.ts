import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("expo-updates");
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The build info as a bundle with this sample data setting and update channel sees it. */
async function buildWith(sampleData: string | undefined, channel: string | null) {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_WEB_DEMO", "");
  vi.stubEnv("EXPO_PUBLIC_SAMPLE_DATA", sampleData);
  vi.doMock("expo-updates", () => ({ channel }));
  return (await import("../src/build-info.ts")).buildInfo;
}

it("offers sample data on request only in the TestFlight build, which starts empty", async () => {
  expect(await buildWith("off", "preview")).toMatchObject({
    sampleData: false,
    sampleDataOnRequest: true,
  });
  // The App Store build never offers it, and a build that has it already doesn't offer it twice.
  expect(await buildWith("off", "production")).toMatchObject({
    sampleData: false,
    sampleDataOnRequest: false,
  });
  expect(await buildWith("off", null)).toMatchObject({ sampleDataOnRequest: false });
  expect(await buildWith("on", "preview")).toMatchObject({
    sampleData: true,
    sampleDataOnRequest: false,
  });
  expect(await buildWith(undefined, null)).toMatchObject({
    sampleData: true,
    sampleDataOnRequest: false,
  });
});
