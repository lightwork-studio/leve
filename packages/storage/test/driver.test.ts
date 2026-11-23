import { join } from "node:path";
import { afterAll } from "vitest";
import { createNodeSqliteEngine } from "../src/node-sqlite.ts";
import { removeTempDirs, tempDir } from "../src/test-support/fixtures.ts";
import { describeSqlEngine } from "../src/test-support/sql-engine-suite.ts";

afterAll(removeTempDirs);

const newPath = (name: string) => join(tempDir(), name);

describeSqlEngine("node:sqlite", { createEngine: () => createNodeSqliteEngine(), newPath });

// The settings the storage tests use: one page per backup step and a tiny page cache.
describeSqlEngine("node:sqlite with small steps and cache", {
  createEngine: () => createNodeSqliteEngine({ backupPagesPerStep: 1, cacheSizePages: 8 }),
  newPath,
});
