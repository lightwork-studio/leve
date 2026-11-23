import type { Contract, Submission, SubmissionResult } from "@leve/contract";
import { DeviceStore, openDeviceStore } from "@leve/storage";
import { describe, expect, it } from "vitest";
import {
  checkCursorOnlyFromDownloads,
  checkFileCopyThenWrite,
  checkNewerEditSurvives,
  checkOfflineAcrossTwoRestores,
  checkOmissionRule,
  checkPartialUpload,
  checkPeerValidatesReplies,
  checkPushLineageGuard,
  checkRestoredDeletedTree,
  checkRetryRecognised,
  checkRevisionCheck,
  type Variant,
} from "./support/checks.ts";
import { type PhoneOptions, wrapTransactions } from "./support/harness.ts";

/*
 * Deliberately broken implementations, built as test doubles around the real code. Each check
 * passes against the real implementation and must fail against its broken variant; a check that
 * cannot tell them apart would let the defect ship.
 */

type OpenStore = NonNullable<PhoneOptions["openStore"]>;

/** Device store that forgets about edits made while a submission was in flight. */
class ErasingAckStore extends DeviceStore {
  override applyPushResults(results: readonly SubmissionResult[]): void {
    for (const result of results) {
      const submission = this.db.get("SELECT * FROM submissions WHERE submission_id = ?", [
        result.submissionId,
      ]);
      if (!submission) continue;
      this.db.run("UPDATE records SET local_seq = ? WHERE kind = ? AND id = ?", [
        submission.local_seq ?? 0,
        submission.kind ?? "",
        submission.id ?? "",
      ]);
    }
    super.applyPushResults(results);
  }
}

/** Device store that moves the download cursor from upload answers. */
class CursorFromAckStore extends DeviceStore {
  override applyPushResults(results: readonly SubmissionResult[]): void {
    super.applyPushResults(results);
    for (const result of results) {
      if (result.status !== "accepted") continue;
      this.db.run("UPDATE sync_state SET cursor = max(cursor, ?) WHERE id = 1", [result.revision]);
    }
  }
}

/** Device store that takes the restored server's copy of records offered again, unasked. */
class QuietRestoreStore extends DeviceStore {
  override applyPushResults(results: readonly SubmissionResult[]): void {
    super.applyPushResults(results);
    this.#adopt();
  }

  override applyPull(...args: Parameters<DeviceStore["applyPull"]>): boolean {
    const applied = super.applyPull(...args);
    this.#adopt();
    return applied;
  }

  #adopt(): void {
    this.db.run(
      `UPDATE records SET local_state = NULL, local_content = NULL, local_base = NULL,
         status = 'synced', problem = NULL, problem_revision = NULL, problem_at = NULL,
         reoffered = 0
       WHERE reoffered = 1 AND status = 'conflict' AND server_state IS NOT NULL`,
    );
  }
}

const openAs =
  (Store: typeof DeviceStore): OpenStore =>
  async (options) => {
    const base = await openDeviceStore(options);
    return new Store(
      base.db,
      base.contract,
      options.now ?? (() => new Date().toISOString()),
      options.randomId ?? (() => crypto.randomUUID()),
    );
  };

