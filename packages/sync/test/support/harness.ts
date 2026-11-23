import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contract, JsonObject, ReleaseId } from "@leve/contract";
import { type DeviceStore, openDeviceStore, type SqlEngine } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { accountDatabasePath, ServerStorage, type ServerTransaction } from "@leve/storage/server";
import { SyncClient, type SyncOutcome } from "../../src/index.ts";
import { SyncService, serviceTransport } from "../../src/server/index.ts";
import { type Transport, TransportError } from "../../src/transport.ts";

/*
 * Test harness: real SQLite on both ends in a temporary directory, an injected clock, injected
 * ids and an injected transport. A restart closes the SQLite-backed store and opens it again, so
 * only persisted state survives.
 */

export const engine = createNodeSqliteEngine();

export class Clock {
  ms: number;
  constructor(start = "2026-11-10T08:00:00.000Z") {
    this.ms = Date.parse(start);
  }
  now = (): Date => new Date(this.ms);
  iso = (): string => new Date(this.ms).toISOString();
  advance(ms: number): void {
    this.ms += ms;
  }
  advanceDays(days: number): void {
    this.advance(days * 24 * 60 * 60 * 1000);
  }
}

export interface ServerOptions {
  contract?: Contract;
  releases?: readonly ReleaseId[];
  /** Wraps the storage the write service uses; broken variants replace parts of it. */
  wrapStorage?: (storage: ServerStorage) => ServerStorage;
  /** Wraps the contract the write service uses; broken variants replace parts of it. */
  serviceContract?: Contract;
  /** The long-polling timer seam. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface ServerRow {
  kind: string;
  id: string;
  revision: number;
  state: string;
  content: JsonObject | null;
  parentKind: string | null;
  parentId: string | null;
}

/** A server whose account databases live in `directory`; it can be restarted and reconfigured. */
export class ServerHarness {
  readonly directory: string;
  readonly clock: Clock;
  options: ServerOptions;
  storage!: ServerStorage;
  service!: SyncService;
  #lineages = 0;
  readonly #defaultContract: Contract | undefined;
  /** Deterministic lineage ids for rotations and restores. */
  newLineage = (): string => `lineage-${++this.#lineages}`;

  constructor(directory: string, clock: Clock, options: ServerOptions, defaultContract?: Contract) {
    this.directory = directory;
    this.clock = clock;
    this.#defaultContract = defaultContract;
    this.options = options;
    this.#start();
  }

  #start(): void {
    const contract = this.options.contract ?? this.#defaultContract;
    const releases = this.options.releases ?? contract?.releases;
    this.storage = new ServerStorage({
      engine,
      directory: this.directory,
      appVersion: "server-test",
      ...(contract ? { contract } : {}),
    });
    const storage = this.options.wrapStorage
      ? this.options.wrapStorage(this.storage)
      : this.storage;
    const serviceContract = this.options.serviceContract ?? contract;
    this.service = new SyncService({
      storage,
      now: this.clock.now,
      randomId: this.newLineage,
      ...(serviceContract ? { contract: serviceContract } : {}),
      ...(releases ? { releases } : {}),
      ...(this.options.setTimer ? { setTimer: this.options.setTimer } : {}),
    });
  }

  /** Stops the server and starts it again on the same databases, optionally reconfigured. */
  async restart(options: ServerOptions = this.options): Promise<void> {
    await this.storage.close();
    this.options = options;
    this.#start();
  }

  async stop(): Promise<void> {
    await this.storage.close();
  }

  /** A transport that always reaches the currently running service. */
  transport(account: string): Transport {
    return (path, body) => serviceTransport(this.service, account)(path, body);
  }

  dbPath(account: string): string {
    return accountDatabasePath(this.directory, account);
  }

  async rows(account: string): Promise<ServerRow[]> {
    const store = await this.storage.account(account);
    return store.db.all("SELECT * FROM records ORDER BY revision").map((row) => ({
      kind: String(row.kind),
      id: String(row.id),
      revision: Number(row.revision),
      state: String(row.state),
      content: row.content === null ? null : (JSON.parse(String(row.content)) as JsonObject),
      parentKind: row.parent_kind === null ? null : String(row.parent_kind),
      parentId: row.parent_id === null ? null : String(row.parent_id),
    }));
  }

