import {
  type Change,
  type Contract,
  clientContract,
  compareReleases,
  type JsonObject,
  jsonBytes,
  jsonEqual,
  MAX_DESCENDANTS,
  type ReleaseId,
  type SubmissionResult,
  s,
  validate,
} from "@leve/contract";
import {
  DEVICE_STORAGE_VERSION,
  deviceHasUnsyncedWork,
  deviceStorageDefinition,
  type RecordStatus,
} from "./device-schema.ts";
import type { SqlConnection, SqlEngine, SqlRow, SqlValue } from "./driver.ts";
import { int, json, parseJson, text, transaction } from "./sql.ts";
import { type Checkpoint, openStorage, type StorageDefinition } from "./upgrade.ts";

export interface DeviceRecord {
  kind: string;
  id: string;
  /** What screens show: the local version if there is one, else the server copy. */
  content: JsonObject | null;
  deleted: boolean;
  /** The record exists on the server but this build can't show or edit it. */
  unavailable: boolean;
  status: RecordStatus;
  inFlight: boolean;
  /** Why the local version was not accepted, for conflicts and invalid uploads. */
  problem: { reason: string; revision: number | null; at: string } | null;
  server: {
    revision: number;
    state: "live" | "deleted" | "unavailable";
    content: JsonObject | null;
  } | null;
  /** Revision the pending local version started from; null for a record created here. */
  baseRevision: number | null;
  /** Local fields awaiting a server version that can confirm their values, including explicit clears. */
  partialFields: string[];
  /** Offered again after a server restore; the user never changed it (see resolveRestored). */
  fromRestore: boolean;
  /**
   * The record's last server copy from before a server restore, while the restored server has
   * shown none: what keeping theirs offers again.
   */
  keptContent: JsonObject | null;
}

export interface OutgoingSubmission {
  release: ReleaseId;
  submission:
    | {
        op: "put";
        submissionId: string;
        kind: string;
        id: string;
        baseRevision: number | null;
        content: JsonObject;
      }
    | {
        op: "delete";
        submissionId: string;
        kind: string;
        id: string;
        baseRevision: number | null;
        descendants: { kind: string; id: string; revision: number }[];
      };
}

export interface SyncState {
  server: string | null;
  account: string | null;
  cursor: number;
  release: ReleaseId | null;
  features: string[];
  /** The server account history this device's revisions and cursor belong to. */
  lineage: string | null;
  /** A full download after a server restore is under way. */
  restoring: boolean;
  refreshFrom: ReleaseId | null;
}

export type Resolution =
  | { choice: "keep_mine" }
  | { choice: "keep_theirs" }
  | { choice: "save_as_new"; newId: string };

export class DeviceStoreError extends Error {
  override name = "DeviceStoreError";
}

const recordId = s.id();

/** Refuses an id the server would refuse, before anything is stored under it. */
function checkId(kind: string, id: string): void {
  if (validate(recordId, id).length > 0) throw new DeviceStoreError(`${kind}: invalid id`);
}

export interface OpenDeviceStoreOptions {
  engine: SqlEngine;
  path: string;
  appVersion: string;
  contract?: Contract;
  /** Defaults to the current device storage definition. Tests pass older or newer ones. */
  definition?: StorageDefinition;
  now?: () => string;
  randomId?: () => string;
  onCheckpoint?: (point: Checkpoint, count: number) => void;
}

export async function openDeviceStore(options: OpenDeviceStoreOptions): Promise<DeviceStore> {
  const contract = options.contract ?? clientContract;
  const definition = options.definition ?? deviceStorageDefinition({ contract });
  const opened = await openStorage({
    engine: options.engine,
    path: options.path,
    definition,
    appVersion: options.appVersion,
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
    // The same id source creates the database, so a platform without crypto.randomUUID works.
    ...(options.randomId ? { randomId: options.randomId } : {}),
  });
  return new DeviceStore(
    opened.db,
    contract,
    options.now ?? (() => new Date().toISOString()),
    options.randomId ?? (() => crypto.randomUUID()),
  );
}

interface RecordRow {
  /** Offered again after a server restore without any change by the user. */
  reoffered: boolean;
  kind: string;
  id: string;
  parentKind: string | null;
  parentId: string | null;
  /** Newest release from which the device obtained this record, including a known null. */
  observedRelease: ReleaseId | null;
  uncertainFields: string[];
  serverRevision: number | null;
  serverState: "live" | "deleted" | "unavailable" | null;
  serverContent: JsonObject | null;
  localState: "live" | "deleted" | null;
  localContent: JsonObject | null;
  localBase: number | null;
  localSeq: number;
  status: RecordStatus;
  problem: string | null;
  problemRevision: number | null;
  problemAt: string | null;
  partialFields: string[];
  /** The last server copy of a local version carried through a restore (see the schema). */
  keptContent: JsonObject | null;
  /** A server had this record before a restore, or may have committed an abandoned create. */
  seenOnServer: boolean;
}

interface SubmissionRow {
  submissionId: string;
  kind: string;
  id: string;
  op: "put" | "delete";
  baseRevision: number | null;
  localSeq: number;
  release: ReleaseId;
  wireContent: JsonObject | null;
  /** For deletions: the live descendants this device knew, sent so the server can check them. */
  descendants: { kind: string; id: string; revision: number }[] | null;
  omitted: string[];
  choiceAfterDispatch: boolean;
}

function toRecordRow(row: SqlRow): RecordRow {
  const content = (value: SqlValue | undefined) =>
    value === null || value === undefined ? null : parseJson<JsonObject>(value, "content");
  return {
    kind: String(row.kind),
    id: String(row.id),
    parentKind: text(row.parent_kind),
    parentId: text(row.parent_id),
    observedRelease: text(row.observed_release) as ReleaseId | null,
    uncertainFields: row.uncertain_fields
      ? parseJson<string[]>(row.uncertain_fields, "field evidence")
      : [],
    serverRevision: int(row.server_revision),
    serverState: text(row.server_state) as RecordRow["serverState"],
    serverContent: content(row.server_content),
    localState: text(row.local_state) as RecordRow["localState"],
    localContent: content(row.local_content),
    localBase: int(row.local_base),
    localSeq: Number(row.local_seq),
    status: String(row.status) as RecordStatus,
    problem: text(row.problem),
    problemRevision: int(row.problem_revision),
    problemAt: text(row.problem_at),
    partialFields: row.partial_fields ? parseJson<string[]>(row.partial_fields, "fields") : [],
    reoffered: Number(row.reoffered ?? 0) !== 0,
    keptContent: content(row.kept_content),
    seenOnServer: Number(row.seen_on_server ?? 0) !== 0,
  };
}

function toSubmissionRow(row: SqlRow): SubmissionRow {
  return {
    submissionId: String(row.submission_id),
    kind: String(row.kind),
    id: String(row.id),
    op: String(row.op) as "put" | "delete",
    baseRevision: int(row.base_revision),
    localSeq: Number(row.local_seq),
    release: String(row.release) as ReleaseId,
    wireContent: row.wire_content ? parseJson<JsonObject>(row.wire_content, "wire") : null,
    descendants: row.descendants
      ? parseJson<SubmissionRow["descendants"]>(row.descendants, "descendants")
      : null,
    omitted: parseJson<string[]>(row.omitted, "omitted"),
    choiceAfterDispatch: Number(row.choice_after_dispatch ?? 0) !== 0,
  };
}

/**
 * The phone's records, pending edits and sync state. Every method runs in one SQLite transaction,
 * so a crash at any point leaves either the state before or after the call.
 */
export class DeviceStore {
  readonly db: SqlConnection;
  readonly contract: Contract;
  readonly #now: () => string;
  readonly #randomId: () => string;
  readonly #tracksFieldEvidence: boolean;

  constructor(db: SqlConnection, contract: Contract, now: () => string, randomId: () => string) {
    this.db = db;
    this.contract = contract;
    this.#now = now;
    this.#randomId = randomId;
    this.#tracksFieldEvidence = db
      .all("PRAGMA table_info(records)")
      .some((column) => column.name === "uncertain_fields");
  }

  close(): void {
    this.db.close();
  }

  get storageVersion(): number {
    return DEVICE_STORAGE_VERSION;
  }

  /* ---------- reading ---------- */

