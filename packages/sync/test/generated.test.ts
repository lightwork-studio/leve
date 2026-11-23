import { describe, expect, it } from "vitest";
import { entry, Peer1, workout } from "./support/content.ts";
import {
  ExchangeOrder,
  FaultyTransport,
  type Phone,
  resultsOf,
  type ServerHarness,
  World,
} from "./support/harness.ts";

/*
 * Seeded generated sequences: random interleavings of edits, deletions, syncs, lost and
 * duplicated replies, late copies of old requests, restarts on both ends and a second writer (a
 * second phone and the archived 1.0 peer). Expected results come from an independent model built
 * from the answers observed on the wire, never from the implementation's helpers.
 *
 * On failure the seed and a compact trace are printed; rerun one seed with LEVE_SYNC_SEED=<n>
 * (LEVE_SYNC_DEBUG=<text> also prints every exchange mentioning it). LEVE_SYNC_SEEDS and
 * LEVE_SYNC_STEPS widen the search.
 */

const SEEDS = process.env.LEVE_SYNC_SEED
  ? [Number(process.env.LEVE_SYNC_SEED)]
  : Array.from({ length: Number(process.env.LEVE_SYNC_SEEDS ?? 20) }, (_, i) => 1000 + i * 7919);
const STEPS = Number(process.env.LEVE_SYNC_STEPS ?? 70);

/** mulberry32: small, fast and deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

const WORKOUTS = ["w1", "w2", "w3"];
const ENTRIES = ["e1", "e2", "e3"];
type Kind = "workout" | "workout_exercise";

const key = (kind: string, id: string) => `${kind}/${id}`;
const markerOf = (kind: string, content: Record<string, unknown> | null | undefined) =>
  content ? String(kind === "workout" ? content.title : content.exerciseName) : null;

/** What one phone last asked for a record, as the user would remember it. */
type LastWrite =
  | { op: "put"; marker: string; discarded?: string }
  | { op: "delete"; discarded?: string };

interface Actor {
  name: string;
  net: FaultyTransport;
}

/** What the seeds exercised, so a generator that stops producing faults or conflicts fails. */
const coverage = new Map<string, number>();
const count = (what: string) => coverage.set(what, (coverage.get(what) ?? 0) + 1);
const TRACE_EVENTS = [
  "[lose_push]",
  "[lose_pull]",
  "[duplicate]",
  "[offline]",
  "[hold]",
  "late copies",
  " restart",
  "server restart",
  "keep_mine",
  "keep_theirs",
  "save_as_new",
  "peer put",
  "peer delete",
  "+30 days",
];

function tally(trace: readonly string[], actors: Actor[]): void {
  for (const line of trace)
    for (const event of TRACE_EVENTS) if (line.includes(event)) count(event);
  for (const actor of actors) {
    for (const exchange of actor.net.log) {
      for (const result of resultsOf(exchange) as Record<string, unknown>[]) {
        count(
          `answer ${result.status}${result.reason ? `:${result.reason}` : ""}${result.code ? `:${result.code}` : ""}`,
        );
      }
    }
  }
}