  async row(account: string, kind: string, id: string): Promise<ServerRow | undefined> {
    return (await this.rows(account)).find((row) => row.kind === kind && row.id === id);
  }

  async head(account: string): Promise<number> {
    return (await this.storage.account(account)).headRevision();
  }

  async receipts(account: string): Promise<{ submissionId: string; revision: number }[]> {
    const store = await this.storage.account(account);
    return store.db
      .all("SELECT submission_id, revision FROM receipts ORDER BY submission_id")
      .map((row) => ({ submissionId: String(row.submission_id), revision: Number(row.revision) }));
  }

  /** Copies an account database while the server is stopped (it uses a rollback journal). */
  async snapshot(account: string, to: string): Promise<void> {
    await this.storage.close();
    copyFileSync(this.dbPath(account), to);
    this.#start();
  }

  /** Restores an account with the server's restore command, which assigns a new lineage. */
  restoreWithCommand(account: string, from: string): Promise<{ replaced: string | null }> {
    return this.storage.restoreAccount(account, from, {
      randomId: this.newLineage,
      now: this.clock.now,
    });
  }

  /** Replaces an account database with an older copy, as a restore from backup would. */
  async restore(account: string, from: string): Promise<void> {
    await this.storage.close();
    rmSync(`${this.dbPath(account)}-journal`, { force: true });
    copyFileSync(from, this.dbPath(account));
    this.#start();
  }
}

export interface PhoneOptions {
  account: string;
  server: string;
  transport: Transport;
  /** Submission ids are `${idPrefix}-${n}`; defaults to the phone's name. */
  idPrefix?: string;
  contract?: Contract;
  releases?: readonly ReleaseId[];
  pageSize?: number;
  /** Opens the device store; broken variants return a subclass. */
  openStore?: (options: Parameters<typeof openDeviceStore>[0]) => Promise<DeviceStore>;
  sqlEngine?: SqlEngine;
}

/** A phone process: a device store on its own SQLite file and a sync client. */
export class Phone {
  readonly name: string;
  readonly path: string;
  readonly clock: Clock;
  options: PhoneOptions;
  store!: DeviceStore;
  client!: SyncClient;
  #ids = 0;

  constructor(name: string, directory: string, clock: Clock, options: PhoneOptions) {
    this.name = name;
    this.path = join(directory, `${name}.db`);
    this.clock = clock;
    this.options = options;
  }

  nextId = (): string => `${this.options.idPrefix ?? this.name}-${++this.#ids}`;

  async open(): Promise<this> {
    const open = this.options.openStore ?? openDeviceStore;
    this.store = await open({
      engine: this.options.sqlEngine ?? engine,
      path: this.path,
      appVersion: "app-test",
      now: this.clock.iso,
      randomId: this.nextId,
      ...(this.options.contract ? { contract: this.options.contract } : {}),
    });
    this.client = new SyncClient({
      store: this.store,
      transport: (path, body) => this.options.transport(path, body),
      server: this.options.server,
      account: this.options.account,
      app: `app-${this.name}`,
      ...(this.options.contract ? { contract: this.options.contract } : {}),
      ...(this.options.releases ? { releases: this.options.releases } : {}),
      ...(this.options.pageSize ? { pageSize: this.options.pageSize } : {}),
    });
    return this;
  }

  close(): void {
    this.store.close();
  }

  /** Ends the process and starts it again from what SQLite persisted. */
  async restart(options: Partial<PhoneOptions> = {}): Promise<void> {
    this.close();
    this.options = { ...this.options, ...options };
    await this.open();
  }

  sync(): Promise<SyncOutcome> {
    return this.client.sync();
  }
}

