// Reads device storage into plain logical values with raw SQL, independently of DeviceStore, for
// version 1 (the real layout) and the test-only versions 2 and 3. Tests compare the result with
// literal expectations, so a store helper that changed meaning cannot hide a lost value.
import type { SqlConnection, SqlEngine, SqlValue } from "../driver.ts";
import { engine } from "./fixtures.ts";

export interface LogicalRecord {
  kind: string;
  id: string;
  parent: string | null;
  status: string;
  seq: number;
  server: { revision: number; state: string; content: unknown } | null;
  local: { state: string; content: unknown; baseRevision: number | null } | null;
  problem: { reason: string; revision: number | null; at: string } | null;
  partialFields: string[];
  /** Offered again after a server restore without a change by the user; "missing" if not stored. */
  reoffered: boolean | "missing";
  /** The last server copy kept through a restore; "missing" if not stored. */
  keptContent: unknown;
  /** A server had the record before a restore; "missing" if not stored. */
  seenOnServer: boolean | "missing";
}

export interface LogicalSubmission {
  submissionId: string;
  record: string;
  op: string;
  baseRevision: number | null;
  localSeq: number;
  release: string;
  /** Exactly the stored text, so a changed byte shows. */
  wireContent: string | null;
  /** For deletions, exactly the stored text of the descendants list. */
  descendants: string | null;
  omitted: string;
  createdAt: string;
  attempts: number;
}

export interface LogicalDevice {
  storageVersion: number;
  appVersion: string;
  unsyncedWork: boolean;
  sync: {
    server: string | null;
    account: string | null;
    cursor: number;
    release: string | null;
    features: string | null;
    lineage: string | null;
    restoring: number;
  };
  records: LogicalRecord[];
  submissions: LogicalSubmission[];
  /** Child ids of every parent with children, in display order. */
  children: Record<string, string[]>;
  /** Stored content text of every record, to show it is unchanged byte for byte. */
  rawContent: Record<string, { server: string | null; local: string | null }>;
}

const str = (value: SqlValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: SqlValue | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);
const parsed = (value: SqlValue | undefined): unknown =>
  value === null || value === undefined ? null : JSON.parse(String(value));

export function readDevice(db: SqlConnection): LogicalDevice {
  const meta = db.get("SELECT storage_version, app_version, unsynced_work FROM storage_meta");
  if (!meta) throw new Error("no storage metadata");
  const version = Number(meta.storage_version);
  const v1 = !db.get("SELECT 1 FROM sqlite_master WHERE name = 'record_partial_fields'");

  const partial = new Map<string, string[]>();
  if (!v1) {
    for (const row of db.all(
      "SELECT kind, id, field FROM record_partial_fields ORDER BY kind, id, ordinal",
    )) {
      const key = `${String(row.kind)}/${String(row.id)}`;
      partial.set(key, [...(partial.get(key) ?? []), String(row.field)]);
    }
  }

  const records: LogicalRecord[] = [];
  const rawContent: LogicalDevice["rawContent"] = {};
  const childRows: { parent: string; id: string; position: number }[] = [];
  for (const row of db.all("SELECT * FROM records ORDER BY kind, id")) {
    const key = `${String(row.kind)}/${String(row.id)}`;
    const parent =
      row.parent_kind === null ? null : `${String(row.parent_kind)}/${String(row.parent_id)}`;
    records.push({
      kind: String(row.kind),
      id: String(row.id),
      parent,
      status: String(row.status),
      seq: Number(row.local_seq),
      server:
        row.server_state === null
          ? null
          : {
              revision: Number(row.server_revision),
              state: String(row.server_state),
              content: parsed(row.server_content),
            },
      local:
        row.local_state === null
          ? null
          : {
              state: String(row.local_state),
              content: parsed(row.local_content),
              baseRevision: num(row.local_base),
            },
      problem:
        row.problem === null
          ? null
          : {
              reason: String(row.problem),
              revision: num(row.problem_revision),
              at: String(row.problem_at),
            },
      partialFields: v1
        ? row.partial_fields === null
          ? []
          : (JSON.parse(String(row.partial_fields)) as string[])
        : (partial.get(key) ?? []),
      reoffered: row.reoffered === undefined ? "missing" : Number(row.reoffered) !== 0,
      keptContent: row.kept_content === undefined ? "missing" : parsed(row.kept_content),
      seenOnServer: row.seen_on_server === undefined ? "missing" : Number(row.seen_on_server) !== 0,
    });
    rawContent[key] = { server: str(row.server_content), local: str(row.local_content) };
    if (parent !== null) {
      // Version 1 orders by the content's position; later versions by the backfilled column.
      const shown = (parsed(row.local_content) ?? parsed(row.server_content)) as {
        position?: number;
      } | null;
      const position = v1 ? (shown?.position ?? 0) : Number(row.display_position);
      childRows.push({ parent, id: String(row.id), position });
    }
  }
  childRows.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const children: Record<string, string[]> = {};
  for (const child of childRows)
    children[child.parent] = [...(children[child.parent] ?? []), child.id];

  const submissionSql = v1
    ? "SELECT * FROM submissions ORDER BY submission_id"
    : `SELECT s.*, p.wire_content FROM submissions s
       LEFT JOIN submission_payloads p ON p.submission_id = s.submission_id
       ORDER BY s.submission_id`;
  const submissions = db.all(submissionSql).map(
    (row): LogicalSubmission => ({
      submissionId: String(row.submission_id),
      record: `${String(row.kind)}/${String(row.id)}`,
      op: String(row.op),
      baseRevision: num(row.base_revision),
      localSeq: Number(row.local_seq),
      release: String(row.release),
      wireContent: str(row.wire_content),
      descendants: str(row.descendants),
      omitted: String(row.omitted),
      createdAt: String(row.created_at),
      attempts: Number(row.attempts),
    }),
  );

  const sync = db.get("SELECT * FROM sync_state WHERE id = 1");
  if (!sync) throw new Error("no sync state");
  return {
    storageVersion: version,
    appVersion: String(meta.app_version),
    unsyncedWork: Number(meta.unsynced_work) !== 0,
    sync: {
      server: str(sync.server),
      account: str(sync.account),
      cursor: Number(sync.cursor),
      release: str(sync.release),
      features: str(sync.features),
      lineage: str(sync.lineage),
      restoring: Number(sync.restoring),
    },
    records,
    submissions,
    children,
    rawContent,
  };
}

export function readDeviceFile(path: string, onEngine: SqlEngine = engine): LogicalDevice {
  const db = onEngine.open(path, { readOnly: true });
  try {
    return readDevice(db);
  } finally {
    db.close();
  }
}
