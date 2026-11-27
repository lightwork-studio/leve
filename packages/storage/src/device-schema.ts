import {
  type Contract,
  clientContract,
  jsonEqual,
  type ReleaseId,
  releaseMessages,
  type Schema,
  type Submission,
  s,
  validate,
} from "@leve/contract";
import type { SqlConnection, SqlRow, SqlValue } from "./driver.ts";
import { addReleaseRefresh } from "./migrations/1.0/storage-v2.ts";
import { trackUncertainFields } from "./migrations/1.0/storage-v3.ts";
import { storeWorkoutJournals } from "./migrations/1.0/storage-v4.ts";
import { rememberRoutineEditBase } from "./migrations/1.0/storage-v5.ts";
import type { StorageDefinition, UpgradeStep } from "./upgrade.ts";

/*
 * The phone's database. Each record row holds the last copy received from the server and, when
 * the user changed it, the pending local version with the revision it started from. Submissions
 * are uploads in flight; each is retried unchanged until the server answers.
 *
 * A local version carried through a server restore keeps the record's last server copy in
 * kept_content until the restored server shows its own copy, so keeping theirs can offer it again.
 *
 * seen_on_server keeps deletions deliverable when a restore cleared the server copy or an
 * abandoned create may already have committed.
 *
 * Released migrations never change. A new layout bumps DEVICE_STORAGE_VERSION, adds an upgrade
 * step and a fixture of the previous version.
 */

export const DEVICE_STORAGE_VERSION = 5;

export const RECORD_STATUSES = ["synced", "pending", "conflict", "partial", "invalid"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

const statusList = RECORD_STATUSES.map((status) => `'${status}'`).join(", ");

export const DEVICE_SCHEMA_V1 = `
CREATE TABLE records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_kind TEXT,
  parent_id TEXT,
  server_revision INTEGER,
  server_state TEXT CHECK (server_state IN ('live', 'deleted', 'unavailable')),
  server_content TEXT,
  local_state TEXT CHECK (local_state IN ('live', 'deleted')),
  local_content TEXT,
  local_base INTEGER,
  local_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN (${statusList})),
  problem TEXT,
  problem_revision INTEGER,
  problem_at TEXT,
  partial_fields TEXT,
  reoffered INTEGER NOT NULL DEFAULT 0,
  kept_content TEXT,
  seen_on_server INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id),
  CHECK ((server_revision IS NULL) = (server_state IS NULL)),
  CHECK ((server_state = 'live') = (server_content IS NOT NULL)),
  CHECK ((local_state = 'live') = (local_content IS NOT NULL)),
  CHECK (status = 'synced' OR local_state IS NOT NULL),
  CHECK (kept_content IS NULL OR (server_revision IS NULL AND local_state IS NOT NULL))
);
CREATE INDEX records_parent ON records (parent_kind, parent_id);
CREATE INDEX records_status ON records (status);

CREATE TABLE submissions (
  submission_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('put', 'delete')),
  base_revision INTEGER,
  local_seq INTEGER NOT NULL,
  release TEXT NOT NULL,
  wire_content TEXT,
  descendants TEXT,
  omitted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, id),
  CHECK ((op = 'put') = (wire_content IS NOT NULL)),
  CHECK ((op = 'delete') = (descendants IS NOT NULL))
);

CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server TEXT,
  account TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  release TEXT,
  features TEXT,
  lineage TEXT,
  restoring INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_state (id) VALUES (1);
`;

type JsonShape = "object" | "strings" | "descendants";

/** Null when `value` is JSON text of the given shape, otherwise what is wrong with it. */
function jsonShapeProblem(value: SqlValue | undefined, shape: JsonShape): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return "invalid JSON";
  }
  const isObject = (item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item);
  switch (shape) {
    case "object":
      return isObject(parsed) ? null : "not an object";
    case "strings":
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
        ? null
        : "not a list of names";
    case "descendants":
      return Array.isArray(parsed) &&
        parsed.every(
          (item) =>
            isObject(item) &&
            typeof item.kind === "string" &&
            typeof item.id === "string" &&
            Number.isSafeInteger(item.revision),
        )
        ? null
        : "not a list of records";
  }
}

function isDescendantKind(contract: Contract, kind: string, ancestor: string): boolean {
  let parent = contract.kind(kind).parent;
  while (parent) {
    if (parent.kind === ancestor) return true;
    parent = contract.kind(parent.kind).parent;
  }
  return false;
}

