import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const configPath = require.resolve("../metro.config.js");
const plugin = require.resolve("../scripts/demo-asset-path.cjs");
const argv = process.argv;

/** The Metro config as it loads for a command line of `args` after `expo`. */
function configFor(args: string[]) {
  process.argv = ["node", "expo", ...args];
  delete require.cache[configPath];
  return require(configPath) as { transformer: { assetPlugins: string[] } };
}

afterEach(() => {
  process.argv = argv;
  delete require.cache[configPath];
  vi.unstubAllEnvs();
});

it("renames dependency folders in asset paths only for a static web export", () => {
  vi.stubEnv("EXPO_PUBLIC_WEB_DEMO", undefined);
  // `export:web`, which branch previews deploy: GitHub artifacts skip `.pnpm` and Pages skips
  // node_modules, so without the rename the SQLite WebAssembly never reaches the preview.
  for (const args of [
    ["export", "--platform", "web", "--output-dir", "dist"],
    ["export", "--platform=web"],
    ["export", "-p", "web"],
  ])
    expect(configFor(args).transformer.assetPlugins).toContain(plugin);
  // The dev server serves assets by Metro's own paths, and native builds bundle by them.
  for (const args of [["start", "--web"], ["export", "--platform", "ios"], ["export"]])
    expect(configFor(args).transformer.assetPlugins).not.toContain(plugin);
  // The landing page's demo renames them however it is built.
  vi.stubEnv("EXPO_PUBLIC_WEB_DEMO", "1");
  expect(configFor(["start", "--web"]).transformer.assetPlugins).toContain(plugin);

  const rename = require(plugin) as (asset: { httpServerLocation: string }) => {
    httpServerLocation: string;
  };
  expect(
    rename({
      httpServerLocation: "/assets/../../node_modules/.pnpm/sql.js@1.15.2/node_modules/sql.js/dist",
    }).httpServerLocation,
  ).toBe("/assets/../../dependencies/pnpm-store/sql.js@1.15.2/dependencies/sql.js/dist");
});
