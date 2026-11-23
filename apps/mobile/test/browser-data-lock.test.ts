import { afterEach, expect, it, vi } from "vitest";
import { claimBrowserData } from "../src/data/browser-files.ts";

afterEach(() => vi.unstubAllGlobals());

it("reports a rejected browser lock request to the caller opening the data", async () => {
  const failure = new Error("Storage access was denied.");
  vi.stubGlobal("navigator", { locks: { request: () => Promise.reject(failure) } });
  await expect(claimBrowserData()).rejects.toBe(failure);
});

it("opens for the holder while keeping a second tab out for the life of the page", async () => {
  let held = false;
  const request = vi.fn(
    async (_name: string, _options: unknown, acquire: (lock: object | null) => unknown) => {
      if (held) return acquire(null);
      held = true;
      try {
        return await acquire({});
      } finally {
        held = false;
      }
    },
  );
  vi.stubGlobal("navigator", { locks: { request } });
  await claimBrowserData();
  await expect(claimBrowserData()).rejects.toThrow("Leve is open in another tab.");
  expect(request).toHaveBeenCalledWith(
    "leve-preview-protocol-1-data",
    { ifAvailable: true },
    expect.any(Function),
  );
});

it("refuses both writable tabs when the browser cannot provide an exclusive lock", async () => {
  vi.stubGlobal("navigator", {});
  await expect(claimBrowserData()).rejects.toThrow(/secure.*browser/i);
  await expect(claimBrowserData()).rejects.toThrow(/secure.*browser/i);
});
