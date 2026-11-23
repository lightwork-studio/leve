// TEST-ONLY storage versions. No storage version after 1 has shipped, so these synthetic
// definitions rehearse a real upgrade: they build on the real version-1 definitions and make
// realistic layout changes. They are never used by production code.
import { createContract, LEVE_CONTRACT_DEFINITION, s } from "@leve/contract";
import { previewContractThrough as historicalContract } from "../../../contract/test/support/preview-contract.ts";
import {
  DEVICE_SCHEMA_V1,
  deviceHasUnsyncedWork,
  deviceStorageDefinition,
  verifySavedUploadIdentity,
} from "../device-schema.ts";
import type { SqlConnection } from "../driver.ts";
import { SERVER_SCHEMA_V1, serverStorageDefinition } from "../server-store.ts";
import type { StorageDefinition, UpgradeStep } from "../upgrade.ts";

export { historicalContract };

export const release10 = historicalContract("1.0");

/** The rehearsal adds a test-only field to exercise partial uploads. */
export const fixtureContract = createContract({
  ...release10.definition,
  releases: ["1.0", "1.1"],
  kinds: {
    ...release10.definition.kinds,
    workout: {
      ...LEVE_CONTRACT_DEFINITION.kinds.workout,
      fields: {
        ...release10.kind("workout").fields,
        perceivedEffort: { schema: s.nullable(s.integer(1, 10)), since: "1.1" },
      },
    },
  },
});

/** The real version-1 device storage definition: the "old build" in these tests. */
export const deviceV1: StorageDefinition = {
  ...deviceStorageDefinition({ contract: fixtureContract }),
  version: 1,
  create: (db) => db.exec(DEVICE_SCHEMA_V1),
  steps: [],
};

const positionOf = (content: unknown): number | null => {
  if (typeof content !== "string") return null;
  const position = (JSON.parse(content) as { position?: unknown }).position;
  return typeof position === "number" ? position : null;
};

/**
 * TEST-ONLY device step 1 → 2. Three realistic layout changes, each written row by row so that
 * every write is a crash point:
 * - a NOT NULL `display_position` column backfilled from the visible content's position;
 * - partially synced field lists move from a JSON column into their own table;
 * - in-flight wire content moves out of `submissions` into `submission_payloads`, which needs
 *   SQLite's table rebuild because a CHECK constraint names the old column.
 */
export const deviceStep1To2: UpgradeStep = {
  from: 1,
  description: "test: display positions, partial-field table, submission payload table",
  run(db) {
    db.exec("ALTER TABLE records ADD COLUMN display_position REAL NOT NULL DEFAULT 0");
    for (const row of db.all(
      "SELECT kind, id, local_content, server_content FROM records ORDER BY kind, id",
    )) {
      const position = positionOf(row.local_content ?? row.server_content);
      if (position === null) continue;
      db.run("UPDATE records SET display_position = ? WHERE kind = ? AND id = ?", [
        position,
        row.kind ?? null,
        row.id ?? null,
      ]);
    }

    db.exec(`CREATE TABLE record_partial_fields (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      field TEXT NOT NULL,
      PRIMARY KEY (kind, id, ordinal),
      FOREIGN KEY (kind, id) REFERENCES records (kind, id)
    )`);
    for (const row of db.all(
      "SELECT kind, id, partial_fields FROM records WHERE partial_fields IS NOT NULL ORDER BY kind, id",
    )) {
      const fields = JSON.parse(String(row.partial_fields)) as string[];
      fields.forEach((field, ordinal) => {
        db.run("INSERT INTO record_partial_fields (kind, id, ordinal, field) VALUES (?, ?, ?, ?)", [
          row.kind ?? null,
          row.id ?? null,
          ordinal,
          field,
        ]);
      });
    }
    db.exec("ALTER TABLE records DROP COLUMN partial_fields");

    db.exec("ALTER TABLE submissions RENAME TO submissions_v1");
    db.exec(`CREATE TABLE submissions (
      submission_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('put', 'delete')),
      base_revision INTEGER,
      local_seq INTEGER NOT NULL,
      release TEXT NOT NULL,
      descendants TEXT,
      omitted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      UNIQUE (kind, id),
      CHECK ((op = 'delete') = (descendants IS NOT NULL))
    )`);
    db.exec(`INSERT INTO submissions (submission_id, kind, id, op, base_revision, local_seq,
        release, descendants, omitted, created_at, attempts)
      SELECT submission_id, kind, id, op, base_revision, local_seq, release, descendants, omitted,
        created_at, attempts FROM submissions_v1`);
    db.exec(`CREATE TABLE submission_payloads (
      submission_id TEXT PRIMARY KEY REFERENCES submissions (submission_id),
      wire_content TEXT NOT NULL
    )`);
    for (const row of db.all(
      "SELECT submission_id, wire_content FROM submissions_v1 WHERE wire_content IS NOT NULL ORDER BY submission_id",
    )) {
      db.run("INSERT INTO submission_payloads (submission_id, wire_content) VALUES (?, ?)", [
        row.submission_id ?? null,
        row.wire_content ?? null,
      ]);
    }
    db.exec("DROP TABLE submissions_v1");
  },
};