async function run(seed: number): Promise<void> {
  const random = prng(seed);
  const trace: string[] = [];
  const world = new World();
  try {
    const server = world.server();
    const order = new ExchangeOrder(() => world.clock.ms);
    const actors: (Actor & { phone: Phone })[] = [];
    for (const name of ["a", "b"]) {
      const net = new FaultyTransport(server.transport("alice"), order);
      const phone = await world.phone(name, { account: "alice", server: "s", transport: net.call });
      actors.push({ name, net, phone });
    }
    const peerNet = new FaultyTransport(server.transport("alice"), order);
    const peer = new Peer1(peerNet.call, "p");
    await peer.hello();
    const lastWrites = new Map<string, Map<string, LastWrite>>(
      actors.map((a) => [a.name, new Map()]),
    );
    let markers = 0;
    const marker = (actor: string) => `${actor}#${++markers}`;
    let copies = 0;

    const step = (text: string) => trace.push(`${trace.length}: ${text}`);

    /** Lifts a phone's last write of `k` out of the lost-data check, with the reason. */
    const discard = (actor: Actor & { phone: Phone }, k: string, why: string) => {
      const writes = lastWrites.get(actor.name) as Map<string, LastWrite>;
      const last = writes.get(k);
      if (last) writes.set(k, { ...last, discarded: why });
    };

    /** Entries this phone wrote that sit under workout `id` locally. */
    const childrenWritten = (actor: Actor & { phone: Phone }, id: string) =>
      [...(lastWrites.get(actor.name) as Map<string, LastWrite>).keys()].filter((k) => {
        if (!k.startsWith("workout_exercise/")) return false;
        const record = actor.phone.store.get(
          "workout_exercise",
          k.slice("workout_exercise/".length),
        );
        return record?.content?.workoutId === id;
      });

    /**
     * Resolves one rejected record: a record deleted on the server is saved as new (with what is
     * shown under it) when it holds content, otherwise its deletion is accepted; any other conflict
     * is kept mine, except by phone b in the final round so the phones settle.
     */
    const resolveOne = (actor: Actor & { phone: Phone }, k: string, final: boolean) => {
      const writes = lastWrites.get(actor.name) as Map<string, LastWrite>;
      const [kind, id] = k.split("/") as [Kind, string];
      const store = actor.phone.store;
      const record = store.get(kind, id);
      // Already settled together with its parent.
      if (!record || (record.status !== "conflict" && record.status !== "invalid")) return;
      const reason = record.problem?.reason ?? "?";
      const gone = record.server?.state === "deleted" || reason === "deleted";
      if (reason === "parent_deleted" || (gone && (record.deleted || !record.content))) {
        for (const child of kind === "workout" ? childrenWritten(actor, id) : []) {
          discard(actor, child, "keep theirs on the parent");
        }
        store.resolve(kind, id, { choice: "keep_theirs" });
        discard(actor, k, "keep theirs");
        step(`${actor.name} resolve ${k} (${reason}) keep_theirs`);
        return;
      }
      if (gone) {
        const newId = `${id}-${actor.name}${++copies}`;
        const children = kind === "workout" ? childrenWritten(actor, id) : [];
        store.resolve(kind, id, { choice: "save_as_new", newId });
        // The copy holds what the phone showed. If that is the phone's last write, the write moves
        // to the copy; otherwise the last write must have reached the server earlier.
        const last = writes.get(k);
        const shown = String(markerOf(kind, record.content));
        writes.set(key(kind, newId), {
          op: "put",
          marker: shown,
          // A value the user already gave up (for example by deleting its parent) stays given up.
          ...(last?.discarded ? { discarded: last.discarded } : {}),
        });
        if (last?.op === "put" && last.marker === shown) discard(actor, k, "saved as new");
        // Entries copied along get new ids; follow each written value to its copy.
        const copied = new Map(
          store
            .list("workout_exercise", { parentId: newId })
            .map((r) => [markerOf(r.kind, r.content), key(r.kind, r.id)]),
        );
        for (const child of children) {
          const written = writes.get(child);
          const copy = written?.op === "put" ? copied.get(written.marker) : undefined;
          if (!written || !copy) continue;
          writes.set(copy, { ...(written as { op: "put"; marker: string }) });
          discard(actor, child, "copied with its parent");
        }
        step(`${actor.name} resolve ${k} (${reason}) save_as_new ${newId}`);
        return;
      }
      const mine = actor.name === "a" || !final;
      // Insisting on a deletion deletes what is under the record too.
      if (mine && record.deleted && kind === "workout") markChildrenSuperseded(actor, id);
      store.resolve(kind, id, { choice: mine ? "keep_mine" : "keep_theirs" });
      if (!mine) discard(actor, k, "keep theirs");
      step(`${actor.name} resolve ${k} (${reason}) ${mine ? "keep_mine" : "keep_theirs"}`);
    };

    /** Resolves every problem, parents first, since resolving a parent can settle its children. */
    const resolveAll = (actor: Actor & { phone: Phone }, final: boolean, only?: string) => {
      const keys = actor.phone.store
        .problems()
        .map((r) => key(r.kind, r.id))
        .filter((k) => only === undefined || k === only)
        .sort(
          (x, y) =>
            Number(x.startsWith("workout_exercise")) - Number(y.startsWith("workout_exercise")),
        );
      for (const k of keys) resolveOne(actor, k, final);
      return keys.length;
    };

    const markChildrenSuperseded = (actor: Actor & { phone: Phone }, workoutId: string) => {
      for (const child of childrenWritten(actor, workoutId)) {
        discard(actor, child, "parent deleted here");
      }
    };

    const sync = async (actor: Actor & { phone: Phone }, label: string) => {
      const outcome = await actor.phone.sync();
      step(`${actor.name} sync${label} -> ${outcome.state}`);
      if (outcome.state !== "synced" && outcome.state !== "offline") {
        throw new Error(`unexpected outcome ${JSON.stringify(outcome)}`);
      }
      return outcome;
    };

    /* ---------- phase 1: random traffic ---------- */
    for (let i = 0; i < STEPS; i++) {
      world.clock.advance(1000 + random.int(60_000));
      if (random.chance(0.03)) {
        world.clock.advanceDays(30);
        step("clock +30 days");
      }
      const roll = random.next();
      const actor = random.pick(actors) as Actor & { phone: Phone };
      const store = actor.phone.store;
      const writes = lastWrites.get(actor.name) as Map<string, LastWrite>;
      if (roll < 0.22) {
        const id = random.pick(WORKOUTS) as string;
        const row = store.get("workout", id);
        if (row?.deleted && row.status === "synced") continue;
        const m = marker(actor.name);
        store.put("workout", id, workout(m));
        writes.set(key("workout", id), { op: "put", marker: m });
        step(`${actor.name} put workout/${id} ${m}`);
      } else if (roll < 0.4) {
        const id = random.pick(ENTRIES) as string;
        const row = store.get("workout_exercise", id);
        if (row?.deleted && row.status === "synced") continue;
        // Like the app, only an entry that is shown (or a new one) can be edited.
        const shown = store.list("workout_exercise").some((r) => r.id === id);
        if (row && !row.deleted && !shown) continue;
        const visible = store.list("workout").map((r) => r.id);
        const parent =
          row?.content && !row.deleted ? String(row.content.workoutId) : random.pick(visible);
        if (!parent) continue;
        const m = marker(actor.name);
        store.put("workout_exercise", id, entry(parent, m));
        writes.set(key("workout_exercise", id), { op: "put", marker: m });
        step(`${actor.name} put workout_exercise/${id} ${m} under ${parent}`);
      } else if (roll < 0.5) {
        const visible = [
          ...store.list("workout").map((r) => key(r.kind, r.id)),
          ...store.list("workout_exercise").map((r) => key(r.kind, r.id)),
        ];
        const target = random.pick(visible);
        if (!target) continue;
        const [kind, id] = target.split("/") as [Kind, string];
        if (kind === "workout") markChildrenSuperseded(actor, id);
        const before = store.get(kind, id);
        // Deleting a record that never reached the server only removes the local copy; another
        // writer may still create the same id (as imports can).
        const localOnly = before !== null && before.server === null && !before.inFlight;
        store.delete(kind, id);
        writes.set(
          target,
          localOnly ? { op: "delete", discarded: "never uploaded" } : { op: "delete" },
        );
        step(`${actor.name} delete ${target}`);
      } else if (roll < 0.78) {
        const faults = [null, null, null, "lose_push", "lose_pull", "duplicate", "offline", "hold"];
        const fault = random.pick(faults);
        if (fault === "lose_push") actor.net.next("lose_reply", "/sync/push");
        if (fault === "lose_pull") actor.net.next("lose_reply", "/sync/pull");
        if (fault === "duplicate") actor.net.next("duplicate", "/sync/push");
        if (fault === "offline") actor.net.next("offline");
        if (fault === "hold") actor.net.next("hold_copy", "/sync/push");
        await sync(actor, fault ? ` [${fault}]` : "");
        actor.net.clearFaults();
      } else if (roll < 0.83) {
        await actor.phone.restart();
        step(`${actor.name} restart`);
      } else if (roll < 0.86) {
        await server.restart();
        step("server restart");
      } else if (roll < 0.89) {
        const replies = await actor.net.deliverHeld();
        step(`${actor.name} late copies delivered (${replies.length})`);
      } else if (roll < 0.93) {
        const problem = random.pick(store.problems());
        if (problem) resolveAll(actor, false, key(problem.kind, problem.id));
      } else {
        await peer.pull();
        const live = [...peer.records.values()].filter((r) => r.state === "live");
        const choice = random.next();
        if (choice < 0.5) {
          const id = random.pick(WORKOUTS) as string;
          const m = marker("p");
          const reply = await peer.push([peer.put("workout", id, workout(m))]);
          step(
            `peer put workout/${id} ${m} -> ${JSON.stringify((reply.results as { status: string }[])?.[0]?.status)}`,
          );
        } else if (choice < 0.75) {
          const parent = random.pick(live.filter((r) => r.kind === "workout"));
          const id = random.pick(ENTRIES) as string;
          const known = peer.records.get(key("workout_exercise", id));
          const parentId = known?.state === "live" ? String(known.content?.workoutId) : parent?.id;
          if (!parentId) continue;
          const m = marker("p");
          await peer.push([peer.put("workout_exercise", id, entry(parentId, m))]);
          step(`peer put workout_exercise/${id} ${m} under ${parentId}`);
        } else {
          const target = random.pick(live);
          if (!target) continue;
          await peer.push([peer.delete(target.kind, target.id)]);
          step(`peer delete ${key(target.kind, target.id)}`);
        }
      }
    }

    /* ---------- checks after the traffic settles, before anyone resolves anything ---------- */
    for (const actor of actors) actor.net.clearFaults();
    for (const actor of actors) await actor.net.deliverHeld();
    for (let round = 0; round < 3; round++) {
      for (const actor of actors) expect((await sync(actor, " settle")).state).toBe("synced");
    }
    if (process.env.LEVE_SYNC_DEBUG) debugExchanges([...actors, { name: "p", net: peerNet }]);
    const settled = await checkDecisions(server, [...actors, { name: "p", net: peerNet }]);
    checkNothingLost(actors, lastWrites, settled);

    /* ---------- resolve everything, then every client must show the server's copy ---------- */
    for (let round = 0; ; round++) {
      if (round > 8) throw new Error("did not settle after resolving conflicts");
      let open = 0;
      for (const actor of actors) {
        expect((await sync(actor, " final")).state).toBe("synced");
        open += resolveAll(actor, true);
        const summary = actor.phone.store.summary();
        open += summary.pending + summary.inFlight;
      }
      if (open === 0) break;
    }
    for (const actor of actors) expect((await sync(actor, " final")).state).toBe("synced");
    await peer.pull();

    const model = await checkDecisions(server, [...actors, { name: "p", net: peerNet }]);
    checkNothingLost(actors, lastWrites, model);
    const serverLive = liveView(model);
    for (const actor of actors) {
      const store = actor.phone.store;
      expect(store.summary(), `${actor.name} has no unresolved work`).toMatchObject({
        pending: 0,
        conflict: 0,
        invalid: 0,
        partial: 0,
        inFlight: 0,
      });
      const shown: Record<string, string | null> = {};
      for (const kind of ["workout", "workout_exercise"]) {
        for (const record of store.list(kind)) {
          shown[key(kind, record.id)] = markerOf(kind, record.content);
        }
      }
      same(shown, serverLive, `${actor.name} shows the server copy`);
    }
    const peerShown: Record<string, string | null> = {};
    for (const record of peer.records.values()) {
      if (record.state === "live") {
        peerShown[key(record.kind, record.id)] = markerOf(record.kind, record.content);
      }
    }
    same(peerShown, serverLive, "the archived peer shows the server copy");
    tally(trace, [...actors, { name: "p", net: peerNet }]);
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(
      `seed ${seed} failed: ${message}\n--- trace (rerun with LEVE_SYNC_SEED=${seed}) ---\n${trace.slice(-120).join("\n")}`,
    );
  } finally {
    await world.dispose();
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECEIPT_MS = 90 * DAY_MS;

/** JSON with sorted keys, so equal submissions compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface ModelRecord {
  state: "live" | "deleted";
  /** Exact for writes; a range for children deleted with their parent (order not specified). */
  revision: [number, number];
  marker: string | null;
  parent: string | null;
}

type Expected =
  | { status: "accepted"; revision: [number, number] }
  | { status: "conflict"; reason: string }
  | { status: "retry_later" }
  | { status: "invalid"; code: string };

/**
 * An independent model of the account on the server. It replays every request the server
 * handled, in the order it handled them, decides each submission by the rules of the standard
 * (receipts for 90 days, base revision equal to the current one, equal content after a lost
 * receipt, deletion markers forever, parents before children, deletions checking the descendants
 * the deleter knew) and fails as soon as the server answered differently.
 */
class ServerModel {
  head = 0;
  readonly records = new Map<string, ModelRecord>();
  readonly #receipts = new Map<string, { digest: string; revision: number; at: number }>();
  /** `${actor}|${key}|${marker or "delete"}` for every accepted submission. */
  readonly accepted = new Set<string>();

  #liveChildren(parentKey: string): [string, ModelRecord][] {
    return [...this.records].filter(([, r]) => r.state === "live" && r.parent === parentKey);
  }

  #liveDescendants(parentKey: string): [string, ModelRecord][] {
    return this.#liveChildren(parentKey).flatMap(([k, r]) => [
      [k, r] as [string, ModelRecord],
      ...this.#liveDescendants(k),
    ]);
  }

  #expect(submission: Record<string, unknown>, at: number): Expected {
    const k = key(String(submission.kind), String(submission.id));
    const current = this.records.get(k);
    const base = submission.baseRevision as number | null;
    const next = (count = 1): Expected => ({
      status: "accepted",
      revision: [this.head + count, this.head + count],
    });
    const unchanged = (record: ModelRecord): Expected => ({
      status: "accepted",
      revision: record.revision,
    });
    const receipt = this.#receipts.get(String(submission.submissionId));
    if (receipt && receipt.at >= at - RECEIPT_MS) {
      if (receipt.digest !== stable(submission))
        return { status: "invalid", code: "submission_reused" };
      return { status: "accepted", revision: [receipt.revision, receipt.revision] };
    }
    if (submission.op === "delete") {
      if (!current) return next();
      if (current.state === "deleted") return unchanged(current);
      if (base !== current.revision[0]) return { status: "conflict", reason: "stale" };
      const known = new Set(
        (submission.descendants as { kind: string; id: string; revision: number }[]).map(
          (d) => `${key(d.kind, d.id)}@${d.revision}`,
        ),
      );
      const live = this.#liveDescendants(k).map(([dk, d]) => `${dk}@${d.revision[0]}`);
      if (live.length !== known.size || !live.every((entry) => known.has(entry))) {
        return { status: "conflict", reason: "stale" };
      }
      return next(live.length + 1);
    }
    const content = submission.content as Record<string, unknown>;
    const kind = String(submission.kind);
    const marker = markerOf(kind, content);
    const parent = kind === "workout_exercise" ? key("workout", String(content.workoutId)) : null;
    if (current?.state === "deleted") return { status: "conflict", reason: "deleted" };
    if (current) {
      if (base !== current.revision[0]) {
        if (current.marker === marker && current.parent === parent) return unchanged(current);
        return { status: "conflict", reason: base === null ? "exists" : "stale" };
      }
    } else if (base !== null) {
      return { status: "conflict", reason: "stale" };
    }
    if (parent) {
      const parentRecord = this.records.get(parent);
      if (!parentRecord) return { status: "retry_later" };
      if (parentRecord.state === "deleted") return { status: "conflict", reason: "parent_deleted" };
    }
    return next();
  }

  /** Checks the server's answer to one submission and applies it to the model. */
  apply(
    actor: string,
    submission: Record<string, unknown>,
    result: Record<string, unknown>,
    at: number,
  ) {
    const k = key(String(submission.kind), String(submission.id));
    const expected = this.#expect(submission, at);
    const describe = () =>
      `${actor} ${String(submission.op)} ${k} base ${String(submission.baseRevision)} ` +
      `(model: ${JSON.stringify(this.records.get(k) ?? null)}, head ${this.head}): ` +
      `expected ${JSON.stringify(expected)}, server answered ${JSON.stringify(result)}`;
    if (result.status !== expected.status) throw new Error(`wrong decision: ${describe()}`);
    if (expected.status === "conflict" && result.reason !== expected.reason) {
      throw new Error(`wrong conflict reason: ${describe()}`);
    }
    if (expected.status === "invalid" && result.code !== expected.code) {
      throw new Error(`wrong invalid code: ${describe()}`);
    }
    if (expected.status === "conflict") {
      // The answer carries the server's current copy as the model knows it.
      const current = result.current as Record<string, unknown> | null;
      const record = this.records.get(k);
      const revision = Number(current?.revision);
      const matches =
        expected.reason === "parent_deleted" && !record
          ? current === null
          : record !== undefined &&
            current !== null &&
            revision >= record.revision[0] &&
            revision <= record.revision[1] &&
            current.state === record.state &&
            (record.state !== "live" ||
              markerOf(String(submission.kind), current.content as Record<string, unknown>) ===
                record.marker);
      if (!matches) throw new Error(`wrong current copy in conflict: ${describe()}`);
    }
    if (expected.status !== "accepted") return;
    const revision = Number(result.revision);
    if (revision < expected.revision[0] || revision > expected.revision[1]) {
      throw new Error(`wrong revision: ${describe()}`);
    }
    const id = String(submission.submissionId);
    const receipt = this.#receipts.get(id);
    if (!receipt || receipt.at < at - RECEIPT_MS) {
      this.#receipts.set(id, { digest: stable(submission), revision, at });
    }
    const marker =
      submission.op === "put"
        ? markerOf(String(submission.kind), submission.content as Record<string, unknown>)
        : null;
    this.accepted.add(`${actor}|${k}|${marker ?? "delete"}`);
    if (revision <= this.head) return; // A repeat or an already applied change.
    if (submission.op === "delete") {
      const descendants = this.#liveDescendants(k);
      for (const [dk] of descendants) {
        this.records.set(dk, {
          state: "deleted",
          revision: [this.head + 1, this.head + descendants.length],
          marker: null,
          parent: null,
        });
      }
      this.records.set(k, {
        state: "deleted",
        revision: [revision, revision],
        marker: null,
        parent: null,
      });
    } else {
      const content = submission.content as Record<string, unknown>;
      this.records.set(k, {
        state: "live",
        revision: [revision, revision],
        marker,
        parent:
          submission.kind === "workout_exercise" ? key("workout", String(content.workoutId)) : null,
      });
    }
    this.head = revision;
  }
}

