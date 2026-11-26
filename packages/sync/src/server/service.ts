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
import type { ServerStorage, ServerTransaction, StoredRecord } from "@leve/storage/server";

export const RECEIPT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE = 100;

export interface Reply<T> {
  status: number;
  body: T | ErrorResponse;
  writtenRevisions?: string;
}

export interface SyncServiceOptions {
  /** Opens account databases: files on a server, or the database of an account's Durable Object. */
  storage: Pick<ServerStorage, "account">;
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

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  unsupported_release: 400,
  update_required: 426,
  cursor_reset: 409,
  unavailable: 503,
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

const restoredReply = () =>
  errorReply("cursor_reset", "The account was restored or reset; download everything again");

function sameDescendants(
  live: readonly StoredRecord[],
  known: readonly { kind: string; id: string; revision: number }[],
): boolean {
  const key = (record: { kind: string; id: string; revision: number }) =>
    `${record.kind}/${record.id}@${record.revision}`;
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
  readonly #storage: Pick<ServerStorage, "account">;
  readonly #now: () => Date;
  readonly #receiptDays: number;
  readonly #setTimer: NonNullable<SyncServiceOptions["setTimer"]>;
  readonly #randomId: () => string;
  readonly #waiting = new Map<string, Set<() => void>>();

  constructor(options: SyncServiceOptions) {
    this.#storage = options.storage;
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
    options: {
      lineage?: string;
      written?: Set<string>;
      checkAccess?: CheckAccess | undefined;
    } = {},
  ): Promise<SubmissionResult[]> {
    if (!this.releases.includes(release)) throw new Error(`Unsupported sync release ${release}`);
    const store = await this.#storage.account(accountId);
    const shape = validate(releaseMessages(this.contract, release).pushRequest, {
      release,
      lineage: store.lineage(),
      submissions,
    });
    if (shape.length > 0) throw new Error(`invalid submissions: ${describeIssues(shape)}`);
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
            return this.#decide(tx, release, submission, now.toISOString(), options.written);
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
    written?: Set<string>,
  ): SubmissionResult {
    const { submissionId, kind, id } = submission;
    const digest = createHash("sha256")
      .update(canonicalJson({ release, ...submission }))
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

    if (submission.op === "delete") {
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
      if (!sameDescendants(this.#liveDescendants(tx, kind, id), submission.descendants)) {
        return conflict("stale", current);
      }
      return accept(tx.writeDeleted(kind, id));
    }

    const issues = this.contract.decode(kind, submission.content, release, id);
    if (issues.length > 0) {
      return {
        status: "invalid",
        submissionId,
        code: "invalid_content",
        message: describeIssues(issues),
      };
    }
    const stored = current?.state === "live" ? current.content : null;
    const content = this.contract.applyOmissionRule(kind, stored, submission.content, release);
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
    const store = await this.#storage.account(accountId);
    const record = store.transaction((tx) => tx.get(kind, id));
    return record ? this.#change(record, release) : null;
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
