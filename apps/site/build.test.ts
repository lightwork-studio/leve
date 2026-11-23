import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSite } from "./build.mts";

it("packages the landing page and all its assets for a standalone static host", async () => {
  const parent = await mkdtemp(join(tmpdir(), "leve-site-"));
  const output = join(parent, "nested", "landing");
  try {
    await buildSite(output);
    const html = await readFile(join(output, "index.html"), "utf8");
    const refs = Array.from(html.matchAll(/(?:href|src|srcset)="([^"]+)"/g), ([, value]) => value);
    expect(refs).toEqual(
      expect.arrayContaining([
        "./theme.css",
        "./style.css",
        "./wordmark-on-dark.svg",
        "./screen-notes.png",
      ]),
    );
    for (const ref of refs) {
      if (ref.startsWith("https://")) continue;
      if (ref.startsWith("#")) {
        expect(html).toContain(`id="${ref.slice(1)}"`);
      } else {
        expect(ref).toMatch(/^\.\/[\w.-]+$/);
        expect((await readFile(join(output, ref))).length).toBeGreaterThan(0);
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
