import { MAX_WAIT_MS } from "@leve/contract";
import type { DeviceStore } from "@leve/storage";
import {
  httpTransport,
  type RequestHeaders,
  SyncClient,
  type SyncOutcome,
  type Transport,
  TransportError,
} from "@leve/sync";

/** What the person has to decide or do before syncing can go on. */
export type SyncPrompt =
  /** Data on this phone that never synced, and an account that already has data. */
  | { kind: "combine" }
  /**
   * This phone's data belongs to another account (or, after a build change, another server), and
   * some of it hasn't synced. The app counts the changes when it asks, as they can grow meanwhile.
   */
  | { kind: "switch"; reason: "account" | "server" }
  /** The server no longer accepts the sign-in. */
  | { kind: "sign_in" }
  /** The server no longer syncs with this version of the app. */
  | { kind: "update" };

export interface SyncStatus {
  prompt: SyncPrompt | null;
  /** When the last sync finished, in milliseconds. */
  lastSynced: number | null;
  /** When syncing started failing, if it has failed since the last sync. */
  failingSince: number | null;
  /**
   * The sync server is older than this app accepts: nothing syncs until it is updated. The session
   * keeps checking, and the app says so on every screen.
   */
  serverOutdated?: boolean;
  /**
   * Replacing this phone's data for another account waits for the workout being logged here to
   * end. Nothing syncs meanwhile, so the app says a question is waiting.
   */
  heldForWorkout?: boolean;
}

export interface SyncSessionOptions {
  store: DeviceStore;
  /** The sync server's URL. The device's sync state is bound to it. */
  server: string;
  /** The signed-in account. */
  account: string;
  /** Names this build to the server. */
  app: string;
  /** A session token for the account, or null without one. `fresh` skips a cached token. */
  token(fresh: boolean): Promise<string | null>;
  /** Downloaded changes were applied: screens should read the store again. */
  onPulled(): void;
  onStatus(status: SyncStatus): void;
  /**
   * Delete this phone's data and open an empty store, which a new session then syncs. This session
   * stops before it is called.
   */
  startOver(): void;
  lastSynced?: number | null;
  /**
   * Whether a workout is being logged on this phone, which replacing its data must never take
   * away. Defaults to any workout in progress; the app counts only one logged here, since another
   * phone's workout synced here would otherwise hold the switch back for as long as it runs.
   */
  loggingHere?: () => boolean;
  /** Builds the transport; tests reach an in-process server. */
  connect?: (server: string, headers: RequestHeaders) => Transport;
  now?: () => number;
  log?: (message: string) => void;
  /** How long to wait in each case; tests shorten them. */
  timing?: Partial<SyncTiming>;
}

export interface SyncTiming {
  /** After failures to reach the server in a row: soon at first, then less often. */
  offline: readonly number[];
  /** After an answer this build can't use: a bug, so not every few seconds. */
  error: number;
  /** The server is older than this app; it gets updated eventually. */
  serverUpdate: number;
  /** Edits close together (logging sets) go up in one sync. */
  nudge: number;
  /** How long one wait on the server for changes lasts. */
  wait: number;
  /** How often to look again while a workout in progress holds back replacing this phone's data. */
  busy: number;
}

export const SYNC_TIMING: SyncTiming = {
  offline: [5_000, 15_000, 60_000, 5 * 60_000],
  error: 15 * 60_000,
  serverUpdate: 60 * 60_000,
  nudge: 1_500,
  wait: MAX_WAIT_MS,
  busy: 60_000,
};

/** Whether the phone holds any data at all. */
export function hasLocalData(store: DeviceStore): boolean {
  return !!store.db.get("SELECT 1 FROM records LIMIT 1");
}

/** How many records have local changes the server hasn't accepted yet. */
export function unsyncedChanges(store: DeviceStore): number {
  const { pending, conflict, partial, invalid } = store.summary();
  const count = pending + conflict + partial + invalid;
  return count > 0 ? count : store.hasUnsyncedWork() ? 1 : 0;
}

/**
 * Keeps one phone in sync with one account while the app runs: it syncs when it starts, shortly
 * after local edits and when the app comes back to the front, and otherwise waits on the server for
 * changes made elsewhere. Failures that fix themselves (no connection, a server that is briefly
 * down) are retried quietly. Anything the person must decide stops it with a prompt.
 *
 * Before the phone's data joins an account it checks whose it is: data that never synced and an
 * account that already has data ask first (combine); data that belongs to another account is
 * replaced right away when all of it synced, and otherwise only once the person agrees.
 */
export class SyncSession {
  readonly #options: SyncSessionOptions;
  readonly #client: SyncClient;
  readonly #now: () => number;
  readonly #timing: SyncTiming;
  #stopped = false;
  #foreground = true;
  /** A sync (rather than a wait for changes) is due. */
  #due = true;
  #wake: (() => void) | null = null;
  #stopWaiting: (() => void) | null = null;
  #interrupted = false;
  #nudge: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;
  #freshToken = false;
  #retriedSignIn = false;
  /** Trying a refused sign-in again in the background, with its question still showing. */
  #checkingSignIn = false;
  #join = false;
  #status: SyncStatus;

