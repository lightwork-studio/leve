import { Asset } from "expo-asset";
import initSqlJs from "sql.js/dist/sql-wasm-browser.js";

// The WebAssembly build of SQLite, bundled as an asset so the page loads it from its own origin.
const wasm = require("sql.js/dist/sql-wasm-browser.wasm");

export function loadWebSql() {
  const asset = Asset.fromModule(wasm);
  return initSqlJs({ locateFile: () => asset.uri });
}
