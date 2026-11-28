import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { buildSite, pages } from "./build.mts";

it("packages the landing page and all its assets for a standalone static host", async () => {
  const parent = await mkdtemp(join(tmpdir(), "leve-site-"));
  const output = join(parent, "nested", "landing");
  const demo = join(parent, "export");
  try {
    const files = {
      "index.html": '<script src="/demo/_expo/app.js"></script>',
      "favicon.ico": "icon",
      "_expo/app.js": "bundle",
      "assets/sql-wasm.wasm": "wasm",
    };
    for (const [name, contents] of Object.entries(files)) {
      const path = join(demo, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    await writeFile(join(demo, "metadata.json"), "export metadata");

    const revision = "1234567890abcdef1234567890abcdef12345678";
    await buildSite(output, demo, revision);
    const html = await readFile(join(output, "index.html"), "utf8");
    const refs = Array.from(html.matchAll(/(?:href|src|srcset)="([^"]+)"/g), ([, value]) => value);
    expect(refs).toEqual(
      expect.arrayContaining([
        "./theme.css",
        "./style.css",
        "./wordmark-on-dark.svg",
        "./screen-notes.png",
        "./sql.js-LICENSE.txt",
        `https://github.com/lightwork-studio/leve/tree/${revision}`,
        `https://github.com/lightwork-studio/leve/blob/${revision}/THIRD_PARTY_NOTICES.md`,
      ]),
    );
    // Every page is published, and every page's links and assets resolve in the output.
    for (const page of pages) {
      const pageHtml = await readFile(join(output, page), "utf8");
      const pageRefs = Array.from(
        pageHtml.matchAll(/(?:href|src|srcset)="([^"]+)"/g),
        ([, value]) => value,
      );
      // The legal pages App Store Connect links to are reachable from every page.
      expect(pageRefs).toEqual(
        expect.arrayContaining(["./privacy.html", "./support.html", "./impressum.html"]),
      );
      expect(pageHtml).not.toMatch(/github\.com\/lightwork-studio\/leve\/(tree|blob)\/main/);
      for (const ref of pageRefs) {
        if (ref.startsWith("https://") || ref.startsWith("mailto:")) continue;
        if (ref.startsWith("#")) {
          expect(pageHtml).toContain(`id="${ref.slice(1)}"`);
        } else if (ref === "./demo/") {
          expect(await readFile(join(output, ref, "index.html"), "utf8")).toBe(files["index.html"]);
        } else {
          expect(ref).toMatch(/^\.\/[\w.-]+$/);
          expect((await readFile(join(output, ref))).length).toBeGreaterThan(0);
        }
      }
    }
    expect(await readFile(join(output, "sql.js-LICENSE.txt"), "utf8")).toContain(
      "Copyright (c) 2017 sql.js authors",
    );
    for (const [name, contents] of Object.entries(files)) {
      expect(await readFile(join(output, "demo", name), "utf8")).toBe(contents);
    }
    await expect(readFile(join(output, "demo/metadata.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

it.each([".pnpm", "node_modules"])(
  "fails the build if demo assets would be skipped under %s",
  async (folder) => {
    const parent = await mkdtemp(join(tmpdir(), "leve-site-"));
    const demo = join(parent, "export");
    try {
      await mkdir(join(demo, "_expo"), { recursive: true });
      await mkdir(join(demo, "assets", folder), { recursive: true });
      await writeFile(join(demo, "index.html"), "demo page");
      await writeFile(join(demo, "favicon.ico"), "icon");
      await writeFile(join(demo, "assets", folder, "sqlite.wasm"), "wasm");
      await expect(buildSite(join(parent, "landing"), demo)).rejects.toThrow(
        "The site deployment would skip a demo asset path",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
