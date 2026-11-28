// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import {
  type Change,
  type Contract,
  canonicalJson,
  type ErrorCode,
  type ErrorResponse,
  type HelloResponse,
  helloRequestSchema,
  type JsonObject,
  jsonBytes,
  jsonEqual,
  leveContract,
  MAX_DESCENDANTS,
  MAX_PAGE_BYTES,
  MAX_WAIT_MS,
  negotiate,
  type PullResponse,
  type PushResponse,
  type ReleaseId,
  releaseMessages,
  SERVER_RELEASES,
  type Submission,
  type SubmissionResult,
  validate,
} from "@leve/contract";
import type {
  ServerAccountStore,
  ServerStorage,
  ServerTransaction,
  StoredRecord,
  WorkoutReadQuery,
} from "@leve/storage/server";

export const RECEIPT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE = 100;

export interface Reply<T> {
  status: number;
  body: T | ErrorResponse;
  writtenRevisions?: string;
}

/** Storage that can delete a whole account, for hosts where people delete their own account. */
export interface AccountEraser {
  /**
   * Deletes everything stored for the account and makes sure it can't be opened or created again.
   * Repeating it after an interruption finishes the deletion.
   */
  deleteAccount(accountId: string): Promise<void>;
}

export interface SyncServiceOptions {
  /** Opens account databases: files on a server, or the database of an account's Durable Object. */
  storage: Pick<ServerStorage, "account"> & Partial<AccountEraser>;
  /** Hosts whose storage opens missing accounts must provide a non-creating lookup for MCP. */
  existingAccount?: (accountId: string) => Promise<ServerAccountStore | null>;
  contract?: Contract;
  /** Releases this server accepts, oldest first. */
  releases?: readonly ReleaseId[];
  now?: () => Date;
  receiptDays?: number;
  /** New lineage ids. */
  randomId?: () => string;
  /** Test seam for long polling. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export type WorkoutReadSelection = { id: string } | WorkoutReadQuery;

interface SubmitOptions {
  checkAccess?: CheckAccess | undefined;
  lineage?: string;
  written?: Set<string>;
  patch?: boolean;
  /** MCP submits use an existing synced account. Notes can carry a server-provided author label. */
  agent?: { name?: string };
}

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  unsupported_release: 400,
  update_required: 426,
  cursor_reset: 409,
  unavailable: 503,
  account_deleted: 410,
};

export function errorReply(
  code: ErrorCode,
  message: string,
  extra: Omit<ErrorResponse["error"], "code" | "message"> = {},
): Reply<never> {
  return { status: STATUS[code], body: { error: { code, message, ...extra } } };
}

/** The account's lineage changed while a request was being handled. */
export class LineageChangedError extends Error {
  override name = "LineageChangedError";
}

const deletedReply = () => errorReply("account_deleted", "This account was deleted");

const restoredReply = () =>
  errorReply("cursor_reset", "The account was restored or reset; download everything again");

type DescendantRef = Pick<StoredRecord, "kind" | "id" | "revision">;

function sameDescendants(live: readonly DescendantRef[], known: readonly DescendantRef[]): boolean {
  const key = ({ kind, id, revision }: DescendantRef) => `${kind}/${id}@${revision}`;
  const expected = new Set(live.map(key));
  const given = new Set(known.map(key));
  return expected.size === given.size && [...expected].every((entry) => given.has(entry));
}

const describeIssues = (issues: readonly { path: string; message: string }[]) =>
  issues
    .slice(0, 5)
    .map((issue) => `${issue.path} ${issue.message}`)
    .join("; ")
    .slice(0, 1000);

/**
 * The account-scoped write service. Every server write goes through `submit`: phone uploads via
 * `push`, and future MCP tools directly. It validates content for the sender's release, checks
 * the base revision, and stores the change with its receipt in one transaction.
 */
/** HTTP adapters can revalidate a device after the request has waited. */
type CheckAccess = () => Promise<void>;

export class SyncService {
  readonly contract: Contract;
  readonly releases: readonly ReleaseId[];
  readonly #storage: SyncServiceOptions["storage"];
  readonly #existingAccount: (accountId: string) => Promise<ServerAccountStore | null>;
  readonly #now: () => Date;
  readonly #receiptDays: number;
  readonly #setTimer: NonNullable<SyncServiceOptions["setTimer"]>;
  readonly #randomId: () => string;
  readonly #waiting = new Map<string, Set<() => void>>();
  /** Accounts deleted through this service: nothing reaches them again. */
  readonly #deleted = new Set<string>();