/** Replays every push the server handled, in order, through the model; then compares state. */
async function checkDecisions(server: ServerHarness, actors: Actor[]): Promise<ServerModel> {
  const exchanges = actors
    .flatMap((actor) => actor.net.log.map((exchange) => ({ actor: actor.name, exchange })))
    .filter(({ exchange }) => exchange.path === "/sync/push" && exchange.response?.status === 200)
    .sort((x, y) => Number(x.exchange.seq) - Number(y.exchange.seq));
  const model = new ServerModel();
  for (const { actor, exchange } of exchanges) {
    const submissions = (exchange.request as { submissions: Record<string, unknown>[] })
      .submissions;
    const results = resultsOf(exchange) as Record<string, unknown>[];
    expect(results.length).toBe(submissions.length);
    submissions.forEach((submission, index) => {
      model.apply(
        actor,
        submission,
        results[index] as Record<string, unknown>,
        Number(exchange.at),
      );
    });
  }
  const rows = await server.rows("alice");
  const actual: Record<string, string> = {};
  for (const row of rows) {
    if (row.state === "deleted") expect(row.content, `${row.id} marker has no content`).toBeNull();
    actual[key(row.kind, row.id)] =
      row.state === "live" ? `live ${markerOf(row.kind, row.content)}` : "deleted";
  }
  const expected: Record<string, string> = {};
  for (const [k, record] of model.records) {
    expected[k] = record.state === "live" ? `live ${record.marker}` : "deleted";
  }
  same(actual, expected, "server matches the model of its decisions");
  expect(await server.head("alice"), "revision counter").toBe(model.head);
  const liveMarkers = rows
    .filter((r) => r.state === "live")
    .map((r) => markerOf(r.kind, r.content));
  expect(new Set(liveMarkers).size, "no write is stored twice").toBe(liveMarkers.length);
  return model;
}