/** Validate the original in-flight operation independently of later edits to its record. */
function verifySubmission(
  db: SqlConnection,
  row: SqlRow,
  contract: Contract,
  schemas: Map<ReleaseId, Schema<Submission>>,
): string[] {
  const where = `submission ${String(row.submission_id)}`;
  const kind = String(row.kind);
  const release = contract.releases.find((known) => known === row.release);
  if (!release || !contract.hasKind(kind, release))
    return [`${where}: ${kind} is unavailable on release ${String(row.release)}`];

  const problems: string[] = [];
  if (
    typeof row.local_seq !== "number" ||
    !Number.isSafeInteger(row.local_seq) ||
    row.local_seq < 1 ||
    typeof row.owner_seq !== "number" ||
    !Number.isSafeInteger(row.owner_seq) ||
    row.local_seq > row.owner_seq
  )
    problems.push(`${where}: invalid owner or edit sequence`);

  const omittedProblem = row.omitted == null ? "missing" : jsonShapeProblem(row.omitted, "strings");
  if (omittedProblem) problems.push(`${where} omitted: ${omittedProblem}`);
  else {
    const names: string[] = JSON.parse(String(row.omitted));
    const wireFields = contract.fieldNames(kind, release);
    if (
      names.some(
        (name) =>
          row.op !== "put" ||
          wireFields.includes(name) ||
          !Object.hasOwn(contract.kind(kind).fields, name),
      )
    )
      problems.push(`${where} omitted: invalid field for this upload`);
  }

  const put = row.op === "put";
  const column = put ? "wire_content" : "descendants";
  const shapeProblem = jsonShapeProblem(row[column], put ? "object" : "descendants");
  if (shapeProblem) return [...problems, `${where} ${column}: ${shapeProblem}`];
  const payload = JSON.parse(String(row[column]));
  const envelope = {
    op: row.op,
    submissionId: row.submission_id,
    kind,
    id: row.id,
    baseRevision: row.base_revision,
    ...(put ? { content: payload } : { descendants: payload }),
  };
  let schema = schemas.get(release);
  if (!schema) {
    schema = releaseMessages(contract, release).submission;
    schemas.set(release, schema);
  }
  const [issue] = validate(schema, envelope);
  if (issue) problems.push(`${where} envelope: ${issue.path} ${issue.message}`);
  if (put) {
    const [contentIssue] = contract.decode(kind, payload, release, String(row.id));
    if (contentIssue) problems.push(`${where} wire_content: ${contentIssue.message}`);
  } else {
    const seen = new Set<string>();
    const descendants = payload as { kind: string; id: string; revision: number }[];
    const included = new Set(descendants.map((child) => `${child.kind}/${child.id}`));
    for (const child of descendants) {
      if (!contract.hasKind(child.kind, release)) {
        problems.push(`${where}: descendant unavailable on release ${release}`);
        break;
      }
      const key = `${child.kind}/${child.id}`;
      const parent = contract.kind(child.kind).parent;
      // Later moves are valid. Only compare the server copy at the revision
      // recorded in this envelope; the current local parent may already differ.
      const observedParent =
        parent &&
        db.get(
          "SELECT json_extract(server_content, ?) AS owner FROM records WHERE kind=? AND id=? AND server_state='live' AND server_revision=? AND json_valid(server_content)",
          [`$.${parent.field}`, child.kind, child.id, child.revision],
        );
      const foreign =
        parent &&
        observedParent &&
        (parent.kind === kind
          ? observedParent.owner !== row.id
          : !included.has(`${parent.kind}/${observedParent.owner}`));
      if (
        foreign ||
        seen.has(key) ||
        !isDescendantKind(contract, child.kind, kind) ||
        (parent?.sharedId && parent.kind === kind && child.id !== row.id)
      ) {
        problems.push(`${where}: invalid descendant ${key}`);
        break;
      }
      seen.add(key);
    }
  }
  return problems;
}