  constructor(options: SyncSessionOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#timing = { ...SYNC_TIMING, ...options.timing };
    this.#status = { prompt: null, lastSynced: options.lastSynced ?? null, failingSince: null };
    const headers = async (): Promise<Record<string, string>> => {
      // A request of a stopped session (still running when another account signed in) must not
      // go out with the new account's token.
      if (this.#stopped) throw new TransportError("this sync session has ended");
      const fresh = this.#freshToken;
      this.#freshToken = false;
      let token: string | null;
      try {
        token = await options.token(fresh);
      } catch (error) {
        // Most often no connection to the sign-in service: nothing was sent.
        throw new TransportError(`no session token: ${(error as Error)?.message ?? error}`);
      }
      if (this.#stopped) throw new TransportError("this sync session has ended");
      return token ? { authorization: `Bearer ${token}` } : {};
    };
    const connect = options.connect ?? ((server, h) => httpTransport(server, h));
    this.#client = new SyncClient({
      store: options.store,
      transport: this.#interruptible(connect(options.server, headers)),
      server: options.server,
      account: options.account,
      app: options.app,
    });
  }

  get status(): SyncStatus {
    return this.#status;
  }

  start(): void {
    void this.#run();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#nudge) clearTimeout(this.#nudge);
    this.#stopWaiting?.();
    this.#wake?.();
  }