function liveView(model: ServerModel): Record<string, string | null> {
  const view: Record<string, string | null> = {};
  for (const [k, record] of model.records) if (record.state === "live") view[k] = record.marker;
  return view;
}

/** Every value a phone wrote is on the server at some point or still held on the phone. */
function checkNothingLost(
  actors: (Actor & { phone: Phone })[],
  lastWrites: Map<string, Map<string, LastWrite>>,
  model: ServerModel,
) {
  for (const actor of actors) {
    for (const [k, last] of lastWrites.get(actor.name) ?? []) {
      if (last.discarded) continue;
      const [kind, id] = k.split("/") as [Kind, string];
      const record = actor.phone.store.get(kind, id);
      expect(record?.status, `${actor.name} ${k} is never left invalid`).not.toBe("invalid");
      if (last.op === "delete") {
        expect(
          !record || record.deleted,
          `${actor.name} deleted ${k}; it must stay deleted: ${JSON.stringify(record)}`,
        ).toBe(true);
        continue;
      }
      const held =
        record !== null &&
        record.status !== "synced" &&
        markerOf(kind, record.content) === last.marker;
      const reachedServer = model.accepted.has(`${actor.name}|${k}|${last.marker}`);
      expect(
        held || reachedServer,
        `${actor.name} wrote ${last.marker} to ${k}: neither held (${record?.status} ${markerOf(kind, record?.content)}) nor accepted`,
      ).toBe(true);
    }
  }
}