/** Content and bookkeeping problems in all stored device data, checked after an upgrade. */
export function verifyDeviceRecords(
  db: SqlConnection,
  contract: Contract = clientContract,
): string[] {
  const problems: string[] = [];
  const idSchema = s.id();
  const check = (where: string, value: SqlValue | undefined, shape: JsonShape) => {
    if (value === null || value === undefined) return;
    const problem = jsonShapeProblem(value, shape);
    if (problem) problems.push(`${where}: ${problem}`);
  };
  for (const row of db.all("SELECT *, instr(kind || id, char(0)) AS identity_nul FROM records")) {
    const kind = String(row.kind);
    const where = `${kind}/${String(row.id)}`;
    check(`${where} partial_fields`, row.partial_fields, "strings");
    if ("uncertain_fields" in row)
      check(`${where} uncertain_fields`, row.uncertain_fields, "strings");
    if (!contract.hasKind(kind)) {
      problems.push(`${where}: unknown kind`);
      continue;
    }
    const singleton = contract.kind(kind).singletonId;
    if (
      row.identity_nul !== 0 ||
      validate(idSchema, row.id).length ||
      (singleton !== undefined && row.id !== singleton)
    )
      problems.push(`${where}: invalid record identity`);
    // A tombstone may never have carried its parent ID. A surviving index must still
    // point in the declared direction, including after moving and deleting a child.
    if (
      (row.parent_kind === null) !== (row.parent_id === null) ||
      (row.parent_id !== null && validate(idSchema, row.parent_id).length > 0) ||
      (row.parent_id !== null &&
        contract.kind(kind).parent?.sharedId &&
        row.parent_id !== row.id) ||
      (row.parent_kind === null && contract.kind(kind).parent && row.server_state === "live") ||
      (row.parent_kind !== null && row.parent_kind !== contract.kind(kind).parent?.kind)
    )
      problems.push(`${where}: invalid parent index`);
    if (
      row.routine_base_content != null &&
      (kind !== "routine" || row.local_state !== "live" || row.local_base === null)
    )
      problems.push(`${where}: routine starting copy has no pending edit`);
    for (const column of [
      "server_content",
      "local_content",
      "kept_content",
      "routine_base_content",
    ] as const) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      const shapeProblem = jsonShapeProblem(value, "object");
      if (shapeProblem) {
        problems.push(`${where} ${column}: ${shapeProblem}`);
        continue;
      }
      const content = JSON.parse(String(value));
      const issues = contract.validateContent(
        kind,
        contract.normalize(kind, content),
        String(row.id),
      );
      if (issues.length > 0) {
        problems.push(`${where} ${column}: ${issues[0]?.path} ${issues[0]?.message}`);
      } else if (
        (column === "local_content" && row.local_state === "live") ||
        (column === "server_content" && row.local_state === null && row.server_state === "live")
      ) {
        const parent = contract.parentOf(kind, content);
        if ((parent?.kind ?? null) !== row.parent_kind || (parent?.id ?? null) !== row.parent_id)
          problems.push(`${where}: parent index differs from current content`);
      }
    }
  }
  const schemas = new Map<ReleaseId, Schema<Submission>>();
  for (const row of db.all(
    `SELECT s.*, r.local_seq AS owner_seq FROM submissions s
     LEFT JOIN records r ON r.kind = s.kind AND r.id = s.id`,
  )) {
    problems.push(...verifySubmission(db, row, contract, schemas));
  }
  for (const row of db.all("SELECT features FROM sync_state")) {
    check("sync_state features", row.features, "strings");
  }
  return problems;
}

/** The meaning of an accepted receipt depends on which edit was in flight.
 * A plausible sequence on the upgraded record cannot establish this by itself. */
export function verifySavedUploadIdentity(
  before: SqlConnection,
  after: SqlConnection,
  payloadTable: (db: SqlConnection) => "submissions" | "submission_payloads" = () => "submissions",
): string[] {
  const hasOriginalChoice = before
    .all("PRAGMA table_info(submissions)")
    .some((column) => column.name === "choice_after_dispatch");
  const read = (db: SqlConnection) =>
    db.all(
      `SELECT s.submission_id, s.kind, s.id, s.op, s.base_revision, s.release,
            ${hasOriginalChoice ? "s.choice_after_dispatch," : ""}
            s.descendants, s.omitted, p.wire_content, s.local_seq, r.local_seq AS owner_seq
     FROM submissions s LEFT JOIN records r ON r.kind = s.kind AND r.id = s.id
     LEFT JOIN ${payloadTable(db)} p ON p.submission_id = s.submission_id
     ORDER BY s.submission_id`,
    );
  const original = read(before);
  const upgraded = read(after);
  for (const [index, row] of original.entries()) {
    const current = upgraded[index];
    if (
      !current ||
      Object.keys(row).some((key) => {
        if (current[key] === row[key]) return false;
        if (
          key !== "wire_content" ||
          typeof current[key] !== "string" ||
          typeof row[key] !== "string"
        )
          return true;
        return !jsonEqual(JSON.parse(current[key]), JSON.parse(row[key]));
      })
    )
      return [
        `submission ${String(row.submission_id)}: upload identity or edit sequence changed during upgrade`,
      ];
  }
  return [];
}

/** Whether anything on the device has not fully reached the server. */
export function deviceHasUnsyncedWork(db: SqlConnection): boolean {
  const row = db.get(
    `SELECT EXISTS (SELECT 1 FROM records WHERE status <> 'synced')
         OR EXISTS (SELECT 1 FROM submissions) AS unsynced`,
  );
  return Number(row?.unsynced ?? 0) !== 0;
}

export interface DeviceStorageOptions {
  contract?: Contract;
  /** Override the production migration steps in storage rehearsals. */
  steps?: readonly UpgradeStep[];
}

export function deviceStorageDefinition(options: DeviceStorageOptions = {}): StorageDefinition {
  const contract = options.contract ?? clientContract;
  return {
    name: "device",
    version: DEVICE_STORAGE_VERSION,
    oldestUpgradable: 1,
    create(db) {
      db.exec(DEVICE_SCHEMA_V1);
      addReleaseRefresh.run(db);
      trackUncertainFields.run(db);
      rememberRoutineEditBase.run(db);
    },
    steps: options.steps ?? [
      addReleaseRefresh,
      trackUncertainFields,
      storeWorkoutJournals,
      rememberRoutineEditBase,
    ],
    countedTables: ["records", "submissions"],
    verify: (db) => verifyDeviceRecords(db, contract),
    verifyPreserved: verifySavedUploadIdentity,
    unsyncedWork: deviceHasUnsyncedWork,
  };
}