/** TEST-ONLY device step 2 → 3: an index for ordered children. */
export const deviceStep2To3: UpgradeStep = {
  from: 2,
  description: "test: index children by display position",
  run(db) {
    db.exec(
      "CREATE INDEX records_display_order ON records (parent_kind, parent_id, display_position, id)",
    );
  },
};

const isJsonArray = (value: unknown): boolean => {
  try {
    return typeof value === "string" && Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
};

/** Decodes all content stored in the version-2 (and 3) device layout. */
export function verifyDeviceV2(db: SqlConnection): string[] {
  const problems: string[] = [];
  for (const row of db.all(
    "SELECT kind, id, server_content, local_content, kept_content FROM records",
  )) {
    const kind = String(row.kind);
    const where = `${kind}/${String(row.id)}`;
    if (!fixtureContract.hasKind(kind)) {
      problems.push(`${where}: unknown kind`);
      continue;
    }
    for (const column of ["server_content", "local_content", "kept_content"] as const) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      try {
        const content = JSON.parse(String(value));
        const issues = fixtureContract.validateContent(
          kind,
          fixtureContract.normalize(kind, content),
        );
        if (issues.length > 0) {
          problems.push(`${where} ${column}: ${issues[0]?.path} ${issues[0]?.message}`);
        }
      } catch {
        problems.push(`${where} ${column}: invalid JSON`);
      }
    }
  }
  for (const row of db.all(
    `SELECT s.submission_id, s.op, s.descendants, s.omitted, p.wire_content FROM submissions s
     LEFT JOIN submission_payloads p ON p.submission_id = s.submission_id`,
  )) {
    const where = `submission ${String(row.submission_id)}`;
    if (!isJsonArray(row.omitted)) problems.push(`${where}: omitted fields are not a list`);
    if (row.op === "delete" && !isJsonArray(row.descendants)) {
      problems.push(`${where}: descendants are not a list`);
    }
    if (row.op === "delete") {
      if (row.wire_content !== null) problems.push(`${where}: delete with a payload`);
      continue;
    }
    if (row.wire_content === null) {
      problems.push(`${where}: payload is missing`);
      continue;
    }
    try {
      JSON.parse(String(row.wire_content));
    } catch {
      problems.push(`${where}: payload is invalid JSON`);
    }
  }
  for (const row of db.all("SELECT features FROM sync_state")) {
    if (row.features !== null && !isJsonArray(row.features)) {
      problems.push("sync_state features: not a list");
    }
  }
  for (const row of db.all(
    `SELECT kind, id FROM records r WHERE status = 'partial' AND NOT EXISTS
       (SELECT 1 FROM record_partial_fields f WHERE f.kind = r.kind AND f.id = r.id)`,
  )) {
    problems.push(`${String(row.kind)}/${String(row.id)}: partially synced without fields`);
  }
  return problems;
}

/** TEST-ONLY device storage version 2: the "new build" in these tests. */
export const deviceV2: StorageDefinition = {
  ...deviceV1,
  name: "device (test v2)",
  version: 2,
  oldestUpgradable: 1,
  create(db, context) {
    deviceV1.create(db, context);
    deviceStep1To2.run(db);
  },
  steps: [deviceStep1To2],
  verify: verifyDeviceV2,
  verifyPreserved: (before, after) =>
    verifySavedUploadIdentity(before, after, (db) =>
      db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submission_payloads'")
        ? "submission_payloads"
        : "submissions",
    ),
  unsyncedWork: deviceHasUnsyncedWork,
};