  constructor(options: SyncServiceOptions) {
    this.#storage = options.storage;
    this.#existingAccount = options.existingAccount ?? ((id) => this.#storage.account(id));
    this.contract = options.contract ?? leveContract;
    this.releases = options.releases ?? SERVER_RELEASES;
    this.#now = options.now ?? (() => new Date());
    this.#receiptDays = options.receiptDays ?? RECEIPT_DAYS;
    this.#randomId = options.randomId ?? (() => crypto.randomUUID());
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(handle) };
      });
    for (const release of this.releases) {
      if (!this.contract.releases.includes(release)) throw new Error(`unknown release ${release}`);
    }
  }

  async hello(
    accountId: string,
    body: unknown,
    checkAccess?: CheckAccess,
  ): Promise<Reply<HelloResponse>> {
    const issues = validate(helloRequestSchema, body);
    if (issues.length > 0) return errorReply("invalid_request", describeIssues(issues));
    const request = body as { releases: string[] };
    const result = negotiate(request.releases, this.releases);
    if (!result.ok) {
      const side = result.update === "client" ? "app" : "server";
      return errorReply("update_required", `Sync needs a newer ${side}`, {
        update: result.update,
        serverReleases: [...this.releases],
      });
    }
    if (this.#deleted.has(accountId)) return deletedReply();
    const store = await this.#storage.account(accountId);
    if (checkAccess) await checkAccess();
    return {
      status: 200,
      body: {
        release: result.release,
        features: this.contract.features(result.release),
        revision: store.headRevision(),
        lineage: store.lineage(),
        restoredFrom: store.restoredFrom(),
      },
    };
  }

  #release(body: unknown): ReleaseId | Reply<never> {
    const release = (body as { release?: unknown } | null)?.release;
    if (typeof release !== "string" || !this.releases.includes(release as ReleaseId)) {
      return errorReply("unsupported_release", "This server does not accept that release", {
        serverReleases: [...this.releases],
      });
    }
    return release as ReleaseId;
  }

  async push(
    accountId: string,
    body: unknown,
    checkAccess?: CheckAccess,
  ): Promise<Reply<PushResponse>> {
    const release = this.#release(body);
    if (typeof release !== "string") return release;
    const issues = validate(releaseMessages(this.contract, release).pushRequest, body);
    if (issues.length > 0) return errorReply("invalid_request", describeIssues(issues));
    const { submissions, lineage } = body as { submissions: Submission[]; lineage: string };
    const ids = new Set(submissions.map((submission) => submission.submissionId));
    if (ids.size !== submissions.length) {
      return errorReply("invalid_request", "submission ids must be unique within a request");
    }
    if (this.#deleted.has(accountId)) return deletedReply();
    const store = await this.#storage.account(accountId);
    if (lineage !== store.lineage()) {
      if (checkAccess) await checkAccess();
      return restoredReply();
    }
    const written = new Set<string>();
    let results: SubmissionResult[];
    try {
      results = await this.submit(accountId, release, submissions, {
        lineage,
        written,
        checkAccess,
      });
    } catch (error) {
      if (error instanceof LineageChangedError) return restoredReply();
      throw error;
    }
    return {
      status: 200,
      body: { release, results },
      writtenRevisions: results.map((r) => (written.has(r.submissionId) ? "1" : "0")).join(""),
    };
  }

  /**
   * Decides each submission on its own, in order. This is the one write path for every writer;
   * it validates the submissions itself, so adapters such as MCP tools can call it directly.
   */
  async submit(
    accountId: string,
    release: ReleaseId,
    submissions: readonly Submission[],
    options: SubmitOptions = {},
  ): Promise<SubmissionResult[]> {
    if (!this.releases.includes(release)) throw new Error(`Unsupported sync release ${release}`);
    if (this.#deleted.has(accountId)) throw new Error("the account was deleted");
    const store = options.agent
      ? await this.#existingAccount(accountId)
      : await this.#storage.account(accountId);
    if (!store || (options.agent && options.lineage === undefined)) throw new LineageChangedError();
    const shape = validate(releaseMessages(this.contract, release).pushRequest, {
      release,
      lineage: store.lineage(),
      submissions,
    });
    if (shape.length > 0) throw new Error(`invalid submissions: ${describeIssues(shape)}`);
    if (
      options.patch &&
      submissions.some((submission) => submission.op !== "put" || submission.baseRevision === null)
    ) {
      throw new Error("patches require a put with a base revision");
    }
    if (
      new Set(submissions.map((submission) => submission.submissionId)).size !== submissions.length
    ) {
      throw new Error("submission ids must be unique within a request");
    }
    if (options.checkAccess) await options.checkAccess();
    const now = this.#now();
    const cutoff = new Date(now.getTime() - this.#receiptDays * DAY_MS).toISOString();
    const results: SubmissionResult[] = [];
    const before = store.headRevision();
    try {
      for (const submission of submissions) {
        results.push(
          store.transaction((tx) => {
            // Checked inside the write: the account may have been restored since the request
            // was accepted, and then this change belongs to a history that no longer exists.
            if (options.lineage !== undefined && tx.lineage() !== options.lineage) {
              throw new LineageChangedError();
            }
            tx.pruneReceipts(cutoff);
            return this.#decide(tx, release, submission, now.toISOString(), options);
          }),
        );
      }
    } finally {
      // Wake long polls for whatever was committed, even if a later submission failed.
      if (store.headRevision() !== before) this.#notify(accountId);
    }
    return results;
  }

  #liveDescendants(tx: ServerTransaction, kind: string, id: string): StoredRecord[] {
    return tx
      .liveChildren(kind, id)
      .flatMap((child) => [child, ...this.#liveDescendants(tx, child.kind, child.id)]);
  }

  /** One extra revision lets MCP recognize a tree too large for any delete submission. */
  #boundedDescendants(tx: ServerTransaction, kind: string, id: string): DescendantRef[] {
    const descendants: DescendantRef[] = [];
    const parents = [{ kind, id }];
    for (const parent of parents) {
      if (this.contract.childKinds(parent.kind).length === 0) continue;
      const children = tx.liveChildRefs(
        parent.kind,
        parent.id,
        MAX_DESCENDANTS + 1 - descendants.length,
      );
      descendants.push(...children);
      if (descendants.length > MAX_DESCENDANTS) break;
      parents.push(...children);
    }
    return descendants;
  }

  #change(record: StoredRecord, release: ReleaseId): Change {
    const { kind, id, revision } = record;
    if (record.state === "deleted") return { state: "deleted", kind, id, revision };
    const encoded = this.contract.encode(kind, record.content as JsonObject, release);
    if (encoded.issues.length > 0) return { state: "unavailable", kind, id, revision };
    return { state: "live", kind, id, revision, content: encoded.content };
  }

  #decide(
    tx: ServerTransaction,
    release: ReleaseId,
    submission: Submission,
    acceptedAt: string,
    { written, patch, agent }: SubmitOptions,
  ): SubmissionResult {
    const { submissionId, kind, id } = submission;
    const digest = createHash("sha256")
      .update(
        canonicalJson({
          release,
          ...submission,
          ...(patch ? { patch: true } : {}),
          ...(agent?.name !== undefined ? { attributed: true } : {}),
        }),
      )
      .digest("hex");
    const receipt = tx.receipt(submissionId);
    if (receipt) {
      if (receipt.digest === digest && receipt.kind === kind && receipt.id === id) {
        if (receipt.wroteRevision) written?.add(submissionId);
        return { status: "accepted", submissionId, revision: receipt.revision };
      }
      return {
        status: "invalid",
        submissionId,
        code: "submission_reused",
        message: "This submission id was already used for a different change",
      };
    }
    const accept = (revision: number, wroteRevision = false): SubmissionResult => {
      tx.saveReceipt({
        submissionId,
        kind,
        id,
        revision,
        digest,
        acceptedAt,
        ...(wroteRevision ? { wroteRevision: true } : {}),
      });
      if (wroteRevision) written?.add(submissionId);
      return { status: "accepted", submissionId, revision };
    };
    const conflict = (
      reason: "stale" | "deleted" | "exists" | "parent_deleted",
      current: StoredRecord | null,
    ): SubmissionResult => ({
      status: "conflict",
      submissionId,
      reason,
      current: current ? this.#change(current, release) : null,
    });

    const definition = this.contract.kind(kind);
    const singleton = definition.singletonId;
    if (singleton !== undefined && id !== singleton) {
      return {
        status: "invalid",
        submissionId,
        code: "not_singleton",
        message: `${kind} is always stored as ${singleton}`,
      };
    }
    const current = tx.get(kind, id);
    if (agent && kind === "custom_exercise" && id.startsWith("builtin:")) {
      return {
        status: "invalid",
        submissionId,
        code: "invalid_content",
        message: "Built-in exercise IDs are reserved",
      };
    }

    if (submission.op === "delete") {
      if (agent && !current) return conflict("stale", null);
      const parent = definition.parent;
      // Shared-ID settings belong to the workout for its entire lifetime. A
      // device recovering a deleted workout may have only the two tombstones.
      if (parent?.sharedId && current?.state !== "live") {
        const owner = tx.get(parent.kind, id);
        if (!owner) return { status: "retry_later", submissionId, reason: "parent_missing" };
        if (owner.state === "deleted")
          return accept(current?.revision ?? tx.writeDeleted(kind, id));
      }
      if (singleton !== undefined || parent?.sharedId) {
        return {
          status: "invalid",
          submissionId,
          code: "not_deletable",
          message: `${kind} can be changed but not deleted`,
        };
      }
      if (!current) return accept(tx.writeDeleted(kind, id));
      if (current.state === "deleted") return accept(current.revision);
      if (current.revision !== submission.baseRevision) return conflict("stale", current);
      // Deleting removes the descendants too: the deleter must have seen each of them as it is.
      const descendants = agent
        ? this.#boundedDescendants(tx, kind, id)
        : this.#liveDescendants(tx, kind, id);
      if (!sameDescendants(descendants, submission.descendants)) {
        return conflict("stale", current);
      }
      return accept(tx.writeDeleted(kind, id));
    }

    let submitted =
      agent?.name === undefined ? submission.content : { ...submission.content, agent: agent.name };
    if (patch) {
      // Build the candidate inside the write transaction. The revision check below only
      // accepts a stale candidate when it is already identical to the current record.
      if (current?.state === "deleted") return conflict("deleted", current);
      if (!current) return conflict("stale", null);
      const base = this.#change(current, release);
      if (base.state !== "live") return conflict("stale", current);
      if (
        kind === "custom_exercise" &&
        Object.hasOwn(submitted, "type") &&
        submitted.type !== base.content.type
      ) {
        return {
          status: "invalid",
          submissionId,
          code: "invalid_content",
          message: "A custom exercise's type cannot change after creation",
        };
      }
      submitted = { ...base.content, ...submitted };
    }
    const issues = this.contract.decode(kind, submitted, release, id);
    if (issues.length > 0) {
      return {
        status: "invalid",
        submissionId,
        code: "invalid_content",
        message: describeIssues(issues),
      };
    }
    const stored = current?.state === "live" ? current.content : null;
    const content = this.contract.applyOmissionRule(kind, stored, submitted, release);
    const contentIssues = this.contract.validateContent(kind, content, id);
    if (contentIssues.length > 0) {
      return {
        status: "invalid",
        submissionId,
        code: "invalid_content",
        message: describeIssues(contentIssues),
      };
    }
    if (current?.state === "deleted") return conflict("deleted", current);
    if (current) {
      const based = submission.baseRevision === current.revision;
      if (!based) {
        // A repeat whose receipt expired, or the same change made elsewhere, is already applied.
        if (jsonEqual(this.contract.normalize(kind, current.content ?? {}), content))
          return accept(current.revision);
        return conflict(submission.baseRevision === null ? "exists" : "stale", current);
      }
    } else if (submission.baseRevision !== null) {
      return conflict("stale", null);
    }
    const parent = this.contract.parentOf(kind, content);
    if (parent) {
      const parentRecord = tx.get(parent.kind, parent.id);
      if (!parentRecord) return { status: "retry_later", submissionId, reason: "parent_missing" };
      if (parentRecord.state === "deleted") return conflict("parent_deleted", current);
    }
    return accept(tx.writeLive(kind, id, content), true);
  }

  async pull(
    accountId: string,
    body: unknown,
    checkAccess?: CheckAccess,
  ): Promise<Reply<PullResponse>> {
    const release = this.#release(body);
    if (typeof release !== "string") return release;
    const issues = validate(releaseMessages(this.contract, release).pullRequest, body);
    if (issues.length > 0) return errorReply("invalid_request", describeIssues(issues));
    const request = body as { cursor: number; limit?: number; waitMs?: number; lineage: string };
    if (this.#deleted.has(accountId)) return deletedReply();
    const store = await this.#storage.account(accountId);
    if (checkAccess) await checkAccess();
    if (request.lineage !== store.lineage()) return restoredReply();
    if (request.cursor > store.headRevision()) {
      // The account went back in time without the restore command (for example a copied file).
      // A new lineage makes every device reset, not only this one.
      store.transaction((tx) => tx.setLineage(this.#randomId()));
      return restoredReply();
    }
    const waitMs = Math.min(request.waitMs ?? 0, MAX_WAIT_MS);
    if (waitMs > 0 && store.headRevision() === request.cursor) {
      await this.#waitForChange(accountId, waitMs);
      // Deleted while this request waited: its database is gone.
      if (this.#deleted.has(accountId)) return deletedReply();
      if (checkAccess) await checkAccess();
      if (request.lineage !== store.lineage()) return restoredReply();
    }
    const page = store.changesAfter(request.cursor, request.limit ?? DEFAULT_PAGE);
    // Keep pages small enough for a phone; at least one record always goes out.
    let bytes = 0;
    let taken = 0;
    for (const record of page.records) {
      if (taken > 0 && bytes >= MAX_PAGE_BYTES) break;
      bytes += jsonBytes(record.content);
      taken += 1;
    }
    const sent = page.records.slice(0, taken);
    const changes = sent
      .filter((record) => this.contract.hasKind(record.kind, release))
      .map((record) => this.#change(record, release));
    const last = sent[sent.length - 1];
    return {
      status: 200,
      body: {
        release,
        changes,
        cursor: last ? last.revision : request.cursor,
        hasMore: page.hasMore || taken < page.records.length,
      },
    };
  }

  /** The current copy of one record for `release`, for readers such as MCP tools. */
  async read(
    accountId: string,
    kind: string,
    id: string,
    release: ReleaseId,
  ): Promise<Change | null> {
    if (!this.contract.releases.includes(release) || !this.contract.hasKind(kind, release))
      return null;
    if (!this.releases.includes(release)) throw new Error(`Unsupported sync release ${release}`);
    const store = await this.#existingAccount(accountId);
    if (!store) return null;
    const record = store.transaction((tx) => tx.get(kind, id));
    return record ? this.#change(record, release) : null;
  }

  /** The current record and its live descendants, from the same history and transaction. */
  async readRecordTree(
    accountId: string,
    kind: string,
    id: string,
    release: ReleaseId,
    includeDescendants = true,
  ): Promise<{
    lineage: string | null;
    record: Change | null;
    descendants: DescendantRef[];
    descendantsTruncated: boolean;
  }> {
    if (!this.releases.includes(release)) throw new Error(`Unsupported sync release ${release}`);
    const store = await this.#existingAccount(accountId);
    if (!store)
      return { lineage: null, record: null, descendants: [], descendantsTruncated: false };
    return store.transaction((tx) => {
      const current = this.contract.hasKind(kind, release) ? tx.get(kind, id) : null;
      const descendants =
        includeDescendants && current?.state === "live"
          ? this.#boundedDescendants(tx, kind, id)
          : [];
      return {
        lineage: tx.lineage(),
        record: current ? this.#change(current, release) : null,
        descendants: descendants.slice(0, MAX_DESCENDANTS),
        descendantsTruncated: descendants.length > MAX_DESCENDANTS,
      };
    });
  }

  /**
   * Every live record of each kind for `release`, read in one transaction so they are consistent
   * with each other, for readers such as MCP tools. Kinds the release lacks come back empty; a
   * record the release can't represent comes back `unavailable`.
   */
  async readKinds(
    accountId: string,
    kinds: readonly string[],
    release: ReleaseId,
    workouts?: WorkoutReadSelection,
  ): Promise<Map<string, Change[]>> {
    if (!this.releases.includes(release)) throw new Error(`Unsupported sync release ${release}`);
    const store = await this.#existingAccount(accountId);
    if (!store) return new Map();
    const rows = store.transaction((tx) => {
      const selected = workouts ? this.#workoutRows(tx, kinds, workouts) : null;
      return kinds.map((kind) =>
        this.contract.hasKind(kind, release) ? (selected?.get(kind) ?? tx.live(kind)) : [],
      );
    });
    return new Map(
      kinds.map((kind, i) => [
        kind,
        (rows[i] ?? []).map((record) => this.#change(record, release)),
      ]),
    );
  }

  #workoutRows(
    tx: ServerTransaction,
    kinds: readonly string[],
    selection: WorkoutReadSelection,
  ): Map<string, StoredRecord[]> {
    const single = "id" in selection;
    const detail = single ? tx.get("workout", selection.id) : null;
    const workouts = single
      ? detail?.state === "live"
        ? [detail]
        : []
      : tx.liveWorkouts(selection);
    const exerciseId = single ? undefined : selection.exerciseId;
    const rows = new Map<string, StoredRecord[]>([["workout", workouts]]);
    const children = (kind: string, parentKind: string) => {
      if (!kinds.includes(kind)) return;
      const found = (rows.get(parentKind) ?? []).flatMap((parent) =>
        tx.liveChildren(parentKind, parent.id, kind),
      );
      rows.set(
        kind,
        kind === "workout_exercise" && exerciseId !== undefined
          ? found.filter((entry) => entry.content?.exerciseId === exerciseId)
          : found,
      );
    };
    children("workout_exercise", "workout");
    children("workout_set", "workout_exercise");
    children("workout_rest", "workout");
    children("workout_note", "workout");
    children("workout_note_comment", "workout_note");
    if (kinds.includes("custom_exercise")) {
      const ids = new Set(
        (rows.get("workout_exercise") ?? []).flatMap((entry) =>
          typeof entry.content?.exerciseId === "string" ? [entry.content.exerciseId] : [],
        ),
      );
      rows.set(
        "custom_exercise",
        [...ids].flatMap((id) => {
          const exercise = tx.get("custom_exercise", id);
          return exercise?.state === "live" ? [exercise] : [];
        }),
      );
    }
    if (kinds.includes("body_measurement")) {
      const first = workouts.at(-1)?.content?.startedAt;
      const last = workouts[0]?.content?.startedAt;
      rows.set(
        "body_measurement",
        typeof first === "string" && typeof last === "string"
          ? tx.liveBodyweightForWorkouts(first, last)
          : [],
      );
    }
    if (kinds.includes("exercise_note")) {
      rows.set(
        "exercise_note",
        workouts.flatMap((workout) => tx.liveExerciseNotesForWorkout(workout.id)),
      );
    }
    children("exercise_note_comment", "exercise_note");
    return rows;
  }

  /**
   * Deletes the account the signed-in person asked to delete, with everything stored for it.
   * Waiting downloads end, and later requests for it are answered `account_deleted`. Safe to
   * repeat: a deletion that was interrupted finishes.
   */
  async deleteAccount(accountId: string): Promise<Reply<{ deleted: true }>> {
    if (!this.#storage.deleteAccount) {
      return errorReply("invalid_request", "this server doesn't delete accounts");
    }
    try {
      await this.#storage.deleteAccount(accountId);
      // Only once it is: a failure leaves what storage kept, and the account isn't called deleted.
      this.#deleted.add(accountId);
    } finally {
      this.#notify(accountId);
    }
    return { status: 200, body: { deleted: true } };
  }

  #waitForChange(accountId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let waiting = this.#waiting.get(accountId);
      if (!waiting) {
        waiting = new Set();
        this.#waiting.set(accountId, waiting);
      }
      const set = waiting;
      const done = () => {
        set.delete(done);
        timer.cancel();
        resolve();
      };
      const timer = this.#setTimer(done, ms);
      set.add(done);
    });
  }

  #notify(accountId: string): void {
    for (const wake of [...(this.#waiting.get(accountId) ?? [])]) wake();
  }
}
