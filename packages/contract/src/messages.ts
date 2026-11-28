import { type Contract, type JsonObject, MAX_RECORD_BYTES, type ReleaseId } from "./definition.ts";
import {
  array,
  boolean,
  enumOf,
  id,
  integer,
  literal,
  nullable,
  object,
  type Schema,
  type SchemaDescription,
  string,
  union,
} from "./schema.ts";

/*
 * Wire messages. The negotiation and error envelopes below are shared by every release, past and
 * future: they are how two builds that share no release find that out. Never change them.
 */

export const MAX_REVISION = Number.MAX_SAFE_INTEGER;
export const MAX_SUBMISSIONS = 100;
export const MAX_PAGE = 500;
export const MAX_WAIT_MS = 25_000;
export const MAX_DESCENDANTS = 2000;

const releaseId = string({ minLength: 3, maxLength: 16 });

export const helloRequestSchema = object({
  releases: array(releaseId, 64),
  /** App release, for diagnostics only. */
  app: string({ maxLength: 64 }),
});
export type HelloRequest = { releases: string[]; app: string };

export const helloResponseSchema = object({
  release: releaseId,
  features: array(string({ maxLength: 64 }), 256),
  /** Highest revision the account has; lets the client spot a cursor ahead of the server. */
  revision: integer(0, MAX_REVISION),
  /**
   * Identifies the account's history. It changes when the server restores the account from a
   * backup, so a device knows its cursor and revisions belong to a history that no longer exists.
   */
  lineage: id(),
  /**
   * After a restore from a backup: the lineage the backup belonged to and the backup's revision.
   * Revisions up to restorePoint mean the same in that lineage and in the current one. Null when
   * the account was never restored, or the split point is unknown (a restore by copying files).
   */
  restoredFrom: nullable(object({ lineage: id(), restorePoint: integer(0, MAX_REVISION) })),
});
export type HelloResponse = {
  release: string;
  features: string[];
  revision: number;
  lineage: string;
  restoredFrom: { lineage: string; restorePoint: number } | null;
};

export const ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "unsupported_release",
  "update_required",
  "cursor_reset",
  "unavailable",
  "account_deleted",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorResponseSchema = object(
  {
    error: object(
      {
        code: enumOf(ERROR_CODES),
        message: string({ maxLength: 1000 }),
        /** For update_required: which side has to update. */
        update: enumOf(["client", "server"]),
        /** For update_required and unsupported_release. */
        serverReleases: array(releaseId, 64),
      },
      ["update", "serverReleases"],
    ),
  },
  [],
);
export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    update?: "client" | "server";
    serverReleases?: string[];
  };
}

export const NEGOTIATION_DESCRIPTION = {
  paths: { hello: "POST /sync/hello", push: "POST /sync/push", pull: "POST /sync/pull" },
  helloRequest: helloRequestSchema.description,
  helloResponse: helloResponseSchema.description,
  errorResponse: errorResponseSchema.description,
};

/* Release messages. */

export type Revision = number;

export interface PutSubmission {
  op: "put";
  submissionId: string;
  kind: string;
  id: string;
  /** The server revision the edit started from; null when creating the record. */
  baseRevision: Revision | null;
  content: JsonObject;
}

export interface DeleteSubmission {
  op: "delete";
  submissionId: string;
  kind: string;
  id: string;
  /**
   * The revision deleted. Null when the deleter has no copy (a deletion it remembers across a
   * server restore): accepted only if the server doesn't have the record either.
   */
  baseRevision: Revision | null;
  /**
   * Every live descendant the deleter knows, with the revision it knows. Deleting a record deletes
   * its descendants, so the deletion is stale when any of them changed or appeared since.
   */
  descendants: { kind: string; id: string; revision: Revision }[];
}

export type Submission = PutSubmission | DeleteSubmission;

export interface PushRequest {
  release: string;
  /** The account lineage from hello; a different one means the server was restored. */
  lineage: string;
  submissions: Submission[];
}

export type Change =
  | { state: "live"; kind: string; id: string; revision: Revision; content: JsonObject }
  | { state: "deleted"; kind: string; id: string; revision: Revision }
  /** The record exists but this release can't represent it; show it nowhere and never edit it. */
  | { state: "unavailable"; kind: string; id: string; revision: Revision };

export const CONFLICT_REASONS = ["stale", "deleted", "exists", "parent_deleted"] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];
export const INVALID_CODES = [
  "invalid_content",
  "submission_reused",
  "not_singleton",
  "not_deletable",
] as const;
export type InvalidCode = (typeof INVALID_CODES)[number];