/**
 * TEST-ONLY broken version 2: the same step, but it truncates the first in-flight payload it
 * copies. The damage is committed; only verification after the commit catches it.
 */
export const deviceV2Corrupting: StorageDefinition = {
  ...deviceV2,
  steps: [
    {
      from: 1,
      description: "test: broken payload copy",
      run(db) {
        deviceStep1To2.run(db);
        db.run(
          `UPDATE submission_payloads SET wire_content = substr(wire_content, 1, 20)
           WHERE submission_id = (SELECT min(submission_id) FROM submission_payloads)`,
        );
      },
    },
  ],
};

/** TEST-ONLY broken version 2 whose step throws halfway, after writing. */
export const deviceV2Throwing: StorageDefinition = {
  ...deviceV2,
  steps: [
    {
      from: 1,
      description: "test: throws halfway",
      run(db) {
        deviceStep1To2.run(db);
        throw new Error("test step failed halfway");
      },
    },
  ],
};

/** TEST-ONLY device storage version 3, for upgrading across a skipped version. */
export const deviceV3: StorageDefinition = {
  ...deviceV2,
  name: "device (test v3)",
  version: 3,
  create(db, context) {
    deviceV2.create(db, context);
    deviceStep2To3.run(db);
  },
  steps: [deviceStep1To2, deviceStep2To3],
};

/* ---------- server ---------- */

/** The real version-1 server storage definition. */
export const serverV1: StorageDefinition = {
  ...serverStorageDefinition(),
  version: 1,
  steps: [],
  create(db, context) {
    db.exec(SERVER_SCHEMA_V1);
    db.run("INSERT INTO account (id, revision, lineage) VALUES (1, 0, ?)", [context.randomId()]);
  },
};

/** TEST-ONLY server step 1 → 2: a NOT NULL position column backfilled from content. */
export const serverStep1To2: UpgradeStep = {
  from: 1,
  description: "test: position column",
  run(db) {
    db.exec("ALTER TABLE records ADD COLUMN position REAL NOT NULL DEFAULT 0");
    for (const row of db.all(
      "SELECT kind, id, content FROM records WHERE state = 'live' ORDER BY kind, id",
    )) {
      const position = positionOf(row.content);
      if (position === null) continue;
      db.run("UPDATE records SET position = ? WHERE kind = ? AND id = ?", [
        position,
        row.kind ?? null,
        row.id ?? null,
      ]);
    }
  },
};

/** TEST-ONLY server storage version 2. */
export const serverV2: StorageDefinition = {
  ...serverV1,
  name: "server (test v2)",
  version: 2,
  oldestUpgradable: 1,
  create(db, context) {
    serverV1.create(db, context);
    serverStep1To2.run(db);
  },
  steps: [serverStep1To2],
  verify(db) {
    const problems = serverV1.verify(db);
    for (const row of db.all(
      "SELECT kind, id, content, position FROM records WHERE state = 'live'",
    )) {
      const expected = positionOf(row.content) ?? 0;
      if (Number(row.position) !== expected) {
        problems.push(`${String(row.kind)}/${String(row.id)}: position column disagrees`);
      }
    }
    return problems;
  },
};

/**
 * TEST-ONLY broken server version 2: it moves a set's position into the new column but also
 * removes it from the content, which then no longer decodes. Only accounts with sets are affected.
 */
export const serverV2Corrupting: StorageDefinition = {
  ...serverV2,
  steps: [
    {
      from: 1,
      description: "test: position moved out of set content",
      run(db) {
        serverStep1To2.run(db);
        for (const row of db.all(
          "SELECT id, content FROM records WHERE kind = 'workout_set' AND state = 'live'",
        )) {
          const content = JSON.parse(String(row.content)) as Record<string, unknown>;
          delete content.position;
          db.run("UPDATE records SET content = ? WHERE kind = 'workout_set' AND id = ?", [
            JSON.stringify(content),
            row.id ?? null,
          ]);
        }
      },
    },
  ],
};
