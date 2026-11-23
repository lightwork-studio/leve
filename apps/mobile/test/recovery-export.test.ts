// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { recoveryArchive } from "../src/data/recovery-download.ts";

it("exports the original database, its journal and the upgrade snapshot with exact bytes", async () => {
  const files = new Map([
    ["/leve/device.db", Uint8Array.from([0, 255, 13, 10, 128])],
    ["/leve/device.db-journal", Uint8Array.from([255, 0])],
    ["/leve/device.db.pre-v3", new Uint8Array()],
  ]);
  const blob = await recoveryArchive({
    paths: () => [...files.keys()],
    get: (path) => files.get(path),
  });
  const copy = JSON.parse(await blob.text());
  expect(copy).toEqual({
    format: "leve-recovery-v1",
    files: [
      { path: "/leve/device.db", base64: "AP8NCoA=" },
      { path: "/leve/device.db-journal", base64: "/wA=" },
      { path: "/leve/device.db.pre-v3", base64: "" },
    ],
  });
});