describe("seeded generated sequences", () => {
  it.each(SEEDS)(
    "seed %i converges without losing or reviving data",
    async (seed) => {
      await run(seed);
    },
    30_000,
  );

  it.skipIf(SEEDS.length < 8)("exercised every fault, resolution and answer", () => {
    const required = [
      ...TRACE_EVENTS,
      "answer accepted",
      "answer conflict:stale",
      "answer conflict:deleted",
      "answer conflict:exists",
    ];
    for (const what of required) expect(coverage.get(what) ?? 0, what).toBeGreaterThan(0);
    for (const [what] of coverage) expect(what, "no answer is invalid").not.toMatch(/invalid/);
    if (process.env.LEVE_SYNC_COVERAGE) console.log(Object.fromEntries(coverage));
  });
});

/** Prints every exchange mentioning LEVE_SYNC_DEBUG, in the order the server answered them. */
function debugExchanges(actors: Actor[]): void {
  const needle = process.env.LEVE_SYNC_DEBUG ?? "";
  const all = actors
    .flatMap((actor) => actor.net.log.map((exchange) => ({ actor: actor.name, exchange })))
    .sort((x, y) => Number(x.exchange.seq) - Number(y.exchange.seq));
  for (const { actor, exchange } of all) {
    const text = JSON.stringify(exchange).replace(
      /"description":"","endedAt":null,"routineId":null,"startedAt":"[^"]*",|"doubleDumbbellVolume":false,"exerciseId":"bench-press-barbell",|"exerciseType":"weight_reps","notes":\[\],"position":1,"restSeconds":90,"supersetId":null,/g,
      "",
    );
    if (text.includes(needle)) console.log(`${actor} ${text}`);
  }
}

/** Deep equality with both sides printed in full on failure, for the trace. */
function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual, Object.keys(actual as object).sort());
  const e = JSON.stringify(expected, Object.keys(expected as object).sort());
  if (a !== e) throw new Error(`${what}\n  actual:   ${a}\n  expected: ${e}`);
}
