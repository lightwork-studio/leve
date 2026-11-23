import { createSqlJsEngine } from "@leve/storage/sqljs";
import { Asset } from "expo-asset";
import initSqlJs from "sql.js/dist/sql-wasm-browser.js";
import { claimBrowserData, loadBrowserFiles, readRecoveryFiles } from "./browser-files.ts";
import type { OpenedEngine } from "./engine.ts";
import { downloadRecovery } from "./recovery-download.ts";

// The WebAssembly build of SQLite, bundled as an asset so the page loads it from its own origin.
const wasm = require("sql.js/dist/sql-wasm-browser.wasm");

export async function exportStoredRecovery(): Promise<void> {
  await downloadRecovery(await readRecoveryFiles());
}

/** The browser's storage: SQLite in WebAssembly, with its files kept in IndexedDB. */
export async function openEngine(): Promise<OpenedEngine> {
  await claimBrowserData();
  const asset = Asset.fromModule(wasm);
  const [sql, files] = await Promise.all([
    initSqlJs({ locateFile: () => asset.uri }),
    loadBrowserFiles(),
  ]);
  const engine = createSqlJsEngine(sql, { files, onChange: (path) => files.saveSoon(path) });
  return {
    engine,
    paths: () => files.paths(),
    exportRecovery: () => downloadRecovery(files),
    flush: () => files.flush(),
    onSaveProblem: (listener) => files.onSaveProblem(listener),
  };
}
