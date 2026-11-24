import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const app = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
// Metro itself, found the way the bundler finds it: through Expo's Metro config.
const fromExpo = createRequire(
  require.resolve("@expo/metro-config", { paths: [require.resolve("expo")] }),
);
const fromMetro = createRequire(fromExpo.resolve("metro"));
// Not a dependency of the app, so typed here by the part this test calls.
const { resolve } = fromMetro("metro-resolver") as {
  resolve(
    context: unknown,
    specifier: string,
    platform: string,
  ): { type: string; filePath?: string };
};
const metroConfig = require("../metro.config.js") as {
  resolver: { sourceExts: string[]; assetExts: string[] };
};

const PLATFORMS = ["ios", "android", "web"] as const;
const SPLIT = /^(.+)\.(ios|android|native|web)\.([a-z]+)$/;

const posix = (file: string) => relative(app, file).split(sep).join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.[jt]sx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

/** Where Metro sends an import of `specifier` from `origin` when bundling for `platform`. */
function resolveFor(origin: string, specifier: string, platform: string): string {
  const { sourceExts, assetExts } = metroConfig.resolver;
  const result = resolve(
    {
      allowHaste: false,
      assetExts,
      customResolverOptions: {},
      disableHierarchicalLookup: false,
      doesFileExist: () => false,
      extraNodeModules: null,
      fileSystemLookup: (path: string) => {
        try {
          const found = readdirSync(dirname(path)).includes(basename(path));
          return found && !path.endsWith("/")
            ? { exists: true as const, type: "f" as const, realPath: path }
            : { exists: false as const };
        } catch {
          return { exists: false as const };
        }
      },
      getPackage: () => null,
      getPackageForModule: () => null,
      mainFields: ["react-native", "browser", "main"],
      nodeModulesPaths: [],
      originModulePath: origin,
      preferNativePlatform: platform !== "web",
      redirectModule: (path: string) => path,
      resolveHasteModule: () => undefined,
      resolveHastePackage: () => undefined,
      sourceExts,
      unstable_conditionNames: [],
      unstable_conditionsByPlatform: {},
      unstable_enablePackageExports: false,
      unstable_logWarning: () => {},
    },
    specifier,
    platform,
  );
  if (result.type !== "sourceFile" || !result.filePath)
    throw new Error(`${specifier} did not resolve to a file`);
  return result.filePath;
}

it("bundles each platform's own file wherever a module is split by platform", () => {
  const files = [...sourceFiles(join(app, "app")), ...sourceFiles(join(app, "src"))];
  const split = files.filter((file) => SPLIT.test(basename(file)));
  expect(split.length).toBeGreaterThan(0);
  const misses: string[] = [];
  for (const file of split) {
    const [, stem, variant] = basename(file).match(SPLIT) ?? [];
    const origin = join(dirname(file), "__importer__.ts");
    for (const platform of PLATFORMS) {
      if (variant !== platform && !(variant === "native" && platform !== "web")) continue;
      // An exact platform file wins over a .native one on that platform.
      const exact = files.some(
        (f) => basename(f).startsWith(`${stem}.${platform}.`) && dirname(f) === dirname(file),
      );
      if (variant === "native" && exact) continue;
      const picked = resolveFor(origin, `./${stem}`, platform);
      if (picked !== file) misses.push(`${platform}: ${posix(file)} lost to ${posix(picked)}`);
    }
  }
  expect(misses).toEqual([]);
});
