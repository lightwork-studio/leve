// Expo's defaults, plus WebAssembly as an asset: the web build loads SQLite (sql.js) from one.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("wasm");
if (process.env.EXPO_PUBLIC_WEB_DEMO === "1") {
  config.transformer.assetPlugins.push(require.resolve("./scripts/demo-asset-path.cjs"));
}

module.exports = config;