export type SubmissionResult =
  | { status: "accepted"; submissionId: string; revision: Revision }
  | {
      status: "conflict";
      submissionId: string;
      reason: ConflictReason;
      /** The server's current copy; null only when the record never existed. */
      current: Change | null;
    }
  | { status: "retry_later"; submissionId: string; reason: "parent_missing" }
  | { status: "invalid"; submissionId: string; code: InvalidCode; message: string };

export interface PushResponse {
  release: string;
  results: SubmissionResult[];
}

export interface PullRequest {
  release: string;
  lineage: string;
  /** Highest revision the client has downloaded; 0 downloads everything. */
  cursor: Revision;
  limit?: number;
  /** Wait up to this long for a change when there is none yet (long polling). */
  waitMs?: number;
}

export interface PullResponse {
  release: string;
  changes: Change[];
  /** Save together with the changes; the next pull continues from here. */
  cursor: Revision;
  hasMore: boolean;
}

export interface ReleaseMessages {
  release: ReleaseId;
  submission: Schema<Submission>;
  pushRequest: Schema<PushRequest>;
  pushResponse: Schema<PushResponse>;
  pullRequest: Schema<PullRequest>;
  pullResponse: Schema<PullResponse>;
  change: Schema<Change>;
  describe(): Record<string, SchemaDescription>;
}

/**
 * Message schemas of one release. Record content is validated separately per kind with the
 * contract's wire schema, because the envelope doesn't know which kind it carries.
 */
export function releaseMessages(contract: Contract, release: ReleaseId): ReleaseMessages {
  if (!contract.releases.includes(release)) throw new Error(`unknown release ${release}`);
  const kind = enumOf(contract.kindNames(release));
  const revision = integer(1, MAX_REVISION);
  const anyContent = {
    description: { type: "object", properties: {}, required: [], open: true } as SchemaDescription,
    check(value: unknown, path: string, issues: { path: string; message: string }[]) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({ path, message: "expected an object" });
      }
    },
  } as Schema<JsonObject>;

  const put = object({
    op: literal("put"),
    submissionId: id(),
    kind,
    id: id(),
    baseRevision: nullable(revision),
    content: anyContent,
  });
  const del = object({
    op: literal("delete"),
    submissionId: id(),
    kind,
    id: id(),
    baseRevision: nullable(revision),
    descendants: array(object({ kind, id: id(), revision }), MAX_DESCENDANTS),
  });
  const submission = union("op", [put, del]);
  const pushRequest = object({
    release: literal(release),
    lineage: id(),
    submissions: array(submission, MAX_SUBMISSIONS),
  });

  const change = union("state", [
    object({ state: literal("live"), kind, id: id(), revision, content: anyContent }),
    object({ state: literal("deleted"), kind, id: id(), revision }),
    object({ state: literal("unavailable"), kind, id: id(), revision }),
  ]);
  const result = union("status", [
    object({ status: literal("accepted"), submissionId: id(), revision }),
    object({
      status: literal("conflict"),
      submissionId: id(),
      reason: enumOf(CONFLICT_REASONS),
      current: nullable(change),
    }),
    object({
      status: literal("retry_later"),
      submissionId: id(),
      reason: literal("parent_missing"),
    }),
    object({
      status: literal("invalid"),
      submissionId: id(),
      code: enumOf(INVALID_CODES),
      message: string({ maxLength: 1000 }),
    }),
  ]);
  const pushResponse = object({
    release: literal(release),
    results: array(result, MAX_SUBMISSIONS),
  });
  const pullRequest = object(
    {
      release: literal(release),
      lineage: id(),
      cursor: integer(0, MAX_REVISION),
      limit: integer(1, MAX_PAGE),
      waitMs: integer(0, MAX_WAIT_MS),
    },
    ["limit", "waitMs"],
  );
  const pullResponse = object({
    release: literal(release),
    changes: array(change, MAX_PAGE),
    cursor: integer(0, MAX_REVISION),
    hasMore: boolean(),
  });

  return {
    release,
    submission: submission as unknown as Schema<Submission>,
    pushRequest: pushRequest as unknown as Schema<PushRequest>,
    pushResponse: pushResponse as unknown as Schema<PushResponse>,
    pullRequest: pullRequest as unknown as Schema<PullRequest>,
    pullResponse: pullResponse as unknown as Schema<PullResponse>,
    change: change as unknown as Schema<Change>,
    describe: () => ({
      pushRequest: pushRequest.description,
      pushResponse: pushResponse.description,
      pullRequest: pullRequest.description,
      pullResponse: pullResponse.description,
    }),
  };
}