  #row(kind: string, id: string): RecordRow | null {
    const row = this.db.get("SELECT * FROM records WHERE kind = ? AND id = ?", [kind, id]);
    return row ? toRecordRow(row) : null;
  }

  #submissionFor(kind: string, id: string): SubmissionRow | null {
    const row = this.db.get("SELECT * FROM submissions WHERE kind = ? AND id = ?", [kind, id]);
    return row ? toSubmissionRow(row) : null;
  }

  /** Whether a record itself shows: not deleted, not unavailable, with content. */
  #shows(row: RecordRow): boolean {
    if (row.localState !== null) return row.localState !== "deleted" && row.localContent !== null;
    return row.serverState === "live" && row.serverContent !== null;
  }

  /** `inFlight` may be given when the caller already knows it, saving a query per record. */
  #view(row: RecordRow, inFlight?: boolean): DeviceRecord {
    const local = row.localState !== null;
    const state = local ? row.localState : row.serverState;
    return {
      kind: row.kind,
      id: row.id,
      content: local ? row.localContent : row.serverState === "live" ? row.serverContent : null,
      deleted: state === "deleted",
      unavailable: !local && row.serverState === "unavailable",
      status: row.status,
      inFlight: inFlight ?? this.#submissionFor(row.kind, row.id) !== null,
      problem:
        row.problem && row.problemAt
          ? { reason: row.problem, revision: row.problemRevision, at: row.problemAt }
          : null,
      server:
        row.serverRevision !== null && row.serverState
          ? { revision: row.serverRevision, state: row.serverState, content: row.serverContent }
          : null,
      baseRevision: row.localBase,
      partialFields: row.partialFields,
      fromRestore: row.reoffered && row.localState !== null,
      keptContent: row.keptContent,
    };
  }

  /** Device-local optimistic guard, including edits that return a record to its earlier values. */
  editVersion(kind: string, id: string): string | null {
    const row = this.#row(kind, id);
    return row ? JSON.stringify([row.localSeq, row.serverRevision]) : null;
  }

  get(kind: string, id: string): DeviceRecord | null {
    const row = this.#row(kind, id);
    return row ? this.#view(row) : null;
  }

  /**
   * Visible records of a kind in position order: all of them, the children of one parent, or the
   * children of several (`parentIds`, read together rather than one parent at a time).
   */
  list(
    kind: string,
    options: { parentId?: string; parentIds?: readonly string[] } = {},
  ): DeviceRecord[] {
    const raw =
      options.parentIds !== undefined
        ? this.#rowsIn(kind, "parent_id", options.parentIds)
        : options.parentId !== undefined
          ? this.db.all("SELECT * FROM records WHERE kind = ? AND parent_id = ?", [
              kind,
              options.parentId,
            ])
          : this.db.all("SELECT * FROM records WHERE kind = ?", [kind]);
    return this.#shown(kind, raw.map(toRecordRow));
  }

  /**
   * Records of a kind whose `column` is one of `values`. The values go in as one JSON array, so
   * the SQL is the same however many there are (no parameter limit, one prepared statement).
   */
  #rowsIn(kind: string, column: "id" | "parent_id", values: readonly string[]): SqlRow[] {
    if (values.length === 0) return [];
    return this.db.all(
      `SELECT * FROM records WHERE kind = ? AND ${column} IN (SELECT value FROM json_each(?))`,
      [kind, JSON.stringify([...new Set(values)])],
    );
  }

  /** The visible ones of some rows of one kind, as records in position order. */
  #shown(kind: string, rows: RecordRow[]): DeviceRecord[] {
    // A few reads for the whole list: what is being uploaded, then the ancestors a level at a
    // time. Reading them per record made long histories slow.
    const inFlight = new Set(
      this.db.all("SELECT id FROM submissions WHERE kind = ?", [kind]).map((r) => String(r.id)),
    );
    const ancestors = this.#ancestors(rows);
    const parents = new Map<string, true | number>();
    return rows
      .filter((row) => this.#visible(row, parents, ancestors))
      .map((row) => this.#view(row, inFlight.has(row.id)))
      .sort((a, b) => {
        const pa = Number(a.content?.position ?? 0);
        const pb = Number(b.content?.position ?? 0);
        return pa - pb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
  }

  /**
   * Whether a record shows: it and every ancestor it has (up to 8 levels) are live. `parents`
   * remembers ancestors already walked (by kind and id), so siblings share one walk up: `true` if
   * everything above shows, or, if not, the depth it was reached at. That "hidden" only holds when
   * the ancestor is reached as shallow or shallower, since the depth limit may otherwise cut the
   * walk short before the hidden record.
   */
  #visible(
    row: RecordRow,
    parents = new Map<string, true | number>(),
    ancestors = new Map<string, RecordRow | null>(),
  ): boolean {
    const walked: [key: string, depth: number][] = [];
    let current: RecordRow | null = row;
    let result = true;
    let depth = 0;
    for (; current && depth < 8; depth++) {
      if (!this.#shows(current)) {
        result = false;
        break;
      }
      if (!current.parentKind || !current.parentId) break;
      const key: string = `${current.parentKind}\u0000${current.parentId}`;
      const known = parents.get(key);
      if (known === true || (known !== undefined && depth + 1 <= known)) {
        result = known === true;
        break;
      }
      walked.push([key, depth + 1]);
      // A child whose parent this device never received still shows; references are soft.
      current = ancestors.has(key)
        ? (ancestors.get(key) ?? null)
        : this.#row(current.parentKind, current.parentId);
    }
    // A walk cut short by the depth limit says nothing certain about the ancestors on it.
    if (depth < 8) for (const [key, at] of walked) parents.set(key, result ? true : at);
    return result;
  }

  /**
   * The ancestors of some records, read a level at a time with one query per kind, by
   * kind and id. An ancestor that doesn't exist maps to null.
   */
  #ancestors(rows: RecordRow[]): Map<string, RecordRow | null> {
    const found = new Map<string, RecordRow | null>();
    let level = rows;
    for (let depth = 0; level.length > 0 && depth < 8; depth++) {
      const wanted = new Map<string, string[]>();
      for (const row of level) {
        if (!row.parentKind || !row.parentId) continue;
        const key = `${row.parentKind}\u0000${row.parentId}`;
        if (found.has(key)) continue;
        found.set(key, null);
        const ids = wanted.get(row.parentKind) ?? [];
        ids.push(row.parentId);
        wanted.set(row.parentKind, ids);
      }
      const next: RecordRow[] = [];
      for (const [kind, ids] of wanted) {
        for (const raw of this.#rowsIn(kind, "id", ids)) {
          const parent = toRecordRow(raw);
          found.set(`${parent.kind}\u0000${parent.id}`, parent);
          next.push(parent);
        }
      }
      level = next;
    }
    return found;
  }

  /** The workout still in progress, which a restart shows again. */
  activeWorkout(): DeviceRecord | null {
    // SQLite picks the workouts whose shown copy may be unfinished, so finished ones (however many)
    // aren't read; the exact checks below then decide as list() would.
    const candidates = this.db
      .all(
        `SELECT * FROM records WHERE kind = 'workout' AND json_extract(
           CASE WHEN local_state IS NOT NULL THEN local_content ELSE server_content END,
           '$.endedAt') IS NULL`,
      )
      .map(toRecordRow);
    return (
      this.#shown("workout", candidates).find((record) => record.content?.endedAt === null) ?? null
    );
  }

  #followsParentDeletion(row: RecordRow): boolean {
    if (row.localState !== "deleted") return false;
    const parent = this.contract.kind(row.kind).parent;
    return parent?.sharedId === true && this.#row(parent.kind, row.id)?.localState === "deleted";
  }

  /** Records whose local version was rejected and waits for the user. */
  problems(): DeviceRecord[] {
    return this.db
      .all(
        "SELECT * FROM records WHERE status IN ('conflict', 'invalid') ORDER BY problem_at, kind, id",
      )
      .map(toRecordRow)
      .filter((row) => !this.#followsParentDeletion(row))
      .map((row) => this.#view(row));
  }

  /** True only when deleting this tree cannot send a cascading delete to another device. */
  isLocalOnlyTree(kind: string, id: string): boolean {
    const localOnly = (row: RecordRow): boolean =>
      !this.#knownToServer(row) &&
      !this.#submissionFor(row.kind, row.id) &&
      this.#children(row.kind, row.id).every(localOnly);
    const row = this.#row(kind, id);
    return !!row && localOnly(row);
  }

  summary(): Record<RecordStatus | "inFlight", number> {
    const counts = { synced: 0, pending: 0, conflict: 0, partial: 0, invalid: 0, inFlight: 0 };
    for (const row of this.db.all("SELECT status, count(*) AS n FROM records GROUP BY status")) {
      counts[String(row.status) as RecordStatus] = Number(row.n);
    }
    counts.inFlight = Number(this.db.get("SELECT count(*) AS n FROM submissions")?.n ?? 0);
    return counts;
  }

  hasUnsyncedWork(): boolean {
    return deviceHasUnsyncedWork(this.db);
  }

  syncState(): SyncState {
    const row = this.db.get("SELECT * FROM sync_state WHERE id = 1") as SqlRow;
    return {
      server: text(row.server),
      account: text(row.account),
      cursor: Number(row.cursor),
      release: text(row.release) as ReleaseId | null,
      features: row.features ? parseJson<string[]>(row.features, "features") : [],
      lineage: text(row.lineage),
      restoring: Number(row.restoring) !== 0,
      refreshFrom: text(row.refresh_from) as ReleaseId | null,
    };
  }

  /* ---------- local edits ---------- */

  #write(row: RecordRow): void {
    this.db.run(
      `INSERT INTO records (kind, id, parent_kind, parent_id, server_revision, server_state,
         server_content, local_state, local_content, local_base, local_seq, status, problem,
         problem_revision, problem_at, partial_fields, reoffered, kept_content, seen_on_server,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET parent_kind = excluded.parent_kind,
         parent_id = excluded.parent_id, server_revision = excluded.server_revision,
         server_state = excluded.server_state, server_content = excluded.server_content,
         local_state = excluded.local_state, local_content = excluded.local_content,
         local_base = excluded.local_base, local_seq = excluded.local_seq, status = excluded.status,
         problem = excluded.problem, problem_revision = excluded.problem_revision,
         problem_at = excluded.problem_at, partial_fields = excluded.partial_fields, reoffered = excluded.reoffered,
         kept_content = excluded.kept_content, seen_on_server = excluded.seen_on_server,
         updated_at = excluded.updated_at`,
      [
        row.kind,
        row.id,
        row.parentKind,
        row.parentId,
        row.serverRevision,
        row.serverState,
        row.serverContent === null ? null : json(row.serverContent),
        row.localState,
        row.localContent === null ? null : json(row.localContent),
        row.localBase,
        row.localSeq,
        row.status,
        row.problem,
        row.problemRevision,
        row.problemAt,
        row.partialFields.length > 0 ? json(row.partialFields) : null,
        row.reoffered && row.localState !== null ? 1 : 0,
        // Only while the restored server has shown no copy of a record with a local version.
        row.keptContent !== null && row.serverRevision === null && row.localState !== null
          ? json(row.keptContent)
          : null,
        // Only needed while there is no server copy.
        row.seenOnServer && row.serverRevision === null ? 1 : 0,
        this.#now(),
      ],
    );
    if (row.localState !== "live" && row.uncertainFields.length) this.#setFieldEvidence(row, []);
  }

  /** Keep uncertainty separately from the revision used for visible measurements. */
  #setFieldEvidence(row: RecordRow, fields: string[]): RecordRow {
    const next = [...new Set(fields)].sort();
    if (!this.#tracksFieldEvidence || jsonEqual(row.uncertainFields, next)) return row;
    this.db.run("UPDATE records SET uncertain_fields = ? WHERE kind = ? AND id = ?", [
      next.length ? json(next) : null,
      row.kind,
      row.id,
    ]);
    return { ...row, uncertainFields: next };
  }

  #parentColumns(kind: string, content: JsonObject | null, fallback: RecordRow | null) {
    const parent = content ? this.contract.parentOf(kind, content) : null;
    return {
      parentKind: parent?.kind ?? fallback?.parentKind ?? null,
      parentId: parent?.id ?? fallback?.parentId ?? null,
    };
  }

  /** Parent columns for a row that shows its server copy again. */
  #serverParent(row: RecordRow) {
    return this.#parentColumns(
      row.kind,
      row.serverState === "live" ? row.serverContent : null,
      row,
    );
  }

  #emptyRow(kind: string, id: string): RecordRow {
    return {
      kind,
      id,
      parentKind: null,
      parentId: null,
      observedRelease: null,
      uncertainFields: [],
      serverRevision: null,
      serverState: null,
      serverContent: null,
      localState: null,
      localContent: null,
      localBase: null,
      localSeq: 0,
      status: "synced",
      problem: null,
      problemRevision: null,
      problemAt: null,
      partialFields: [],
      reoffered: false,
      keptContent: null,
      seenOnServer: false,
    };
  }

  #updateUnsyncedFlag(): void {
    this.db.run("UPDATE storage_meta SET unsynced_work = ? WHERE id = 1", [
      deviceHasUnsyncedWork(this.db) ? 1 : 0,
    ]);
  }

  #mutate<T>(fn: () => T): T {
    return transaction(this.db, () => {
      const result = fn();
      this.#updateUnsyncedFlag();
      return result;
    });
  }

  /** Saves the user's version of a record. Validation errors throw before anything is written. */
  put(kind: string, id: string, content: JsonObject, expectedVersion?: string): DeviceRecord {
    return this.#mutate(() => {
      if (expectedVersion !== undefined && this.editVersion(kind, id) !== expectedVersion)
        throw new DeviceStoreError("The record has changed. Review the latest values.");
      return this.#put(kind, id, content);
    });
  }

  /** Save related records and queue them together (for example a new workout and its sets). */
  putMany(records: readonly { kind: string; id: string; content: JsonObject }[]): void {
    this.putAndDelete(records, []);
  }

  /** Commit related saves and removals together, including their pending sync work. */
  putAndDelete(
    records: readonly { kind: string; id: string; content: JsonObject }[],
    removals: readonly { kind: string; id: string }[],
  ): void {
    this.#mutate(() => {
      for (const { kind, id, content } of records) this.#put(kind, id, content);
      for (const { kind, id } of removals) this.#delete(kind, id);
    });
  }

  #put(kind: string, id: string, content: JsonObject): DeviceRecord {
    checkId(kind, id);
    const singleton = this.contract.kind(kind).singletonId;
    if (singleton !== undefined && id !== singleton) {
      throw new DeviceStoreError(`${kind} is always stored as ${singleton}`);
    }
    const normalized = this.contract.normalize(kind, content);
    const issues = this.contract.validateContent(kind, normalized, id);
    if (issues.length > 0) {
      throw new DeviceStoreError(
        `${kind}: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
      );
    }
    const existing = this.#row(kind, id);
    if (existing && existing.localState === null && existing.serverState === "deleted") {
      throw new DeviceStoreError(`${kind}/${id} was deleted; save it as a new record instead`);
    }
    if (existing && existing.localState === null && existing.serverState === "unavailable") {
      throw new DeviceStoreError(`${kind}/${id} needs a newer app to edit`);
    }
    const row = existing ?? this.#emptyRow(kind, id);
    const startsEdit = row.localState === null;
    const before = row.localContent ?? row.serverContent;
    const sync = before ? this.syncState() : undefined;
    const projection = sync?.refreshFrom ?? sync?.release;
    const visible = projection ? this.contract.fieldNames(kind, projection) : [];
    // A second offline edit can return a field to a normalized null before the
    // first upload. A projected server copy cannot establish that it was null.
    const changedWhileHidden =
      projection && before
        ? Object.keys(normalized).filter(
            (field) =>
              !visible.includes(field) &&
              !jsonEqual(normalized[field] ?? null, before[field] ?? null),
          )
        : [];
    const observed = row.observedRelease ? this.contract.fieldNames(kind, row.observedRelease) : [];
    const unknown =
      row.serverRevision === null
        ? []
        : changedWhileHidden.filter((field) => !observed.includes(field));
    const next: RecordRow = {
      ...(unknown.length ? this.#setFieldEvidence(row, [...row.uncertainFields, ...unknown]) : row),
      ...this.#parentColumns(kind, normalized, row),
      localState: "live",
      localContent: normalized,
      partialFields: [...new Set([...row.partialFields, ...changedWhileHidden])].sort(),
      localBase: startsEdit
        ? row.serverState === "live"
          ? row.serverRevision
          : null
        : row.localBase,
      localSeq: row.localSeq + 1,
      reoffered: false,
      // As in delete(): a copy offered again after a restore still existed on the old server, so
      // remember it before the edit replaces it. Saving as new can then put it back.
      keptContent:
        row.keptContent ?? (row.reoffered && row.serverRevision === null ? row.localContent : null),
      status: row.status === "conflict" ? "conflict" : "pending",
      ...(row.status === "invalid"
        ? { problem: null, problemRevision: null, problemAt: null }
        : {}),
    };
    this.#write(next);
    return this.#view(next);
  }

  /** Deletes a record. Children disappear with it; the server deletes them too. */
  delete(kind: string, id: string): void {
    this.#mutate(() => this.#delete(kind, id));
  }

  #delete(kind: string, id: string): void {
    const definition = this.contract.kind(kind);
    if (definition.singletonId !== undefined || definition.parent?.sharedId) {
      throw new DeviceStoreError(`${kind} can be changed but not deleted`);
    }
    const row = this.#row(kind, id);
    if (!row) return;
    const inFlight = this.#submissionFor(kind, id);
    if (!this.#knownToServer(row) && !inFlight) {
      // Never reached the server: nothing to tell it.
      this.#purge(kind, id);
      return;
    }
    if (row.serverState === "deleted" && row.localState === null) return;
    this.#write({
      ...row,
      localState: "deleted",
      localContent: null,
      // During a restore the record may exist on the restored server; the download decides.
      localBase: row.localState === null ? row.serverRevision : row.localBase,
      localSeq: row.localSeq + 1,
      reoffered: false,
      // A copy offered again after a restore still existed on the old server: remember it, so
      // the deletion is sent and keeping theirs can bring the copy back.
      keptContent:
        row.keptContent ?? (row.reoffered && row.serverRevision === null ? row.localContent : null),
      status: row.status === "conflict" ? "conflict" : "pending",
      ...(row.status === "invalid"
        ? { problem: null, problemRevision: null, problemAt: null }
        : {}),
      partialFields: [],
    });
  }

  /** Whether a server may already hold this record, so its deletion must be sent. */
  #knownToServer(row: RecordRow): boolean {
    return row.serverRevision !== null || row.seenOnServer;
  }

  /** Removes a record and its descendants locally, including uploads in flight. */
  #purge(kind: string, id: string): void {
    this.#purgeDescendants(kind, id);
    this.db.run("DELETE FROM submissions WHERE kind = ? AND id = ?", [kind, id]);
    this.db.run("DELETE FROM records WHERE kind = ? AND id = ?", [kind, id]);
  }

  #purgeDescendants(kind: string, id: string): void {
    for (const child of this.#children(kind, id)) this.#dropUnder(kind, id, child);
  }

  /** Removes `child` because its parent `kind/id` is gone, unless the server keeps it elsewhere. */
  #dropUnder(kind: string, id: string, child: RecordRow): void {
    const serverParent =
      child.serverState === "live" && child.serverContent
        ? this.contract.parentOf(child.kind, child.serverContent)
        : null;
    if (serverParent && (serverParent.kind !== kind || serverParent.id !== id)) {
      // Only the local version sits under this record; the server keeps the record elsewhere.
      // A deletion the user asked for still applies there; an edit under this record goes.
      if (child.localState === "deleted") {
        this.#write({ ...child, ...this.#serverParent(child) });
        return;
      }
      this.db.run("DELETE FROM submissions WHERE kind = ? AND id = ?", [child.kind, child.id]);
      this.#write({
        ...child,
        ...this.#serverParent(child),
        localState: null,
        localContent: null,
        localBase: null,
        status: "synced",
        problem: null,
        problemRevision: null,
        problemAt: null,
        partialFields: [],
      });
      return;
    }
    this.#purge(child.kind, child.id);
  }

  #children(kind: string, id: string): RecordRow[] {
    return this.db
      .all("SELECT * FROM records WHERE parent_kind = ? AND parent_id = ?", [kind, id])
      .map(toRecordRow);
  }

  /** Whether any record below `kind/id`, locally or on the server, is in `keys`. */
  #descendantIn(kind: string, id: string, keys: Set<string>): boolean {
    const local = this.#children(kind, id).map((child) => ({ kind: child.kind, id: child.id }));
    const server = this.serverDescendants(kind, id);
    return [...local, ...server].some(
      (child) =>
        keys.has(`${child.kind}/${child.id}`) || this.#descendantIn(child.kind, child.id, keys),
    );
  }

  /**
   * Live descendants as this device last received them from the server, found through the
   * server copies' parents (a local version may name another parent).
   */
  serverDescendants(kind: string, id: string): { kind: string; id: string; revision: number }[] {
    return this.contract.childKinds(kind).flatMap((child) =>
      this.db
        .all(
          `SELECT kind, id, server_revision FROM records
           WHERE kind = ? AND server_state = 'live' AND json_extract(server_content, ?) = ?`,
          [child.kind, `$.${child.field}`, id],
        )
        .flatMap((row) => [
          { kind: String(row.kind), id: String(row.id), revision: Number(row.server_revision) },
          ...this.serverDescendants(String(row.kind), String(row.id)),
        ]),
    );
  }

  #hasUnsyncedLocalVersion(row: RecordRow): boolean {
    // Includes records offered again after a restore: nothing about them is decided quietly.
    return row.localState === "live" && row.status !== "synced";
  }

  /**
   * Settles the descendants of a record someone else deleted on the server. Children the user
   * changed are kept for review; the rest go. Returns whether anything was kept.
   */
  #parentDeletedOnServer(kind: string, id: string, revision: number, restoring = false): boolean {
    if (this.#row(kind, id)?.localState === "deleted") {
      // The user deleted this record too: what was below it goes, without review.
      this.#purgeDescendants(kind, id);
      return false;
    }
    let kept = false;
    for (const child of this.#children(kind, id)) {
      // A restored backup may still contain a child the user explicitly deleted.
      if (restoring && child.localState === "deleted") {
        kept = true;
        continue;
      }
      if (this.#hasUnsyncedLocalVersion(child)) {
        this.#write({
          ...child,
          status: "conflict",
          problem: "parent_deleted",
          problemRevision: revision,
          problemAt: this.#now(),
        });
        this.db.run("DELETE FROM submissions WHERE kind = ? AND id = ?", [child.kind, child.id]);
        this.#parentDeletedOnServer(child.kind, child.id, revision, restoring);
        kept = true;
      } else if (this.#parentDeletedOnServer(child.kind, child.id, revision, restoring)) {
        // An untouched child whose own children hold work stays, so the tree can be saved as new.
        this.#keepDeletedForReview(child, revision);
        kept = true;
      } else {
        this.#dropUnder(kind, id, child);
      }
    }
    return kept;
  }

  /** Keeps the last content of a record deleted elsewhere whose descendants hold unsynced work. */
  #keepDeletedForReview(row: RecordRow, revision: number): void {
    const content = row.localContent ?? row.serverContent;
    if (!content) return;
    this.db.run("DELETE FROM submissions WHERE kind = ? AND id = ?", [row.kind, row.id]);
    this.#write({
      ...row,
      serverRevision: Math.max(revision, row.serverRevision ?? 0),
      serverState: "deleted",
      serverContent: null,
      localState: "live",
      localContent: content,
      status: "conflict",
      problem: row.localState === null ? "deleted" : (row.problem ?? "deleted"),
      problemRevision: revision,
      problemAt: this.#now(),
    });
  }

  /**
   * The user's decision about a rejected local version:
   * - keep_mine resubmits it against the server's current revision;
   * - keep_theirs discards it (for a record deleted on the server, together with its descendants);
   * - save_as_new copies it, with every descendant still shown, under new ids. It is for records
   *   that were deleted on the server or never reached it.
   */
  resolve(kind: string, id: string, resolution: Resolution): DeviceRecord | null {
    return this.#mutate(() => this.#resolve(kind, id, resolution));
  }

  #resolve(kind: string, id: string, resolution: Resolution): DeviceRecord | null {
    const row = this.#row(kind, id);
    if (!row || (row.status !== "conflict" && row.status !== "invalid")) {
      throw new DeviceStoreError(`${kind}/${id} has nothing to resolve`);
    }
    if (this.#followsParentDeletion(row))
      throw new DeviceStoreError(
        "Resolve the workout deletion to decide whether to keep its rest setting.",
      );
    const cleared = { problem: null, problemRevision: null, problemAt: null };
    if (this.#tracksFieldEvidence && resolution.choice !== "save_as_new")
      this.db.run(
        "UPDATE submissions SET choice_after_dispatch = 1 WHERE kind = ? AND id = ? AND op = 'put'",
        [kind, id],
      );
    switch (resolution.choice) {
      case "keep_mine": {
        if (this.syncState().restoring) {
          throw new DeviceStoreError("wait until the download after the server restore finishes");
        }
        if (row.serverState === "deleted" || row.problem === "parent_deleted") {
          throw new DeviceStoreError("a deleted record can only be saved as a new record");
        }
        if (row.serverState === "unavailable") {
          throw new DeviceStoreError(`${kind}/${id} needs a newer app to overwrite`);
        }
        // Only a field visible on this connection and observed on this record
        // can acquire a new confirmed baseline from the user's choice.
        const sync = this.syncState();
        const connection = sync.refreshFrom ?? sync.release;
        const visible = connection ? this.contract.fieldNames(kind, connection) : [];
        const observed = row.observedRelease
          ? this.contract.fieldNames(kind, row.observedRelease)
          : [];
        const remaining = row.uncertainFields.filter(
          (field) => !visible.includes(field) || !observed.includes(field),
        );
        const next: RecordRow = {
          ...this.#setFieldEvidence(row, remaining),
          ...cleared,
          localBase: row.serverState === "live" ? row.serverRevision : null,
          localSeq: row.localSeq + 1,
          status: "pending",
          // The user chose this version: it is theirs now, not only offered again.
          reoffered: false,
        };
        this.#write(next);
        return this.#view(next);
      }
      case "keep_theirs": {
        if (this.syncState().restoring) {
          throw new DeviceStoreError("wait until the download after the server restore finishes");
        }
        if (
          row.serverRevision === null &&
          row.keptContent !== null &&
          row.problem !== "parent_deleted"
        ) {
          return this.#view(this.#offerKeptAgain(row, row.keptContent));
        }
        if (row.serverRevision === null) {
          // Never reached the server: discarding it discards what was recorded under it.
          this.#purge(kind, id);
          return null;
        }
        if (
          row.serverState === "live" &&
          row.serverContent &&
          this.#submissionFor(kind, id)?.op === "put"
        ) {
          // The old request may still write its visible measurements. Queue the
          // chosen revision as the next edit, atomically with the user's choice.
          // Omission tracking belongs only to the device. The retry's id, base
          // and wire bytes stay identical, but the user discarded the local fields.
          this.db.run("UPDATE submissions SET omitted = '[]' WHERE kind = ? AND id = ?", [
            kind,
            id,
          ]);
          const next: RecordRow = {
            ...this.#setFieldEvidence(row, []),
            ...this.#serverParent(row),
            ...cleared,
            localState: "live",
            localContent: row.serverContent,
            localBase: row.serverRevision,
            localSeq: row.localSeq + 1,
            reoffered: false,
            status: "pending",
            partialFields: [],
          };
          this.#write(next);
          return this.#view(next);
        }
        if (row.localState === "deleted" && row.serverState === "live") {
          // A shared-ID child cannot have been deleted independently. Accepting the
          // restored parent accepts its restored setting, including an absent setting.
          for (const { kind: childKind } of this.contract.childKinds(kind)) {
            if (!this.contract.kind(childKind).parent?.sharedId) continue;
            const child = this.#row(childKind, id);
            if (child?.localState === "deleted") {
              if (child.serverRevision === null) this.#purge(childKind, id);
              else this.#keepServerCopy(child);
            }
          }
        }
        return this.#view(this.#keepServerCopy(row));
      }
      case "save_as_new": {
        checkId(kind, resolution.newId);
        if (this.syncState().restoring) {
          throw new DeviceStoreError("wait until the download after the server restore finishes");
        }
        if (row.problem === "parent_deleted") {
          throw new DeviceStoreError("save the deleted parent as a new record instead");
        }
        if (row.localState !== "live" || !row.localContent) {
          throw new DeviceStoreError("only a kept version can be saved as a new record");
        }
        if (row.serverState !== "deleted" && row.serverRevision !== null) {
          throw new DeviceStoreError("only a deleted or never uploaded record can be saved as new");
        }
        if (this.contract.kind(kind).parent?.sharedId) {
          throw new DeviceStoreError("Save its parent as a new record to copy this setting.");
        }
        const kept = row.serverRevision === null ? row.keptContent : null;
        if (this.#row(kind, resolution.newId)) {
          throw new DeviceStoreError(`${kind}/${resolution.newId} already exists`);
        }
        const copy = this.#copyTree(row, resolution.newId, null);
        if (kept !== null) {
          // Theirs stays: the last server copies the restored server lacks are offered again.
          this.#offerKeptAgain(row, kept);
          this.#restoreKeptTree(kind, id);
        } else if (row.serverRevision === null) this.#purge(kind, id);
        else {
          this.#purgeDescendants(kind, id);
          this.#write({
            ...row,
            ...cleared,
            localState: null,
            localContent: null,
            localBase: null,
            status: "synced",
            partialFields: [],
          });
        }
        return this.#view(copy);
      }
    }
  }

  #keepServerCopy(row: RecordRow): RecordRow {
    if (row.serverState === "deleted") this.#purgeDescendants(row.kind, row.id);
    const next: RecordRow = {
      ...row,
      ...this.#serverParent(row),
      problem: null,
      problemRevision: null,
      problemAt: null,
      localState: null,
      localContent: null,
      localBase: null,
      status: "synced",
      partialFields: [],
    };
    this.#write(next);
    return next;
  }

  /**
   * After the user's tree was saved as new: what stays under the old id goes back to the last
   * server copies. The user's own new records live on in the copy only.
   */
  #restoreKeptTree(kind: string, id: string): void {
    for (const child of this.#children(kind, id)) {
      // Below first: a descendant's kept copy may belong under another parent.
      this.#restoreKeptTree(child.kind, child.id);
      const row = this.#row(child.kind, child.id);
      if (!row) continue;
      if (row.serverRevision === null && row.keptContent !== null) {
        this.#offerKeptAgain(row, row.keptContent);
      } else if (!this.#knownToServer(row)) {
        this.#purge(row.kind, row.id);
      } else if (row.serverRevision !== null && row.localState !== null) {
        // The restored server has it: back to its copy.
        this.db.run("DELETE FROM submissions WHERE kind = ? AND id = ?", [row.kind, row.id]);
        if (row.serverState === "deleted") {
          this.#purge(row.kind, row.id);
          continue;
        }
        this.#write({
          ...row,
          ...this.#serverParent(row),
          localState: null,
          localContent: null,
          localBase: null,
          status: "synced",
          problem: null,
          problemRevision: null,
          problemAt: null,
          partialFields: [],
        });
      }
    }
  }

  /**
   * Keeping theirs when the restored server lacks the record: its last server copy is offered
   * again, as for every record held without changes.
   */
  #offerKeptAgain(row: RecordRow, kept: JsonObject): RecordRow {
    const next: RecordRow = {
      ...row,
      ...this.#parentColumns(row.kind, kept, row),
      localState: "live",
      localContent: kept,
      localBase: null,
      status: "pending",
      problem: null,
      problemRevision: null,
      problemAt: null,
      partialFields: [],
      reoffered: true,
      keptContent: null,
    };
    this.#write(next);
    return next;
  }

  /**
   * The bulk choice after a server restore: keep the restored server's version of every record the
   * reset offered again (copies the user never changed and remembered deletions) that came back as
   * a conflict. Edits the user made are not included, nor is a record whose server version would
   * discard such an edit below it; those are reviewed one by one. Returns how many were resolved.
   */
  resolveRestored(): number {
    return this.#mutate(() => {
      if (this.syncState().restoring) {
        throw new DeviceStoreError("wait until the download after the server restore finishes");
      }
      const rows = this.db
        .all("SELECT kind, id FROM records WHERE status = 'conflict' AND reoffered = 1")
        .map((row) => ({ kind: String(row.kind), id: String(row.id) }));
      let resolved = 0;
      for (const { kind, id } of rows) {
        const row = this.#row(kind, id);
        // Settled meanwhile by a parent's resolution, or the user changed it.
        if (row?.status !== "conflict" || !row.reoffered || this.#followsParentDeletion(row))
          continue;
        // Keeping the server's version would discard the user's own work below it.
        if (this.#userWorkBelow(kind, id)) continue;
        this.#resolve(kind, id, { choice: "keep_theirs" });
        resolved++;
      }
      return resolved;
    });
  }

  /** Whether a record below `kind/id` holds a version the user wrote themselves. */
  #userWorkBelow(kind: string, id: string): boolean {
    return this.#children(kind, id).some(
      (child) =>
        (child.localState === "live" && !child.reoffered) ||
        this.#userWorkBelow(child.kind, child.id),
    );
  }

  /** Writes `row`'s shown content under `newId` as a new record, then its shown descendants. */
  #copyTree(row: RecordRow, newId: string, parentId: string | null): RecordRow {
    const shown = row.localState !== null ? row.localContent : row.serverContent;
    let content = shown as JsonObject;
    const parent = this.contract.kind(row.kind).parent;
    if (parent && parentId !== null) content = { ...content, [parent.field]: parentId };
    const copy: RecordRow = {
      ...this.#emptyRow(row.kind, newId),
      ...this.#parentColumns(row.kind, content, null),
      localState: "live",
      localContent: content,
      localSeq: 1,
      status: "pending",
    };
    this.#write(copy);
    for (const child of this.#children(row.kind, row.id)) {
      const childShown = child.localState !== null ? child.localState : child.serverState;
      if (childShown !== "live") continue;
      const childId = this.contract.kind(child.kind).parent?.sharedId ? newId : this.#randomId();
      this.#copyTree(child, childId, newId);
    }
    return copy;
  }

  /* ---------- sync ---------- */

  /** Remembers which server and account this device syncs with. Never reused for another. */
  bindAccount(server: string, account: string): void {
    this.#mutate(() => {
      const state = this.syncState();
      if (state.account !== null && (state.account !== account || state.server !== server)) {
        throw new DeviceStoreError("this device's sync state belongs to another account or server");
      }
      this.db.run("UPDATE sync_state SET server = ?, account = ? WHERE id = 1", [server, account]);
    });
  }

  /** Records the negotiated release; partially synced records the release can now carry resend. */
  setNegotiated(release: ReleaseId, features: readonly string[], lineage?: string): void {
    this.#mutate(() => {
      const before = this.syncState();
      if (
        before.release &&
        before.release !== release &&
        (before.refreshFrom || compareReleases(before.release, release) < 0)
      ) {
        // Cursor, source release and upload barrier survive termination together.
        const from =
          before.refreshFrom && compareReleases(before.refreshFrom, before.release) < 0
            ? before.refreshFrom
            : before.release;
        this.db.run("UPDATE sync_state SET cursor = 0, refresh_from = ? WHERE id = 1", [from]);
      }
      this.db.run("UPDATE sync_state SET release = ?, features = ? WHERE id = 1", [
        release,
        json([...features]),
      ]);
      if (lineage !== undefined) {
        this.db.run("UPDATE sync_state SET lineage = ? WHERE id = 1", [lineage]);
      }
      for (const raw of this.db.all("SELECT * FROM records WHERE status = 'partial'")) {
        const row = toRecordRow(raw);
        if (!this.contract.hasKind(row.kind, release)) continue;
        const available = new Set(this.contract.fieldNames(row.kind, release));
        if (row.partialFields.some((field) => available.has(field))) {
          this.#write({ ...row, status: "pending" });
        }
      }
    });
  }

  #depth(kind: string): number {
    let depth = 0;
    let parent = this.contract.kind(kind).parent;
    while (parent && depth < 8) {
      depth += 1;
      parent = this.contract.kind(parent.kind).parent;
    }
    return depth;
  }

  /**
   * Uploads to send now: every submission still in flight, unchanged, and new ones for pending
   * records. New submissions are stored before they are returned, so a crash right after sending
   * resends the same submission id and content.
   */
  prepareSubmissions(release: ReleaseId, limit = 100, maxBytes = 800_000): OutgoingSubmission[] {
    return this.#mutate(() => {
      const sync = this.syncState();
      if (sync.refreshFrom) return [];
      const outgoing: OutgoingSubmission[] = this.db
        // Resend in the order first queued (parents before children). Timestamps tie within a
        // millisecond and ids are random, so only the insertion order (rowid) keeps that.
        .all("SELECT * FROM submissions ORDER BY rowid")
        .map(toSubmissionRow)
        .map((row) => this.#outgoing(row));
      const inFlight = new Set(outgoing.map((o) => `${o.submission.kind}/${o.submission.id}`));
      const pending = this.db
        .all("SELECT * FROM records WHERE status = 'pending'")
        .map(toRecordRow)
        .filter((row) => !inFlight.has(`${row.kind}/${row.id}`))
        .filter((row) => this.contract.hasKind(row.kind, release));
      const puts = pending
        .filter((row) => row.localState === "live")
        .sort((a, b) => this.#depth(a.kind) - this.#depth(b.kind));
      const deletes = pending
        .filter((row) => row.localState === "deleted")
        .sort((a, b) => this.#depth(b.kind) - this.#depth(a.kind));
      const batch = new Set(inFlight);
      let bytes = outgoing.reduce((total, item) => total + jsonBytes(item.submission), 0);
      for (const row of [...puts, ...deletes]) {
        if (outgoing.length >= limit || (outgoing.length > 0 && bytes >= maxBytes)) break;
        if (!this.#ready(row, batch)) continue;
        // A legacy wire copy cannot confirm that a restored record matches our local version.
        if (
          sync.restoring &&
          row.localState === "live" &&
          this.#hiddenRestoreFields(row, this.contract.fieldNames(row.kind, release)).length
        )
          continue;
        const descendants =
          row.localState === "deleted" ? this.serverDescendants(row.kind, row.id) : null;
        // The earlier peer cannot validate this deletion. Leave it pending, so
        // other edits can upload and a later negotiation can send the whole tree.
        if (descendants?.some((child) => !this.contract.hasKind(child.kind, release))) continue;
        if (descendants && descendants.length > MAX_DESCENDANTS) {
          // The server would refuse the whole request; hold this deletion back for the user to
          // review instead, so it doesn't block every other upload.
          this.#write({
            ...row,
            status: "invalid",
            problem: "invalid:too_many_descendants",
            problemRevision: null,
            problemAt: this.#now(),
          });
          continue;
        }
        const created = this.#outgoing(this.#createSubmission(row, release, descendants));
        outgoing.push(created);
        bytes += jsonBytes(created.submission);
        batch.add(`${row.kind}/${row.id}`);
      }
      return outgoing;
    });
  }

  /** Older envelopes listed every non-null omitted value, including cached values.
   * A later local edit can also clear one. Neither the old wire nor its receipt
   * can settle which value belonged to the lifter before a richer download. */
  #withUnconfirmedFields(row: RecordRow, submission: SubmissionRow | null): RecordRow {
    if (!row.localContent || !submission?.omitted.length) return row;
    const outstanding = submission.omitted.filter((field) => !row.partialFields.includes(field));
    return outstanding.length
      ? { ...row, partialFields: [...row.partialFields, ...outstanding].sort() }
      : row;
  }

  /** Retain later edits before discarding the last evidence of a possibly accepted upload. */
  #beforeDroppingSubmission(
    row: RecordRow,
    submission: SubmissionRow | null,
    replacement: ReleaseId | null,
  ): RecordRow {
    let kept = this.#withUnconfirmedFields(row, submission);
    if (!submission?.wireContent || !row.localContent) return kept;
    const visible = replacement ? this.contract.fieldNames(row.kind, replacement) : [];
    const possibleWrites = Object.entries(submission.wireContent)
      .filter(
        ([field, value]) =>
          !visible.includes(field) &&
          (!row.serverContent || !jsonEqual(value ?? null, row.serverContent[field] ?? null)),
      )
      .map(([field]) => field);
    if (possibleWrites.length)
      kept = this.#setFieldEvidence(kept, [...kept.uncertainFields, ...possibleWrites]);
    if (row.localSeq <= submission.localSeq) return kept;
    const withheld = Object.entries(submission.wireContent)
      .filter(
        ([field, value]) =>
          !visible.includes(field) && !jsonEqual(value, row.localContent?.[field]),
      )
      .map(([field]) => field);
    return withheld.length
      ? { ...kept, partialFields: [...new Set([...kept.partialFields, ...withheld])].sort() }
      : kept;
  }

  #hiddenRestoreFields(row: RecordRow, visible: readonly string[]): string[] {
    const observed = row.observedRelease
      ? this.contract.fieldNames(row.kind, row.observedRelease)
      : [];
    return Object.entries(row.localContent ?? {})
      .filter(
        ([field, value]) =>
          !visible.includes(field) &&
          (observed.includes(field) ||
            value != null ||
            row.partialFields.includes(field) ||
            row.uncertainFields.includes(field)),
      )
      .map(([field]) => field);
  }

  /** A partial field is an outstanding choice even if the old wire showed no value. */
  #hasFieldEdit(row: RecordRow, field: string): boolean {
    return (
      row.partialFields.includes(field) ||
      !jsonEqual(row.localContent?.[field] ?? null, row.serverContent?.[field] ?? null)
    );
  }

  #hasNewFieldConflict(row: RecordRow, incoming: JsonObject, previous: ReleaseId): boolean {
    const visibleBefore = this.contract.fieldNames(row.kind, previous);
    return Object.entries(incoming).some(
      ([field, remote]) =>
        !visibleBefore.includes(field) &&
        this.#hasFieldEdit(row, field) &&
        !jsonEqual(remote, row.localContent?.[field] ?? null) &&
        (!row.serverContent ||
          row.uncertainFields.includes(field) ||
          !jsonEqual(remote, row.serverContent[field] ?? null)),
    );
  }

  /** A record waits while an ancestor is being deleted here, or hasn't reached the server yet. */
  #ready(row: RecordRow, batch: Set<string>): boolean {
    // During a restore a deletion waits for the download to show the record's restored revision.
    if (row.localState === "deleted" && row.localBase === null && this.syncState().restoring) {
      return false;
    }
    // A detached shared-ID tombstone can be replayed only after its owner's deletion.
    const ownership = this.contract.kind(row.kind).parent;
    if (row.localState === "deleted" && ownership?.sharedId) {
      return this.#row(ownership.kind, row.id)?.serverState === "deleted";
    }
    // A deletion lists the descendants as the server has them: wait until none is being uploaded.
    if (row.localState === "deleted" && this.#descendantIn(row.kind, row.id, batch)) return false;
    if (!row.parentKind || !row.parentId) return true;
    const parent = this.#row(row.parentKind, row.parentId);
    if (!parent) return true;
    if (parent.localState === "deleted") return false;
    if (parent.serverRevision === null && !batch.has(`${parent.kind}/${parent.id}`)) return false;
    return this.#ready(parent, batch);
  }

  #createSubmission(
    row: RecordRow,
    release: ReleaseId,
    descendants: SubmissionRow["descendants"],
  ): SubmissionRow {
    const submissionId = this.#randomId();
    let wireContent: JsonObject | null = null;
    let omitted: string[] = [];
    if (row.localState === "live" && row.localContent) {
      const encoded = this.contract.encode(row.kind, row.localContent, release);
      wireContent = encoded.content;
      // A field in a full local record may simply be a cached server value. Only
      // withhold edits, including an explicit clear or a version the user kept.
      const clears = Object.entries(row.localContent)
        .filter(([field, value]) => value === null && !Object.hasOwn(encoded.content, field))
        .map(([field]) => field);
      omitted = [...encoded.omitted, ...clears]
        .filter((field) => this.#hasFieldEdit(row, field))
        .sort();
    }
    const submission: SubmissionRow = {
      submissionId,
      kind: row.kind,
      id: row.id,
      op: row.localState === "live" ? "put" : "delete",
      baseRevision: row.localBase,
      localSeq: row.localSeq,
      release,
      wireContent,
      descendants,
      omitted,
      choiceAfterDispatch: false,
    };
    this.db.run(
      `INSERT INTO submissions (submission_id, kind, id, op, base_revision, local_seq, release,
         wire_content, descendants, omitted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        submissionId,
        row.kind,
        row.id,
        submission.op,
        row.localBase,
        row.localSeq,
        release,
        wireContent === null ? null : json(wireContent),
        descendants === null ? null : json(descendants),
        json(omitted),
        this.#now(),
      ],
    );
    return submission;
  }

  #outgoing(row: SubmissionRow): OutgoingSubmission {
    if (row.op === "put") {
      return {
        release: row.release,
        submission: {
          op: "put",
          submissionId: row.submissionId,
          kind: row.kind,
          id: row.id,
          baseRevision: row.baseRevision,
          content: row.wireContent as JsonObject,
        },
      };
    }
    return {
      release: row.release,
      submission: {
        op: "delete",
        submissionId: row.submissionId,
        kind: row.kind,
        id: row.id,
        baseRevision: row.baseRevision,
        descendants: row.descendants ?? [],
      },
    };
  }

  /**
   * Drops in-flight submissions made for a release the server no longer accepts. The records stay
   * pending and are sent again as new submissions; if the server had already accepted one, the
   * repeat is recognised because its content equals the current copy.
   */
  abandonSubmissions(release: ReleaseId): number {
    return this.#mutate(() => {
      const abandoned = this.db
        .all("SELECT * FROM submissions WHERE release = ?", [release])
        .map(toSubmissionRow);
      const replacement = this.syncState().release;
      for (const submission of abandoned) {
        const row = this.#row(submission.kind, submission.id);
        if (row) {
          const kept = this.#beforeDroppingSubmission(row, submission, replacement);
          if (
            submission.op === "put" &&
            submission.baseRevision === null &&
            row.serverRevision === null
          )
            this.#write({ ...kept, seenOnServer: true });
          else if (kept !== row) this.#write(kept);
        }
      }
      this.db.run("DELETE FROM submissions WHERE release = ?", [release]);
      // Its reply may have been lost after commit. Keep any subsequent deletion
      // until a compatible server confirms it or presents its live copy for review.
      return abandoned.length;
    });
  }

  /**
   * An explicit retry_later confirms that the server did not store this create.
   */
  #settleUnsentDeletion(kind: string, id: string): void {
    const row = this.#row(kind, id);
    if (row?.localState === "deleted" && !this.#knownToServer(row)) {
      this.#purge(kind, id);
    }
  }

  /** The server may later speak an older release or restore a backup. Keep the
   * distinction between a field that was projected out and a confirmed null. */
  #observeRelease(kind: string, id: string, revision: number, release: ReleaseId): void {
    if (release === this.contract.releases[0]) return;
    const row = this.#row(kind, id);
    if (row?.serverRevision !== revision || row.serverState !== "live") return;
    if (!row.observedRelease || compareReleases(row.observedRelease, release) < 0) {
      this.db.run("UPDATE records SET observed_release = ? WHERE kind = ? AND id = ?", [
        release,
        kind,
        id,
      ]);
    }
  }

  /** Applies the server's answers. Answers for unknown submission ids are ignored. */
  applyPushResults(
    results: readonly SubmissionResult[],
    written: ReadonlySet<string> = new Set(),
  ): void {
    this.#mutate(() => {
      for (const result of results) {
        const raw = this.db.get("SELECT * FROM submissions WHERE submission_id = ?", [
          result.submissionId,
        ]);
        if (!raw) continue;
        const submission = toSubmissionRow(raw);
        this.db.run("DELETE FROM submissions WHERE submission_id = ?", [submission.submissionId]);
        const row = this.#row(submission.kind, submission.id);
        if (!row) continue;
        // An old in-flight reply can arrive after a release refresh. If it advances
        // our revision, its missing fields must be fetched again before newer writes.
        const { release: negotiated, refreshFrom } = this.syncState();
        const revision =
          result.status === "accepted" && submission.op === "put"
            ? result.revision
            : result.status === "conflict" && result.current?.state === "live"
              ? result.current.revision
              : null;
        if (
          negotiated &&
          compareReleases(submission.release, negotiated) < 0 &&
          revision !== null &&
          revision > (row.serverRevision ?? 0)
        ) {
          this.db.run("UPDATE sync_state SET refresh_from = ?, cursor = 0 WHERE id = 1", [
            refreshFrom && compareReleases(refreshFrom, submission.release) < 0
              ? refreshFrom
              : submission.release,
          ]);
        }
        // A richer download or an explicit conflict resolution already discarded
        // the local version. Retire its receipt; pulls own the authoritative copy.
        if (row.localState === null && submission.op === "put") continue;
        switch (result.status) {
          case "accepted":
            this.#accepted(row, submission, result.revision, written.has(submission.submissionId));
            if (submission.op === "put")
              this.#observeRelease(row.kind, row.id, result.revision, submission.release);
            break;
          case "conflict":
            // A newer local choice already used this revision. Its predecessor's
            // stale receipt cannot turn that same choice back into a conflict.
            if (
              row.status === "pending" &&
              row.localSeq > submission.localSeq &&
              row.localBase !== null &&
              result.current &&
              result.current.revision <= row.localBase
            )
              break;
            this.#conflict(row, result.reason, result.current);
            if (result.current?.state === "live")
              this.#observeRelease(row.kind, row.id, result.current.revision, submission.release);
            break;
          case "retry_later":
            // Stays pending; sent again once its parent is on the server.
            this.#settleUnsentDeletion(row.kind, row.id);
            break;
          case "invalid":
            if (row.localSeq > submission.localSeq) break; // A newer edit is sent next.
            this.#write({
              ...row,
              status: "invalid",
              problem: `invalid:${result.code}`,
              problemRevision: null,
              problemAt: this.#now(),
            });
            break;
        }
      }
    });
  }

  #accepted(
    row: RecordRow,
    submission: SubmissionRow,
    revision: number,
    wroteRevision: boolean,
  ): void {
    if (submission.op === "delete") {
      // This device's own deletion: everything under the record goes, as it did on the server.
      this.#purgeDescendants(row.kind, row.id);
      if (row.localSeq > submission.localSeq) {
        // The user changed the record again while the deletion was in flight: keep that edit,
        // based on the deletion's revision, so the server can answer it.
        this.#write({
          ...row,
          serverRevision: Math.max(revision, row.serverRevision ?? 0),
          serverState: "deleted",
          serverContent: null,
          localBase: revision,
        });
        return;
      }
      this.#write({
        ...row,
        serverRevision: Math.max(revision, row.serverRevision ?? 0),
        serverState: "deleted",
        serverContent: null,
        localState: null,
        localContent: null,
        localBase: null,
        status: "synced",
        partialFields: [],
        problem: null,
        problemRevision: null,
        problemAt: null,
      });
      return;
    }
    const wire = submission.wireContent as JsonObject;
    if (!wroteRevision && revision !== submission.baseRevision && row.localContent) {
      // Equal visible fields can acknowledge another writer's revision. Such a
      // receipt provides no baseline for local edits outside the wire projection.
      const hidden = Object.keys(row.localContent).filter(
        (field) =>
          !Object.hasOwn(wire, field) &&
          (submission.omitted.includes(field) || this.#hasFieldEdit(row, field)),
      );
      if (hidden.length) row = this.#setFieldEvidence(row, [...row.uncertainFields, ...hidden]);
    }
    const stored = row.serverState === "live" ? row.serverContent : null;
    const serverContent =
      row.serverRevision !== null && row.serverRevision > revision
        ? row.serverContent
        : this.contract.applyOmissionRule(row.kind, stored, wire, submission.release);
    const serverRevision = Math.max(revision, row.serverRevision ?? 0);
    const serverState =
      row.serverRevision !== null && row.serverRevision > revision ? row.serverState : "live";
    if (row.localState === "deleted" && serverState === "deleted") {
      // A newer pull already confirmed the deletion while this put waited for its receipt.
      this.#settleMatchingDeletion(row);
      return;
    }
    // Equal projected content can acknowledge a different writer's revision.
    // Only a write receipt proves that the pending cascade already covered this edit.
    if (!wroteRevision && serverContent && revision > (row.serverRevision ?? 0))
      this.#reviewPendingAncestorDeletion(row.kind, serverContent);
    if (
      !wroteRevision &&
      row.localState === "deleted" &&
      row.status === "pending" &&
      revision === serverRevision &&
      revision > (row.localBase ?? 0)
    ) {
      // The older projection matched, but the lifter never reviewed this version for deletion.
      this.#write({
        ...row,
        serverRevision,
        serverState,
        serverContent,
        status: "conflict",
        problem: "stale",
        problemRevision: serverRevision,
        problemAt: this.#now(),
      });
      return;
    }
    if (
      row.localSeq > submission.localSeq ||
      (row.status === "conflict" && submission.omitted.length)
    ) {
      const stillWithheld = row.partialFields.filter(
        (field) =>
          !Object.hasOwn(wire, field) ||
          !jsonEqual(wire[field] ?? null, row.localContent?.[field] ?? null),
      );
      const withheld = [...new Set([...stillWithheld, ...submission.omitted])].sort();
      // A legacy peer also accepts equal content written by someone else. Its receipt
      // cannot authorize overwriting visible measurements beyond the reviewed revision.
      if (
        submission.choiceAfterDispatch &&
        !(wroteRevision && submission.baseRevision === row.localBase) &&
        row.status === "pending" &&
        row.localState === "live" &&
        row.localBase !== null &&
        revision > row.localBase &&
        row.observedRelease &&
        compareReleases(row.observedRelease, submission.release) > 0 &&
        Object.entries(wire).some(
          ([field, value]) => !jsonEqual(value, row.localContent?.[field] ?? null),
        )
      ) {
        this.#write({
          ...row,
          serverRevision,
          serverContent,
          serverState,
          partialFields: withheld,
          status: "conflict",
          problem: "stale",
          problemRevision: serverRevision,
          problemAt: this.#now(),
        });
        return;
      }
      // This receipt settles its envelope, not a subsequent edit or a conflict
      // revealed by a richer download while the old envelope was in flight.
      this.#write({
        ...row,
        serverRevision,
        serverState,
        serverContent,
        localBase: Math.max(row.localBase ?? 0, revision),
        partialFields: withheld,
      });
      return;
    }
    if (submission.omitted.length > 0) {
      if (serverRevision > revision) {
        // A newer server copy already arrived, so the left-out values can't be sent on this base.
        this.#write({
          ...row,
          serverRevision,
          serverState,
          serverContent,
          localBase: revision,
          status: "conflict",
          problem: serverState === "deleted" ? "deleted" : "stale",
          problemRevision: serverRevision,
          problemAt: this.#now(),
          // A differing live value remains explicitly present in the conflict.
          // Keep a marker when an older projection makes the two values look equal.
          partialFields: submission.omitted.filter(
            (field) =>
              row.partialFields.includes(field) ||
              jsonEqual(row.localContent?.[field] ?? null, serverContent?.[field] ?? null),
          ),
        });
        return;
      }
      // An older envelope may be acknowledged after negotiation of a newer release.
      const release = this.syncState().release ?? submission.release;
      const available = this.contract.fieldNames(row.kind, release);
      const canResend = submission.omitted.some((field) => available.includes(field));
      this.#write({
        ...row,
        serverRevision,
        serverState,
        serverContent,
        localBase: revision,
        status: canResend ? "pending" : "partial",
        partialFields: submission.omitted,
      });
      return;
    }
    this.#write({
      ...row,
      ...this.#serverParent({ ...row, serverState, serverContent }),
      serverRevision,
      serverState,
      serverContent,
      localState: null,
      localContent: null,
      localBase: null,
      status: "synced",
      partialFields: [],
    });
  }

  #conflict(row: RecordRow, reason: string, current: Change | null): void {
    const updated = current ? this.#withServerCopy(row, current) : row;
    if (updated.localState === "deleted" && updated.serverState === "deleted") {
      this.#settleMatchingDeletion(updated);
      return;
    }
    this.#write({
      ...updated,
      status: "conflict",
      problem: reason,
      problemRevision: current?.revision ?? null,
      problemAt: this.#now(),
    });
  }

  #settleMatchingDeletion(row: RecordRow): void {
    this.#purgeDescendants(row.kind, row.id);
    this.#write({
      ...row,
      localState: null,
      localContent: null,
      localBase: null,
      status: "synced",
      problem: null,
      problemRevision: null,
      problemAt: null,
      partialFields: [],
    });
  }

  /** Whether the local version is exactly the server copy: live with equal content, or deleted. */
  #matchesServer(row: RecordRow): boolean {
    if (row.localState === "deleted") return row.serverState === "deleted";
    return (
      row.localState === "live" &&
      row.serverState === "live" &&
      jsonEqual(row.localContent, row.serverContent)
    );
  }

  #withServerCopy(
    row: RecordRow,
    change: Change,
    refreshFrom?: ReleaseId | null,
    restoring = false,
  ): RecordRow {
    if (
      row.serverRevision !== null &&
      (row.serverRevision > change.revision ||
        (!refreshFrom && row.serverRevision === change.revision))
    )
      return row;
    const content =
      change.state === "live"
        ? this.contract.normalize(row.kind, { ...row.serverContent, ...change.content })
        : null;
    if (content && change.revision !== row.serverRevision)
      this.#reviewPendingAncestorDeletion(row.kind, content);
    let localContent = row.localContent;
    // An older release that lacked this entire kind never supplied a partial
    // record. Its later appearance must be compared with the entire local copy.
    if (
      refreshFrom &&
      this.contract.hasKind(row.kind, refreshFrom) &&
      localContent &&
      content &&
      change.state === "live"
    ) {
      localContent = { ...localContent };
      // A restore must compare all previously observed fields, including known clears.
      // Only fields the previous copy could not see may be filled from the restored history.
      const baseline =
        (restoring || row.problem === "restored") &&
        row.observedRelease &&
        compareReleases(row.observedRelease, refreshFrom) > 0
          ? row.observedRelease
          : refreshFrom;
      const olderFields = this.contract.fieldNames(row.kind, baseline);
      for (const [field, value] of Object.entries(change.content)) {
        if (
          olderFields.includes(field) ||
          row.partialFields.includes(field) ||
          row.uncertainFields.includes(field)
        )
          continue;
        // A local-only value withheld from an older server is still the user's edit.
        if (
          !Object.hasOwn(localContent, field) ||
          (jsonEqual(localContent[field] ?? null, row.serverContent?.[field] ?? null) &&
            // A lineage reset moved the previous server copy into keptContent. A null
            // that cleared its value is an edit, even while serverContent is absent.
            (row.serverContent !== null || row.keptContent?.[field] == null))
        )
          localContent[field] = value;
      }
    }
    return {
      ...row,
      ...(content ? this.#parentColumns(row.kind, row.localContent ?? content, row) : {}),
      localContent,
      serverRevision: change.revision,
      serverState: change.state,
      serverContent: content,
    };
  }

  /** A queued cascade must not adopt a descendant revision downloaded after the user chose deletion. */
  #reviewPendingAncestorDeletion(kind: string, content: JsonObject) {
    let parent = this.contract.parentOf(kind, content);
    while (parent) {
      const owner = this.#row(parent.kind, parent.id);
      if (!owner) return;
      if (
        owner.localState === "deleted" &&
        owner.status === "pending" &&
        owner.serverState === "live"
      ) {
        this.#write({
          ...owner,
          status: "conflict",
          problem: "stale",
          problemRevision: owner.serverRevision,
          problemAt: this.#now(),
        });
      }
      parent = owner.serverContent ? this.contract.parentOf(owner.kind, owner.serverContent) : null;
    }
  }

  /**
   * Applies one downloaded page and saves the cursor in the same transaction. Downloads update the
   * server copy only; a pending edit keeps the revision it started from. With `requested`, the page
   * is dropped (and false returned) when the cursor or lineage changed since it was requested, for
   * example because a reset ran meanwhile.
   */
  applyPull(
    changes: readonly Change[],
    cursor: number,
    requested?: { cursor: number; lineage: string | null; release?: ReleaseId; lastPage?: boolean },
  ): boolean {
    return this.#mutate(() => {
      if (requested) {
        const state = this.syncState();
        if (
          state.cursor !== requested.cursor ||
          state.lineage !== requested.lineage ||
          (requested.release && requested.release !== state.release)
        )
          return false;
      }
      const { restoring, refreshFrom } = this.syncState();
      for (const change of changes) {
        if (!this.contract.hasKind(change.kind)) continue;
        const stored = this.#row(change.kind, change.id);
        const existing =
          refreshFrom && stored?.localState === "live"
            ? this.#withUnconfirmedFields(stored, this.#submissionFor(change.kind, change.id))
            : stored;
        if (
          existing?.serverRevision != null &&
          (existing.serverRevision > change.revision ||
            (!refreshFrom && existing.serverRevision === change.revision))
        )
          continue;
        const row = this.#withServerCopy(
          existing ?? this.#emptyRow(change.kind, change.id),
          change,
          refreshFrom,
          restoring,
        );
        if (
          (restoring || row.problem === "restored") &&
          change.state === "live" &&
          row.localState === "live" &&
          row.localContent
        ) {
          // A downgraded restored peer cannot establish equality for fields it cannot show.
          // Keep the local values available for review until a download can compare them.
          const hidden = this.#hiddenRestoreFields(row, Object.keys(change.content));
          if (hidden.length) {
            if (row.status === "invalid") {
              this.#write({ ...row, partialFields: hidden });
              continue;
            }
            this.#write({
              ...row,
              status: "conflict",
              problem: "restored",
              problemRevision: change.revision,
              problemAt: row.problemAt ?? this.#now(),
              partialFields: hidden,
            });
            continue;
          }
          if (row.problem === "restored" && this.#matchesServer(row)) {
            this.#write({
              ...row,
              status: "synced",
              localState: null,
              localContent: null,
              localBase: null,
              partialFields: [],
              problem: null,
              problemRevision: null,
              problemAt: null,
            });
            continue;
          }
        }
        if (
          refreshFrom &&
          existing?.localContent &&
          (!restoring || existing.serverContent || existing.partialFields.length > 0) &&
          change.state === "live" &&
          row.status !== "conflict" &&
          row.status !== "invalid" &&
          this.#hasNewFieldConflict(existing, change.content, refreshFrom)
        ) {
          // A receipt for the older projection can advance the row revision without
          // acknowledging a withheld value. Compare that value on the richer download.
          this.#write({
            ...row,
            status: "conflict",
            problem: "stale",
            problemRevision: change.revision,
            problemAt: this.#now(),
          });
          continue;
        }
        if (refreshFrom && existing?.serverRevision === change.revision) {
          this.#write(row);
          continue;
        }
        const inFlight = this.#submissionFor(change.kind, change.id) !== null;
        if (row.localState === null) {
          if (
            change.state === "deleted" &&
            this.#parentDeletedOnServer(change.kind, change.id, change.revision) &&
            existing
          ) {
            // Something under it holds unsynced work: keep it so the tree can be saved as new.
            this.#keepDeletedForReview(existing, change.revision);
            continue;
          }
          this.#write({
            ...row,
            ...(change.state === "live"
              ? this.#parentColumns(change.kind, row.serverContent, row)
              : {}),
          });
          continue;
        }
        const carried = restoring && row.status === "conflict";
        const heldDeletion =
          (row.status === "conflict" || row.status === "invalid") && row.localState === "deleted";
        if (!inFlight && (carried || heldDeletion) && this.#matchesServer(row)) {
          // A restored conflict or held deletion now agrees with the server.
          if (change.state === "deleted") {
            this.#settleMatchingDeletion(row);
            continue;
          }
          this.#write({
            ...row,
            localState: null,
            localContent: null,
            localBase: null,
            status: "synced",
            problem: null,
            problemRevision: null,
            problemAt: null,
            partialFields: [],
          });
          continue;
        }
        if (row.status === "conflict" && row.problem === "restored" && !inFlight) {
          // A conflict carried through the restore now shows the restored server's copy.
          if (change.state === "deleted")
            this.#parentDeletedOnServer(change.kind, change.id, change.revision);
          this.#write({ ...row, problemRevision: change.revision });
          continue;
        }
        if (inFlight || (row.status !== "pending" && row.status !== "partial")) {
          // The answer to the upload in flight, or the user's pending review, decides.
          if (change.state === "deleted")
            this.#parentDeletedOnServer(change.kind, change.id, change.revision);
          this.#write(row);
          continue;
        }
        if (row.localState === "deleted" && row.localBase === null && change.state !== "deleted") {
          // A deletion kept across a server restore, of a record the restored server has: the
          // user decides whether to delete it again (keep mine) or keep it (keep theirs).
          this.#write({
            ...row,
            status: "conflict",
            problem: "restored",
            problemRevision: change.revision,
            problemAt: this.#now(),
          });
          continue;
        }
        if (change.state === "deleted") {
          this.#parentDeletedOnServer(change.kind, change.id, change.revision);
          if (row.localState === "deleted") {
            this.#write({
              ...row,
              localState: null,
              localContent: null,
              localBase: null,
              status: "synced",
            });
          } else {
            this.#write({
              ...row,
              status: "conflict",
              problem: "deleted",
              problemRevision: change.revision,
              problemAt: this.#now(),
            });
          }
          continue;
        }
        if (
          change.state === "live" &&
          row.localState === "live" &&
          row.partialFields.every((field) => Object.hasOwn(change.content, field)) &&
          jsonEqual(row.localContent, row.serverContent)
        ) {
          // Someone else already made exactly this change.
          this.#write({
            ...row,
            localState: null,
            localContent: null,
            localBase: null,
            partialFields: [],
            status: "synced",
          });
          continue;
        }
        if (row.localBase !== null) {
          // The server moved past the version this edit started from: it will be rejected.
          this.#write({
            ...row,
            status: "conflict",
            problem: "stale",
            problemRevision: change.revision,
            problemAt: this.#now(),
          });
          continue;
        }
        this.#write(row);
      }
      if (requested?.release && requested.release !== this.contract.releases[0]) {
        for (const change of changes) {
          if (change.state === "live")
            this.#observeRelease(change.kind, change.id, change.revision, requested.release);
        }
      }
      this.db.run("UPDATE sync_state SET cursor = ? WHERE id = 1", [cursor]);
      if (refreshFrom && requested?.lastPage)
        this.db.run("UPDATE sync_state SET refresh_from = NULL WHERE id = 1");
      return true;
    });
  }

  /** A shared-ID tombstone proves its owner was deleted, even if the next page never arrived. */
  #recoverInterruptedCascades(): void {
    for (const raw of this.db.all("SELECT * FROM records WHERE server_state = 'deleted'")) {
      const child = toRecordRow(raw);
      const relation = this.contract.kind(child.kind).parent;
      if (!relation?.sharedId || child.serverRevision === null) continue;
      const owner = this.#row(relation.kind, child.id);
      if (
        !owner ||
        (owner.serverState !== "live" &&
          !(owner.serverState === null && owner.localState === "live"))
      )
        continue;
      // Apply the deletion to the old lineage before the restore drops its server
      // copies. Keep an edited workout or subtree for an explicit restore decision.
      const descendantsNeedReview = this.#parentDeletedOnServer(
        owner.kind,
        owner.id,
        child.serverRevision,
        true,
      );
      if (owner.localState === "live" || descendantsNeedReview) {
        this.#keepDeletedForReview(owner, child.serverRevision);
        if (!child.localState) this.#purge(child.kind, child.id);
      } else {
        this.#write({ ...owner, serverState: "deleted", serverContent: null });
        // A detached tombstone survives removal of the cached workout's descendants.
        this.#write({ ...child, parentKind: null, parentId: null });
      }
    }
  }

  /**
   * After the server answered that the cursor is ahead of it (for example after a server restore):
   * forget server copies and download everything again. Records without local changes are offered
   * to the server again as new; ones it still has with equal content are simply confirmed, and every
   * other difference becomes a conflict for the user to review. Nothing is decided quietly.
   * Deletions this device knows about wait for the download: a deletion of a record the restored
   * server has is reviewed; one of a record it doesn't have is sent, so the server keeps a marker.
   */
  resetForServerRestore(): void {
    this.#mutate(() => {
      // Settling an inferred cascade can retire uploads for edited descendants.
      // Capture their field evidence before either the cascade or reset drops them.
      for (const raw of this.db.all("SELECT * FROM submissions WHERE op = 'put'")) {
        const submission = toSubmissionRow(raw);
        const row = this.#row(submission.kind, submission.id);
        if (!row) continue;
        const kept = this.#beforeDroppingSubmission(row, submission, null);
        if (submission.baseRevision === null && row.serverRevision === null)
          this.#write({ ...kept, seenOnServer: true });
        else if (kept !== row) this.#write(kept);
      }
      this.#recoverInterruptedCascades();
      for (const raw of this.db.all("SELECT * FROM records")) {
        const row = toRecordRow(raw);
        if (row.localState === null && row.serverState === "unavailable") {
          // Records this build can't show come back with the download.
          this.db.run("DELETE FROM records WHERE kind = ? AND id = ?", [row.kind, row.id]);
          continue;
        }
        if (row.localState === null && row.serverState === "deleted") {
          const owner = this.contract.kind(row.kind).parent;
          if (owner?.sharedId && !this.#row(owner.kind, row.id)) {
            // A shared-ID setting can only be deleted with its owner. A paged pull may
            // have stopped between those two markers. Review the owner if it reappears.
            this.#write({
              ...this.#emptyRow(owner.kind, row.id),
              localState: "deleted",
              localSeq: 1,
              status: "pending",
              reoffered: true,
              seenOnServer: true,
            });
          }
          // The restored server may have this record again. If it does, the user reviews the
          // deletion; if it doesn't, the deletion is sent so the server keeps a marker.
          this.#write({
            ...row,
            serverRevision: null,
            serverState: null,
            serverContent: null,
            localState: "deleted",
            localContent: null,
            localBase: null,
            localSeq: row.localSeq + 1,
            reoffered: true,
            seenOnServer: true,
            status: "pending",
          });
          continue;
        }
        const keepsProblem = row.status === "conflict" || row.status === "invalid";
        // A conflict was about the server's old state: it is rechecked against the restored
        // server. An invalid version stays invalid.
        const conflict = row.status === "conflict";
        this.#write({
          ...row,
          serverRevision: null,
          serverState: null,
          serverContent: null,
          localState: row.localState ?? "live",
          localContent: row.localState === null ? row.serverContent : row.localContent,
          localBase: null,
          localSeq: row.localSeq + 1,
          // Offered again without any change by the user: equal copies are confirmed, any
          // difference comes back as a conflict the user can clear with resolveRestored(). A record
          // offered again by an earlier restore stays so.
          reoffered: row.localState === null || row.reoffered,
          status: keepsProblem ? row.status : "pending",
          problem: keepsProblem ? (conflict ? "restored" : row.problem) : null,
          problemRevision: conflict ? null : row.problemRevision,
          // The user's version: what keeping theirs offers again if the restored server lacks
          // the record.
          keptContent:
            row.localState !== null && row.serverState === "live"
              ? row.serverContent
              : row.keptContent,
          seenOnServer: row.serverState !== null || row.seenOnServer,
        });
      }
      this.db.run("DELETE FROM submissions");
      this.db.run("UPDATE sync_state SET cursor = 0, restoring = 1 WHERE id = 1");
    });
  }

  /** Called once the full download after a reset is complete. */
  completeRestore(): void {
    this.#mutate(() => {
      if (!this.syncState().restoring) return;
      // Deletions of records the restored server doesn't have are sent without a base, so the
      // server records them too and no other device can bring the record back.
      for (const raw of this.db.all(
        `SELECT * FROM records
         WHERE local_state = 'deleted' AND server_revision IS NULL AND status = 'pending'`,
      )) {
        const row = toRecordRow(raw);
        this.#purgeDescendants(row.kind, row.id);
      }
      // Versions the user discarded during the restore whose record the server doesn't have.
      this.db.run("DELETE FROM records WHERE server_revision IS NULL AND local_state IS NULL");
      this.db.run("UPDATE sync_state SET restoring = 0 WHERE id = 1");
    });
  }
}