const variants: {
  name: string;
  check: (variant?: Variant) => Promise<void>;
  broken: Variant;
  fails: RegExp;
}[] = [
  {
    name: "a skipped revision check (base rewritten to the current revision)",
    check: checkRevisionCheck,
    fails: /expected .by B. to be .by A./,
    broken: {
      tamper: (net, server) => {
        net.rewrite = async (path, body) => {
          if (path !== "/sync/push") return body;
          const request = structuredClone(body) as {
            release: "1.0";
            submissions: { kind: string; id: string; baseRevision: number | null }[];
          };
          for (const submission of request.submissions) {
            const current = await server.service.read(
              "alice",
              submission.kind,
              submission.id,
              request.release,
            );
            if (current) submission.baseRevision = current.revision;
          }
          return request;
        };
      },
    },
  },
  {
    name: "an old answer in a newer format (a reply gains a field)",
    check: checkPeerValidatesReplies,
    fails: /push response: \$ unknown serverTime/,
    broken: {
      tamper: (net) => {
        net.beforeReply = (path, response) => {
          if (path === "/sync/push" && response.status === 200) {
            (response.body as Record<string, unknown>).serverTime = "2026-11-10T18:00:00.000Z";
          }
        };
      },
    },
  },
  {
    name: "an old answer in a newer format (records encoded in the latest release)",
    check: checkOmissionRule,
    fails: /workout content: \$ unknown effortRating/,
    broken: {
      serviceContract: (contract): Contract => ({
        ...contract,
        encode: (kind, content) => contract.encode(kind, content, contract.latest),
      }),
    },
  },
  {
    name: "an omitted field clearing the stored value",
    check: checkOmissionRule,
    fails: /to deeply equal/,
    broken: {
      serviceContract: (contract): Contract => ({
        ...contract,
        applyOmissionRule: (kind, _stored, received, release) => {
          const result: Record<string, unknown> = {};
          for (const field of contract.fieldNames(kind, release)) {
            result[field] = received[field] ?? null;
          }
          return contract.normalize(kind, result);
        },
      }),
    },
  },
  {
    name: "a lossy upload marked synced (encoder reports nothing left out)",
    check: checkPartialUpload,
    fails: /status: .partial./,
    broken: {
      clientContract: (contract): Contract => ({
        ...contract,
        encode: (kind, content, release) => ({
          ...contract.encode(kind, content, release),
          omitted: [],
        }),
      }),
    },
  },
  {
    name: "a write without its receipt",
    check: checkRetryRecognised,
    fails: /to deeply equal/,
    broken: {
      wrapStorage: (storage) => wrapTransactions(storage, () => ({ saveReceipt: () => {} })),
    },
  },
  {
    name: "an acknowledgement erasing a newer local edit",
    check: checkNewerEditSurvives,
    fails: /status: .pending./,
    broken: { openStore: openAs(ErasingAckStore) },
  },
  {
    name: "a download cursor moved by upload answers",
    check: checkCursorOnlyFromDownloads,
    fails: /expected 3 to be 1/,
    broken: { openStore: openAs(CursorFromAckStore) },
  },
  {
    name: "a lineage check that runs after the upload was written",
    check: checkPushLineageGuard,
    fails: /to be 'C\\'s write'/,
    broken: {
      pushRoute: (server, account) => async (path, body) => {
        const request = body as { release: "1.0"; lineage: string; submissions: Submission[] };
        await server.service.submit(account, request.release, request.submissions);
        const hello = await server.service.hello(account, { releases: ["1.0"], app: "check" });
        if ((hello.body as { lineage: string }).lineage !== request.lineage) {
          return { status: 409, body: { error: { code: "cursor_reset", message: "restored" } } };
        }
        return server.transport(account)(path, body);
      },
    },
  },
  {
    name: "a client that takes the restored server's copy quietly (file copy)",
    check: checkFileCopyThenWrite,
    fails: /status: 'conflict'/,
    broken: { openStore: openAs(QuietRestoreStore) },
  },
  {
    name: "a client that takes the restored server's copy quietly (two restores)",
    check: checkOfflineAcrossTwoRestores,
    fails: /status: 'conflict'/,
    broken: { openStore: openAs(QuietRestoreStore) },
  },
  {
    name: "a client that takes a restored deletion quietly",
    check: checkRestoredDeletedTree,
    fails: /expected \[\] to deeply equal/,
    broken: { openStore: openAs(QuietRestoreStore) },
  },
];

describe.each(variants)("$name", ({ check, broken, fails }) => {
  it("passes against the real implementation", () => check());

  it("fails against the broken variant", async () => {
    await expect(check(broken)).rejects.toThrow(fails);
  });
});
