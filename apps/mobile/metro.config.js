// Expo's defaults, plus WebAssembly as an asset: the web build loads SQLite (sql.js) from one.
const { getDefaultConfig } = require("expo/metro-config");

/**
 * Whether Metro runs for `expo export --platform web`: a static site (the landing page's demo, a
 * branch preview). Its hosts leave dependency folders out of asset paths, so those are renamed. The
 * dev server and native builds keep Metro's paths, which they serve and bundle assets by.
 */
function exportsStaticWeb(args) {
  if (!args.includes("export")) return false;
  return args.some(
    (arg, i) =>
      arg === "--platform=web" || (["--platform", "-p"].includes(arg) && args[i + 1] === "web"),
  );
}

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("wasm");
if (process.env.EXPO_PUBLIC_WEB_DEMO === "1" || exportsStaticWeb(process.argv.slice(2))) {
  config.transformer.assetPlugins.push(require.resolve("./scripts/demo-asset-path.cjs"));
}

module.exports = config;