/** A temporary directory with a clock, a server and phones; `dispose` removes everything. */
export class World {
  readonly directory = mkdtempSync(join(tmpdir(), "leve-sync-test-"));
  readonly clock = new Clock();
  readonly servers: ServerHarness[] = [];
  readonly phones: Phone[] = [];
  readonly #defaultContract: Contract | undefined;

  constructor(defaultContract?: Contract) {
    this.#defaultContract = defaultContract;
  }

  server(options: ServerOptions = {}): ServerHarness {
    const server = new ServerHarness(
      mkdtempSync(join(this.directory, "server-")),
      this.clock,
      options,
      this.#defaultContract,
    );
    this.servers.push(server);
    return server;
  }

  async phone(name: string, options: PhoneOptions): Promise<Phone> {
    const contract = options.contract ?? this.#defaultContract;
    const releases = options.releases ?? contract?.releases;
    const phone = new Phone(name, this.directory, this.clock, {
      ...options,
      ...(contract ? { contract } : {}),
      ...(releases ? { releases } : {}),
    });
    await phone.open();
    this.phones.push(phone);
    return phone;
  }

  async dispose(): Promise<void> {
    for (const phone of this.phones) {
      try {
        phone.close();
      } catch {
        // already closed
      }
    }
    for (const server of this.servers) await server.stop();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

export interface Exchange {
  path: string;
  request: unknown;
  response?: { status: number; body: unknown };
  fault?: Fault;
  /** A held copy delivered later; its reply went nowhere. */
  late?: boolean;
  /** The first copy of a duplicated request; the server handled it but its reply was dropped. */
  discarded?: boolean;
  /** When the server answered (the injected clock), and in which order across transports. */
  at?: number;
  seq?: number;
}

/** Orders exchanges of several transports by when the server answered them. */
export class ExchangeOrder {
  #n = 0;
  readonly now: () => number;
  constructor(now: () => number = () => 0) {
    this.now = now;
  }
  stamp(exchange: Exchange): void {
    exchange.at = this.now();
    exchange.seq = ++this.#n;
  }
}

export type Fault = "pass" | "offline" | "lose_reply" | "duplicate" | "hold_copy";

/**
 * Wraps a transport with injectable network faults and records every exchange:
 * - pass: delivered normally (lets a test target a later request);
 * - offline: nothing is sent;
 * - lose_reply: the server handles the request, then the reply is lost;
 * - duplicate: the request arrives twice; the second reply is returned;
 * - hold_copy: a copy of the request is kept and delivered later by `deliverHeld` (reordering).
 */
export class FaultyTransport {
  readonly inner: Transport;
  readonly log: Exchange[] = [];
  readonly held: { path: string; body: unknown }[] = [];
  #faults: { path: string | null; fault: Fault }[] = [];
  /** Runs after the server answered and before the reply reaches the caller. */
  beforeReply: ((path: string, response: { status: number; body: unknown }) => unknown) | null =
    null;
  /** Rewrites requests before sending; broken variants use it. */
  rewrite: ((path: string, body: unknown) => unknown | Promise<unknown>) | null = null;

  readonly order: ExchangeOrder;

  constructor(inner: Transport, order: ExchangeOrder = new ExchangeOrder()) {
    this.inner = inner;
    this.order = order;
  }

  /** Queues a fault for the next request (to `path`, or to any path when null). */
  next(fault: Fault, path: string | null = null): this {
    this.#faults.push({ path, fault });
    return this;
  }

  clearFaults(): void {
    this.#faults = [];
  }

  #take(path: string): Fault | undefined {
    const index = this.#faults.findIndex((entry) => entry.path === null || entry.path === path);
    if (index < 0) return undefined;
    const [entry] = this.#faults.splice(index, 1);
    return entry?.fault;
  }

  call: Transport = async (path, original) => {
    const body = this.rewrite ? await this.rewrite(path, original) : original;
    const fault = this.#take(path);
    const exchange: Exchange = {
      path,
      request: structuredClone(body),
      ...(fault && fault !== "pass" ? { fault } : {}),
    };
    this.log.push(exchange);
    if (fault === "offline") throw new TransportError("offline");
    if (fault === "hold_copy") this.held.push({ path, body: structuredClone(body) });
    let response = await this.inner(path, body);
    if (fault === "duplicate") {
      const first: Exchange = {
        path,
        request: structuredClone(body),
        response: structuredClone(response),
        discarded: true,
      };
      this.order.stamp(first);
      this.log.splice(this.log.indexOf(exchange), 0, first);
      response = await this.inner(path, body);
    }
    exchange.response = structuredClone(response);
    this.order.stamp(exchange);
    if (this.beforeReply) await this.beforeReply(path, response);
    if (fault === "lose_reply") throw new TransportError("reply lost");
    return response;
  };

  /** Delivers held copies now; their replies go nowhere. */
  async deliverHeld(): Promise<{ status: number; body: unknown }[]> {
    const replies: { status: number; body: unknown }[] = [];
    for (const { path, body } of this.held.splice(0)) {
      const response = await this.inner(path, body);
      const exchange: Exchange = {
        path,
        request: body,
        response: structuredClone(response),
        late: true,
      };
      this.order.stamp(exchange);
      this.log.push(exchange);
      replies.push(response);
    }
    return replies;
  }
}

/** Wraps an engine so that statements matching `fails` throw, simulating a crash mid-transaction. */
export function faultyEngine(base: SqlEngine, fails: (sql: string) => boolean): SqlEngine {
  return {
    ...base,
    open(path, options) {
      const connection = base.open(path, options);
      return {
        get path() {
          return connection.path;
        },
        exec: (sql) => connection.exec(sql),
        run(sql, params) {
          if (fails(sql)) throw new Error(`injected crash at: ${sql.slice(0, 40)}`);
          return connection.run(sql, params);
        },
        all: (sql, params) => connection.all(sql, params),
        get: (sql, params) => connection.get(sql, params),
        close: () => connection.close(),
      };
    },
  };
}

export const expectSynced = (outcome: SyncOutcome): SyncOutcome => {
  if (outcome.state !== "synced")
    throw new Error(`expected synced, got ${JSON.stringify(outcome)}`);
  return outcome;
};

/** Submissions a transport log shows were sent in push requests. */
export function sentSubmissions(log: readonly Exchange[]): Record<string, unknown>[] {
  return log
    .filter((exchange) => exchange.path === "/sync/push" && !exchange.discarded)
    .flatMap(
      (exchange) => (exchange.request as { submissions: Record<string, unknown>[] }).submissions,
    );
}

const bound = (target: object, prop: string | symbol) => {
  const value = Reflect.get(target, prop, target);
  return typeof value === "function" ? value.bind(target) : value;
};

/**
 * Server storage whose account transactions are wrapped, for injecting failures into the write
 * path or building broken variants.
 */
export function wrapTransactions(
  storage: ServerStorage,
  wrap: (tx: ServerTransaction) => Partial<ServerTransaction>,
): ServerStorage {
  return new Proxy(storage, {
    get(target, prop) {
      if (prop !== "account") return bound(target, prop);
      return async (accountId: string) => {
        const store = await target.account(accountId);
        return new Proxy(store, {
          get(inner, innerProp) {
            if (innerProp !== "transaction") return bound(inner, innerProp);
            return <T>(fn: (tx: ServerTransaction) => T): T =>
              inner.transaction((tx) => {
                const overrides = wrap(tx);
                const proxied = new Proxy(tx, {
                  get: (real, name) =>
                    Object.hasOwn(overrides, name)
                      ? (overrides as Record<string | symbol, unknown>)[name]
                      : bound(real, name),
                });
                return fn(proxied);
              });
          },
        });
      };
    },
  });
}

/** The submission results of a logged push exchange (empty when there was no answer). */
export const resultsOf = (exchange: Exchange | undefined): unknown[] =>
  ((exchange?.response?.body ?? {}) as { results?: unknown[] }).results ?? [];

/** The cursor a logged pull request asked for. */
export const cursorOf = (exchange: Exchange | undefined): number | undefined =>
  ((exchange?.request ?? {}) as { cursor?: number }).cursor;
