import {
  type Change,
  CLIENT_RELEASES,
  type Contract,
  type ErrorResponse,
  errorResponseSchema,
  type HelloResponse,
  helloResponseSchema,
  jsonBytes,
  MAX_REQUEST_BYTES,
  type PullResponse,
  type PushResponse,
  type ReleaseId,
  releaseMessages,
  validate,
} from "@leve/contract";
import type { DeviceStore, OutgoingSubmission } from "@leve/storage";
import type { Transport, TransportResponse } from "../transport.ts";

export type SyncOutcome =
  | { state: "synced"; pushed: number; pulled: number }
  /** No release in common: sync pauses until one side updates. Local work continues. */
  | { state: "update_required"; update: "client" | "server" }
  /** The server couldn't be reached or is briefly unavailable; everything stays queued. */
  | { state: "offline"; error: string }
  /** The server no longer accepts this sign-in: sign in again. Everything stays queued. */
  | { state: "signed_out" }
  /** The server answered something this build can't accept; nothing was applied. */
  | { state: "error"; error: string };

/** What the server's account holds, asked before this device connects to it (see `probe`). */
export type ProbeOutcome =
  | { state: "ready"; revision: number }
  | Exclude<SyncOutcome, { state: "synced" }>;

export interface SyncClientOptions {
  store: DeviceStore;
  transport: Transport;
  /** Identifies the server and account; the device's sync state is bound to them. */
  server: string;
  account: string;
  app: string;
  releases?: readonly ReleaseId[];
  contract?: Contract;
  pageSize?: number;
}

class Stop extends Error {
  readonly outcome: SyncOutcome;
  constructor(outcome: SyncOutcome) {
    super(outcome.state);
    this.outcome = outcome;
  }
}

