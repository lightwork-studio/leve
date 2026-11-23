// Expo's defaults, plus WebAssembly as an asset: the web build loads SQLite (sql.js) from one.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("wasm");

module.exports = config;
