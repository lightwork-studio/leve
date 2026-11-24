import { createSqlJsEngine, memoryFiles } from "@leve/storage/sqljs";
import { buildInfo } from "../build-info.ts";
import { claimBrowserData, loadBrowserFiles, readRecoveryFiles } from "./browser-files.ts";
import type { OpenedEngine } from "./engine.ts";
import { downloadRecovery } from "./recovery-download.ts";
import { loadWebSql } from "./web-sql.ts";

export async function exportStoredRecovery(): Promise<void> {
  await downloadRecovery(await readRecoveryFiles());
}

/** SQLite in WebAssembly. The browser preview keeps its files in IndexedDB. */
export async function openEngine(): Promise<OpenedEngine> {
  if (buildInfo.webDemo) {
    const files = memoryFiles();
    const paths = () => Array.from(files.entries(), ([path]) => path);
    return {
      engine: createSqlJsEngine(await loadWebSql(), { files }),
      paths,
      exportRecovery: () => downloadRecovery({ paths, get: files.get }),
      flush: async () => {},
      onSaveProblem: () => {},
    };
  }

  await claimBrowserData();
  const [sql, files] = await Promise.all([loadWebSql(), loadBrowserFiles()]);
  const engine = createSqlJsEngine(sql, { files, onChange: (path) => files.saveSoon(path) });
  return {
    engine,
    paths: () => files.paths(),
    exportRecovery: () => downloadRecovery(files),
    flush: () => files.flush(),
    onSaveProblem: (listener) => files.onSaveProblem(listener),
  };
}