  /** Local data changed: sync soon, unless there is nothing to send. */
  nudge(): void {
    if (this.#stopped || !this.#options.store.hasUnsyncedWork()) return;
    if (this.#nudge) clearTimeout(this.#nudge);
    this.#nudge = setTimeout(() => {
      this.#nudge = null;
      this.#due = true;
      // While retrying after a failure, the retry's own timer decides when.
      if (this.#failures === 0) this.#interrupt();
    }, this.#timing.nudge);
  }

  /** The app came to the front (sync now) or went to the back (send what's left, then rest). */
  setForeground(active: boolean): void {
    this.#foreground = active;
    if (active) {
      // A sign-in the server refused may work again (say after a server fix): try once more,
      // keeping the question up unless it works.
      if (this.#status.prompt?.kind === "sign_in") {
        this.#checkingSignIn = true;
        this.#retriedSignIn = true;
        this.#freshToken = true;
        this.#due = true;
        this.#wake?.();
        return;
      }
      this.#failures = 0;
      this.#due = true;
      this.#interrupt();
    } else {
      this.#stopWaiting?.();
      if (this.#options.store.hasUnsyncedWork()) {
        this.#due = true;
        this.#wake?.();
      }
    }
  }

  /** The answer to "combine": the phone's data joins the account. */
  combine(): void {
    if (this.#status.prompt?.kind !== "combine") return;
    this.#join = true;
    this.#resume();
  }

  /**
   * The answer to "combine" or "switch": delete this phone's data and take the account's. Ends this
   * session.
   */
  replaceLocalData(): void {
    const prompt = this.#status.prompt?.kind;
    if (this.#stopped || (prompt !== "combine" && prompt !== "switch")) return;
    this.stop();
    this.#options.startOver();
  }

  /** Try again after a sign-in prompt, for example once the person signed in again. */
  retry(): void {
    if (this.#status.prompt?.kind !== "sign_in") return;
    this.#retriedSignIn = false;
    this.#freshToken = true;
    this.#resume();
  }

  #resume(): void {
    this.#failures = 0;
    this.#due = true;
    this.#setStatus({ prompt: null });
    this.#wake?.();
  }

  #ask(prompt: SyncPrompt): void {
    // A new question ends any sign-in check: the loop waits for its answer.
    this.#checkingSignIn = false;
    this.#setStatus({ prompt });
  }

  #setStatus(change: Partial<SyncStatus>): void {
    this.#status = { ...this.#status, ...change };
    if (!this.#stopped) this.#options.onStatus(this.#status);
  }

  /** Stops a wait for changes and wakes the loop, so a sync starts now. */
  #interrupt(): void {
    this.#stopWaiting?.();
    this.#wake?.();
  }

  /**
   * Lets a wait for changes be given up early (to send an edit, or when the app leaves the front).
   * The answer to a wait that was given up is dropped unread, so it can't be half applied; the next
   * download fetches the same changes.
   */
  #interruptible(inner: Transport): Transport {
    return (path, body, options) => {
      if (!(body as { waitMs?: number } | null)?.waitMs) return inner(path, body, options);
      // An edit made while connecting for this wait: send it instead of waiting. Nor wait once the
      // app has gone to the back.
      if (this.#due || this.#stopped || !this.#foreground) {
        this.#interrupted = true;
        return Promise.reject(new TransportError("stopped waiting"));
      }
      // Closes the request too, so it doesn't hold a connection to the server for nothing.
      const abort = new AbortController();
      const request = inner(path, body, { signal: abort.signal });
      return new Promise((resolve, reject) => {
        const stop = () => {
          this.#interrupted = true;
          abort.abort();
          reject(new TransportError("stopped waiting"));
        };
        this.#stopWaiting = stop;
        request.then(resolve, reject).finally(() => {
          if (this.#stopWaiting === stop) this.#stopWaiting = null;
        });
      });
    };
  }

  #sleep(ms: number | null): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = ms === null ? null : setTimeout(done, ms);
      const wake = () => done();
      function done() {
        if (timer) clearTimeout(timer);
        resolve();
      }
      this.#wake = wake;
    }).then(() => {
      this.#wake = null;
    });
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      // Waits while a question is open, except to check a refused sign-in again.
      const prompt = this.#status.prompt;
      const checking = prompt?.kind === "sign_in" && this.#checkingSignIn;
      if ((prompt && !checking) || (!this.#due && !this.#foreground)) {
        await this.#sleep(null);
        continue;
      }
      let delay: number | null;
      try {
        if (this.#due) {
          this.#due = false;
          delay = await this.#step();
        } else {
          // Nothing to send: wait on the server for changes made elsewhere.
          this.#interrupted = false;
          const outcome = await this.#client.waitForChanges(this.#timing.wait);
          if (this.#interrupted && outcome.state === "offline") continue;
          delay = this.#handle(outcome);
        }
      } catch (error) {
        // Not an answer from the server: the store refused something. Say so and back off.
        this.#options.log?.(`sync failed: ${(error as Error)?.message ?? String(error)}`);
        this.#checkingSignIn = false;
        delay = this.#retryAfter(this.#timing.error);
      }
      if (this.#stopped) return;
      if (delay !== null) {
        await this.#sleep(delay);
        this.#due = true;
      }
    }
  }

  /** One sync, after checking whose data this phone holds. A delay asks to try again after it. */
  async #step(): Promise<number | null> {
    const { store } = this.#options;
    const state = store.syncState();
    if (state.account === null) {
      if (!this.#join && hasLocalData(store)) {
        const probe = await this.#client.probe();
        // Stopped meanwhile (another account signed in): don't tie this phone to this one.
        if (this.#stopped) return null;
        if (probe.state !== "ready") return this.#handle(probe);
        // The server answered: a fresh-token retry that got here has done its job.
        this.#retriedSignIn = false;
        this.#checkingSignIn = false;
        if (probe.revision > 0) {
          this.#ask({ kind: "combine" });
          return null;
        }
      }
    } else if (state.account !== this.#options.account || state.server !== this.#options.server) {
      // Never take a workout being logged here away; look again once it ends.
      const logging = this.#options.loggingHere ?? (() => store.activeWorkout() !== null);
      if (logging()) {
        if (!this.#status.heldForWorkout) this.#setStatus({ heldForWorkout: true });
        return this.#timing.busy;
      }
      if (this.#status.heldForWorkout) this.#setStatus({ heldForWorkout: false });
      if (unsyncedChanges(store) > 0) {
        this.#ask({
          kind: "switch",
          reason: state.account !== this.#options.account ? "account" : "server",
        });
        return null;
      }
      // Everything here is on the other account's server already: nothing is lost.
      this.stop();
      this.#options.startOver();
      return null;
    }
    if (this.#stopped) return null;
    return this.#handle(await this.#client.sync());
  }

  #handle(outcome: SyncOutcome): number | null {
    if (this.#stopped) return null;
    this.#checkingSignIn = false;
    // The fresh-token retry counts only once the server has answered it.
    if (outcome.state !== "signed_out") this.#retriedSignIn = false;
    switch (outcome.state) {
      case "synced":
        this.#failures = 0;
        this.#join = false;
        this.#setStatus({
          lastSynced: this.#now(),
          failingSince: null,
          serverOutdated: false,
          ...(this.#status.prompt?.kind === "sign_in" ? { prompt: null } : {}),
        });
        if (outcome.pulled > 0) this.#options.onPulled();
        return null;
      case "offline": {
        const steps = this.#timing.offline;
        return this.#retryAfter(steps[Math.min(this.#failures, steps.length - 1)] as number);
      }
      case "signed_out":
        // A token can lapse between being handed out and checked: try once with a new one.
        if (!this.#retriedSignIn) {
          this.#retriedSignIn = true;
          this.#freshToken = true;
          return 0;
        }
        this.#ask({ kind: "sign_in" });
        return null;
      case "update_required":
        if (outcome.update === "client") {
          this.#ask({ kind: "update" });
          return null;
        }
        this.#options.log?.("sync paused: the server needs an update");
        if (!this.#status.serverOutdated) this.#setStatus({ serverOutdated: true });
        return this.#retryAfter(this.#timing.serverUpdate);
      case "error":
        this.#options.log?.(`sync failed: ${outcome.error}`);
        return this.#retryAfter(this.#timing.error);
    }
  }

  #retryAfter(ms: number): number {
    this.#failures += 1;
    if (this.#status.failingSince === null) this.#setStatus({ failingSince: this.#now() });
    return ms;
  }
}