/** Splits submissions into requests that stay below the server's request size limit. */
function splitBySize<T>(submissions: readonly T[]): T[][] {
  const budget = MAX_REQUEST_BYTES - 64 * 1024;
  const requests: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const submission of submissions) {
    const size = jsonBytes(submission);
    if (current.length > 0 && bytes + size > budget) {
      requests.push(current);
      current = [];
      bytes = 0;
    }
    current.push(submission);
    bytes += size;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

/** The server answered that its history changed (`cursor_reset`): connect again. */
class Restart extends Error {}

const MAX_PUSH_ROUNDS = 50;

/** Uploads pending edits, then downloads changes. One sync runs at a time. */
export class SyncClient {
  readonly store: DeviceStore;
  readonly contract: Contract;
  readonly releases: readonly ReleaseId[];
  readonly #options: SyncClientOptions;
  #running: Promise<SyncOutcome> | null = null;
  #bindingVersion = 0;
  /** Every network exchange runs in this lane, one at a time. */
  #lane: Promise<unknown> = Promise.resolve();

  constructor(options: SyncClientOptions) {
    this.#options = options;
    this.store = options.store;
    this.contract = options.contract ?? options.store.contract;
    this.releases = options.releases ?? CLIENT_RELEASES;
  }

  /** Whether a feature can be used for new entries. Local mode has every feature. */
  featureAvailable(feature: string): boolean {
    const state = this.store.syncState();
    const release = state.account === null ? this.contract.latest : state.release;
    return release !== null && this.contract.features(release).includes(feature);
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#lane.then(run, run);
    this.#lane = next.catch(() => {});
    return next;
  }

  /** Uploads, then downloads. Calls made while one runs share its result. */
  sync(): Promise<SyncOutcome> {
    if (!this.#running) {
      this.#running = this.#exclusive(() => this.#sync(0)).finally(() => {
        this.#running = null;
      });
    }
    return this.#running;
  }

  /**
   * Waits up to `waitMs` on the server for changes made elsewhere, then applies them. It runs in
   * the same lane as `sync()` and makes the same account and history checks.
   */
  waitForChanges(waitMs: number): Promise<SyncOutcome> {
    return this.#exclusive(async () => {
      try {
        const release = await this.#connect();
        const pulled = await this.#pull(release, waitMs);
        return { state: "synced", pushed: 0, pulled } as SyncOutcome;
      } catch (error) {
        if (error instanceof Restart) return this.#sync(1);
        return this.#outcome(error);
      }
    });
  }

  /**
   * Asks the server how much the account holds (its highest revision; 0 for an empty account),
   * without connecting this device to it: nothing on the device changes. The app uses it to ask
   * before local data joins an account that already has data.
   */
  probe(): Promise<ProbeOutcome> {
    return this.#exclusive(async () => {
      try {
        const { hello } = await this.#greet(false);
        return { state: "ready", revision: hello.revision } as const;
      } catch (error) {
        return this.#outcome(error) as ProbeOutcome;
      }
    });
  }

  async #connect(): Promise<ReleaseId> {
    this.store.bindAccount(this.#options.server, this.#options.account);
    this.#bindingVersion = this.store.bindingVersion;
    return this.#hello();
  }

  async #sync(attempt: number): Promise<SyncOutcome> {
    try {
      const release = await this.#connect();
      let pulled = 0;
      let pushed = 0;
      // Retrying an envelope in an older release can reveal another incomplete server copy.
      // Finish every such download and drain the edits it unblocks in this sync.
      do {
        if (this.store.syncState().refreshFrom) pulled += await this.#pull(release, 0);
        pushed += await this.#push(release);
      } while (this.store.syncState().refreshFrom);
      pulled += await this.#pull(release, 0);
      this.#requireBinding();
      if (this.store.syncState().restoring) {
        this.store.completeRestore();
        pushed += await this.#push(release);
      }
      return { state: "synced", pushed, pulled };
    } catch (error) {
      if (error instanceof Restart) {
        // The server's history changed under us; connect again, which resets this device.
        if (attempt < 2) return this.#sync(attempt + 1);
        return { state: "error", error: "the server keeps answering that its history changed" };
      }
      return this.#outcome(error);
    }
  }

  #outcome(error: unknown): SyncOutcome {
    if (error instanceof Stop) return error.outcome;
    if ((error as Error)?.name === "TransportError") {
      return { state: "offline", error: (error as Error).message };
    }
    throw error;
  }

  #requireBinding(): void {
    if (this.store.bindingVersion !== this.#bindingVersion) {
      throw new Stop({ state: "offline", error: "the device changed its sync account" });
    }
  }

  async #call(path: string, body: unknown, checkBinding = true): Promise<TransportResponse> {
    if (checkBinding) this.#requireBinding();
    const response = await this.#options.transport(path, body);
    if (checkBinding) this.#requireBinding();
    if (response.status !== 200) {
      const issues = validate(errorResponseSchema, response.body);
      if (issues.length > 0) {
        throw new Stop({
          state: "error",
          error: `unreadable error from ${path} (${response.status})`,
        });
      }
      // Neither says anything about this request: the sign-in, or the server for a while.
      const { code, message } = this.#error(response.body);
      if (code === "unauthorized") throw new Stop({ state: "signed_out" });
      if (code === "unavailable")
        throw new Stop({ state: "offline", error: `unavailable: ${message}` });
    }
    return response;
  }

  #error(body: unknown): ErrorResponse["error"] {
    return (body as ErrorResponse).error;
  }

  /** Sends hello and checks the answer, without changing the device. */
  async #greet(checkBinding: boolean): Promise<{ release: ReleaseId; hello: HelloResponse }> {
    const response = await this.#call(
      "/sync/hello",
      { releases: [...this.releases], app: this.#options.app },
      checkBinding,
    );
    if (response.status !== 200) {
      const error = this.#error(response.body);
      if (error.code === "update_required") {
        throw new Stop({ state: "update_required", update: error.update ?? "client" });
      }
      throw new Stop({ state: "error", error: `${error.code}: ${error.message}` });
    }
    const issues = validate(helloResponseSchema, response.body);
    const hello = response.body as HelloResponse;
    if (issues.length > 0 || !this.releases.includes(hello.release as ReleaseId)) {
      throw new Stop({
        state: "error",
        error: "the server chose a release this app doesn't speak",
      });
    }
    return { release: hello.release as ReleaseId, hello };
  }

  async #hello(): Promise<ReleaseId> {
    const { release, hello } = await this.#greet(true);
    this.#requireBinding();
    const before = this.store.syncState();
    const otherHistory = before.lineage !== null && before.lineage !== hello.lineage;
    if (!otherHistory && before.lineage !== null && hello.revision < before.cursor) {
      // The account went back in time without a new lineage (for example a copied file). A pull
      // from this cursor makes the server start a new lineage, so every device resets, not only
      // this one; then connect again.
      const reply = await this.#call("/sync/pull", {
        release,
        lineage: before.lineage,
        cursor: before.cursor,
        limit: 1,
      });
      // Reset only once the server has started the new lineage: connecting again shows it. If
      // the request failed, nothing changes here; if the server's counter caught up meanwhile,
      // connect again and look once more.
      this.#requireBinding();
      if (reply.status === 200 || this.#error(reply.body).code === "cursor_reset") {
        throw new Restart();
      }
      const error = this.#error(reply.body);
      throw new Stop({ state: "error", error: `${error.code}: ${error.message}` });
    }
    if (otherHistory) {
      // The server's history changed (a restore): reset before uploading, so pending edits aren't
      // judged against lost revisions. Every difference the reset finds goes to the user.
      this.store.resetForServerRestore();
    }
    this.store.setNegotiated(release, hello.features, hello.lineage);
    return release;
  }

  async #push(release: ReleaseId): Promise<number> {
    let pushed = 0;
    for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
      this.#requireBinding();
      const outgoing = this.store.prepareSubmissions(release);
      if (outgoing.length === 0) return pushed;
      let progressed = false;
      const groups = new Map<ReleaseId, OutgoingSubmission["submission"][]>();
      for (const item of outgoing) {
        groups.set(item.release, [...(groups.get(item.release) ?? []), item.submission]);
      }
      const requests = [...groups].flatMap(([groupRelease, all]) =>
        splitBySize(all).map((submissions) => [groupRelease, submissions] as const),
      );
      for (const [groupRelease, submissions] of requests) {
        const response = await this.#call("/sync/push", {
          release: groupRelease,
          lineage: this.store.syncState().lineage,
          submissions,
        });
        this.#requireBinding();
        if (response.status !== 200) {
          const error = this.#error(response.body);
          if (error.code === "cursor_reset") throw new Restart();
          if (error.code === "unsupported_release" && groupRelease !== release) {
            // Made for a release the server dropped; they become new submissions.
            this.store.abandonSubmissions(groupRelease);
            progressed = true;
            continue;
          }
          if (error.code === "update_required" || error.code === "unsupported_release") {
            throw new Stop({ state: "update_required", update: error.update ?? "client" });
          }
          throw new Stop({ state: "error", error: `${error.code}: ${error.message}` });
        }
        const issues = validate(
          releaseMessages(this.contract, groupRelease).pushResponse,
          response.body,
        );
        const body = response.body as PushResponse;
        if (issues.length > 0 || body.release !== groupRelease) {
          throw new Stop({ state: "error", error: "unreadable push answer" });
        }
        const sent = new Map(
          submissions.map((submission) => [submission.submissionId, submission]),
        );
        for (const result of body.results) {
          const submission = sent.get(result.submissionId);
          if (!submission) {
            throw new Stop({ state: "error", error: "push answer for an unknown submission" });
          }
          if (
            result.status === "conflict" &&
            result.current &&
            (result.current.kind !== submission.kind ||
              result.current.id !== submission.id ||
              !this.#readable(result.current, groupRelease))
          ) {
            throw new Stop({ state: "error", error: "unreadable record in push answer" });
          }
          if (result.status !== "retry_later") progressed = true;
          if (result.status === "accepted") pushed += 1;
        }
        const flags = response.writtenRevisions;
        const written = new Set<string>();
        if (flags?.length === body.results.length && /^[01]+$/.test(flags)) {
          body.results.forEach((result, index) => {
            if (result.status === "accepted" && flags[index] === "1")
              written.add(result.submissionId);
          });
        }
        this.store.applyPushResults(body.results, written);
      }
      if (!progressed) return pushed;
    }
    return pushed;
  }

  #readable(change: Change, release: ReleaseId): boolean {
    if (change.state !== "live") return this.contract.hasKind(change.kind, release);
    return this.contract.decode(change.kind, change.content, release, change.id).length === 0;
  }

  async #pull(release: ReleaseId, waitMs: number): Promise<number> {
    let pulled = 0;
    let wait = waitMs;
    for (;;) {
      this.#requireBinding();
      const { cursor, lineage } = this.store.syncState();
      const request = {
        release,
        lineage,
        cursor,
        limit: this.#options.pageSize ?? 100,
        ...(wait > 0 ? { waitMs: wait } : {}),
      };
      const response = await this.#call("/sync/pull", request);
      this.#requireBinding();
      if (response.status !== 200) {
        const error = this.#error(response.body);
        if (error.code === "cursor_reset") throw new Restart();
        if (error.code === "update_required" || error.code === "unsupported_release") {
          throw new Stop({ state: "update_required", update: error.update ?? "client" });
        }
        throw new Stop({ state: "error", error: `${error.code}: ${error.message}` });
      }
      const issues = validate(releaseMessages(this.contract, release).pullResponse, response.body);
      const page = response.body as PullResponse;
      if (
        issues.length > 0 ||
        page.release !== release ||
        page.cursor < cursor ||
        (page.hasMore && page.cursor === cursor) ||
        !page.changes.every((change) => this.#readable(change, release))
      ) {
        throw new Stop({ state: "error", error: "unreadable pull answer" });
      }
      if (
        !this.store.applyPull(page.changes, page.cursor, {
          cursor,
          lineage,
          release,
          lastPage: !page.hasMore,
        })
      ) {
        // The device was reset while this page was on its way; it belongs to the old history.
        throw new Restart();
      }
      pulled += page.changes.length;
      wait = 0;
      if (!page.hasMore) return pulled;
    }
  }
}