/** The largest request body a server accepts. Clients split their uploads to stay below it. */
export const MAX_REQUEST_BYTES = 1_048_576;
/** A download page stops once its records hold this many bytes (always at least one record). */
export const MAX_PAGE_BYTES = 800_000;

const deletePreconditions =
  "baseRevision is the revision deleted, or null when the deleter has no copy (accepted only if the server has no live record). descendants lists every live record below it with the revision the deleter knows; any difference is stale. Deleting removes all descendants.";
const invalidReasons =
  "invalid_content: the content breaks the release's rules. submission_reused: the id was used before for a different change (receipts are kept for 90 days). not_singleton: a singleton kind under another id.";

/**
 * Message rules of release 1.x, frozen with it. They say what the shapes alone can't.
 */
export const RELEASE_RULES = {
  text: "String lengths count UTF-16 code units. Timestamps are UTC with exactly three fraction digits (2026-11-10T19:57:06.000Z); other spellings are invalid, so each instant has one spelling and content compares as JSON.",
  sizes: `A record's content is at most ${MAX_RECORD_BYTES} bytes of UTF-8 JSON, measured as compact JSON with non-ASCII characters not escaped (larger content is invalid). A request body is at most ${MAX_REQUEST_BYTES} bytes; clients split uploads to stay below it. A download page stops early once its records hold about ${MAX_PAGE_BYTES} bytes, and always moves the cursor by at least one revision.`,
  restore:
    "hello's restoredFrom names the lineage a restored backup belonged to and the backup's revision; revisions up to it mean the same in that lineage and the current one. It is informational: a device that sees a new lineage resets, confirms identical copies by offering them again, and gives every other difference to the user for review.",
  lineage:
    "Push and pull carry the lineage from hello. A different lineage, or a pull cursor beyond the account's revision, is answered cursor_reset; in the second case the server first gives the account a new lineage.",
  push: "Each submission is decided on its own, in request order; the answer has exactly one result per submission, in the same order. Submission ids are unique within a request.",
  put: "baseRevision is the revision the edit started from, null to create. Content holds every field of the release; null means not set. Fields the release doesn't define keep their stored values.",
  delete: `${deletePreconditions} Deleting a deleted or unknown record is accepted. Singleton kinds can't be deleted.`,
  accepted:
    "The change is stored at revision; also answered for a repeat of an accepted submission id with the same content (the original revision), and when the content already equals the current copy.",
  conflict:
    "stale: the record changed since the base (or a descendant differs). deleted: the record is deleted. exists: a create of an id that exists with other content. parent_deleted: the parent is deleted. current is the server's copy for the requester's release, or null when the record never existed.",
  retry_later: "parent_missing: the parent isn't on the server yet; send again after it.",
  invalid: `${invalidReasons} not_deletable: a delete of a singleton kind.`,
  pull: "Changes after cursor in revision order. limit defaults to 100 (at most 500); waitMs (default 0, at most 25000) waits for a first change. Kinds the release doesn't have are skipped. A record the release can't represent is sent as unavailable. Save the page's cursor together with its changes.",
  errors:
    "invalid_request (HTTP 400): malformed request. unauthorized (401). unsupported_release (400): the server doesn't accept this release; serverReleases lists those it does. update_required (426): no common release; update names the side to update. cursor_reset (409): download everything again after connecting. unavailable (503): try again later. account_deleted (410): the account was deleted and can't be used again; stop syncing with it, keep local data and sign out.",
} as const;

/** Shared-ID children are deleted only together with their owner. */
export function releaseRules(contract: Contract, release: ReleaseId) {
  if (!contract.kindNames(release).some((kind) => contract.kind(kind).parent?.sharedId))
    return RELEASE_RULES;
  return {
    ...RELEASE_RULES,
    delete: `${deletePreconditions} The server checks all descendants, including kinds outside the requesting release. Singleton kinds cannot be deleted. A shared-ID child can be cleared by updating its content. A separate deletion of that child is refused while its owner is live. During recovery, retry a missing or deleted child's marker after a missing owner arrives. Accept that marker when its same-ID owner is deleted. Other deleted or unknown records accept deletion.`,
    invalid: `${invalidReasons} not_deletable: a delete of a singleton or an independent delete of a shared-ID child outside recovery.`,
  };
}
