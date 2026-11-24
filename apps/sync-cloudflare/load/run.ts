import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { SyncClient, type Transport, TransportError, WRITTEN_REVISIONS_HEADER } from "@leve/sync";
import { clerkTestUsers } from "./clerk.ts";
import { history, workoutRecords } from "./history.ts";

/*
 * Drives the real phone storage and sync client against a deployed sync server and logs what
 * every request cost. Usage:
 *
 *   SPIKE_URL=https://… CLERK_SECRET_KEY_FILE=… ADMIN_TOKEN_FILE=… node load/run.ts <scenario> <account> [weeks]
 *
 * With CLERK_SECRET_KEY_FILE (the Cloudflare Worker), each account is a test user of a Clerk
 * development instance, signed in with real session tokens, and the admin scenarios use the
 * operator token. With SPIKE_TOKEN_FILE instead (the self-hosted server), every request uses that
 * shared token and names its account.
 *
 * Scenarios: upload (a fresh phone with `weeks` of history syncs it all), download (a second, empty
 * phone downloads everything), log (phone A logs one workout and syncs; phone B then syncs),
 * live (phone B waits for a change that phone A makes), fanout <n> (n new accounts at once),
 * soak <n>x<m> (n new accounts, m at a time), hello (one hello, to time a cold start),
 * stats, export, bookmark, delete.
 */

const URL_BASE = process.env.SPIKE_URL ?? "";
if (!URL_BASE) throw new Error("set SPIKE_URL to the deployed Worker");
const secret = (variable: string) => {
  const file = process.env[variable];
  return file ? readFileSync(file, "utf8").trim() : "";
};
const SHARED_TOKEN = secret("SPIKE_TOKEN_FILE");
const CLERK_SECRET_KEY = secret("CLERK_SECRET_KEY_FILE");
const ADMIN_TOKEN = secret("ADMIN_TOKEN_FILE");
if (!SHARED_TOKEN && !CLERK_SECRET_KEY) {
  throw new Error("set CLERK_SECRET_KEY_FILE (and ADMIN_TOKEN_FILE), or SPIKE_TOKEN_FILE");
}
const clerk = CLERK_SECRET_KEY ? clerkTestUsers(CLERK_SECRET_KEY) : null;

/** The headers that sign a request in as `name`, or as the operator acting on it. */
async function credentials(name: string, admin: boolean): Promise<Record<string, string>> {
  if (!clerk) return { authorization: `Bearer ${SHARED_TOKEN}`, "x-leve-account": name };
  const user = await clerk.user(name);
  if (!admin) return { authorization: `Bearer ${await user.token()}` };
  if (!ADMIN_TOKEN) throw new Error("set ADMIN_TOKEN_FILE for the admin scenarios");
  return { authorization: `Bearer ${ADMIN_TOKEN}`, "x-leve-account": user.account };
}
const DIR = process.env.SPIKE_DIR ?? join(process.env.HOME ?? ".", ".cache", "leve-cf-spike");
const engine = createNodeSqliteEngine();

const [scenario = "", account = "", weeksArg = "52"] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(account))
  throw new Error("usage: run.ts <scenario> <account> [weeks]");

interface Sample {
  scenario: string;
  account: string;
  phone: string;
  path: string;
  status: number;
  clientMs: number;
  workerMs: number;
  warm: string;
  rowsRead: number;
  rowsWritten: number;
  upBytes: number;
  downBytes: number;
  colo: string;
}
const samples: Sample[] = [];
mkdirSync(join(DIR, "phones"), { recursive: true });
const logFile = join(DIR, "samples.ndjson");

function call(path: string, body: unknown, phone = "-", forAccount = account) {
  return async () => {
    const text = JSON.stringify(body);
    const headers = await credentials(forAccount, path.startsWith("/admin/"));
    const started = performance.now();
    const response = await fetch(new URL(path, URL_BASE), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: text,
    });
    const answer = await response.text();
    const h = (name: string) => response.headers.get(name) ?? "";
    const sample: Sample = {
      scenario,
      account: forAccount,
      phone,
      path,
      status: response.status,
      clientMs: Math.round(performance.now() - started),
      workerMs: Number(h("x-worker-ms") || h("x-server-ms")),
      warm: h("x-object-warm"),
      rowsRead: Number(h("x-rows-read")),
      rowsWritten: Number(h("x-rows-written")),
      upBytes: text.length,
      downBytes: answer.length,
      colo: h("x-colo"),
    };
    samples.push(sample);
    appendFileSync(logFile, `${JSON.stringify(sample)}\n`);
    return { status: response.status, answer, writtenRevisions: h(WRITTEN_REVISIONS_HEADER) };
  };
}

function transport(phone: string, forAccount = account): Transport {
  return async (path, body) => {
    try {
      const { status, answer, writtenRevisions } = await call(
        `/${path.replace(/^\/+/, "")}`,
        body,
        phone,
        forAccount,
      )();
      return {
        status,
        body: JSON.parse(answer),
        ...(writtenRevisions ? { writtenRevisions } : {}),
      };
    } catch (error) {
      throw new TransportError((error as Error).message);
    }
  };
}

async function phone(
  name: string,
  fresh: boolean,
  forAccount = account,
): Promise<{ store: DeviceStore; client: SyncClient }> {
  const path = join(DIR, "phones", `${forAccount}-${name}.db`);
  if (fresh)
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
  const store = await openDeviceStore({ engine, path, appVersion: "load-test" });
  const client = new SyncClient({
    store,
    transport: transport(name, forAccount),
    server: URL_BASE,
    account: forAccount,
    app: "load-test",
  });
  return { store, client };
}

function summarize(label: string, list: Sample[], wallMs: number) {
  const sum = (key: keyof Sample) => list.reduce((total, s) => total + Number(s[key]), 0);
  const sorted = list.map((s) => s.clientMs).sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  console.log(
    JSON.stringify({
      label,
      requests: list.length,
      wallSeconds: Math.round(wallMs / 100) / 10,
      p50ms: pick(0.5),
      p95ms: pick(0.95),
      maxMs: sorted[sorted.length - 1] ?? 0,
      rowsRead: sum("rowsRead"),
      rowsWritten: sum("rowsWritten"),
      upKB: Math.round(sum("upBytes") / 1024),
      downKB: Math.round(sum("downBytes") / 1024),
      errors: list.filter((s) => s.status >= 500).length,
      colo: list[0]?.colo,
    }),
  );
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const from = samples.length;
  const started = performance.now();
  const result = await fn();
  summarize(label, samples.slice(from), performance.now() - started);
  return result;
}

const admin = async (path: string, body: unknown = {}) => {
  const { status, answer } = await call(path, body)();
  return { status, answer };
};

switch (scenario) {
  case "upload": {
    const weeks = Number(weeksArg);
    const { store, client } = await phone("a", true);
    const records = history(account, weeks, Date.parse("2026-11-20T00:00:00Z"));
    const startedLocal = performance.now();
    for (let i = 0; i < records.length; i += 500) store.putMany(records.slice(i, i + 500));
    console.log(
      JSON.stringify({
        records: records.length,
        localWriteSeconds: Math.round(performance.now() - startedLocal) / 1000,
      }),
    );
    // One sync uploads at most 5,000 changes, so a long history takes several.
    const outcome = await timed(`upload ${weeks} weeks`, async () => {
      let last = await client.sync();
      for (
        let round = 0;
        round < 20 && last.state === "synced" && store.summary().pending > 0;
        round++
      ) {
        last = await client.sync();
      }
      return last;
    });
    console.log(JSON.stringify(outcome));
    console.log((await admin("/admin/stats")).answer);
    break;
  }
  case "download": {
    const { client, store } = await phone("b", true);
    const outcome = await timed("download everything", () => client.sync());
    console.log(JSON.stringify(outcome), JSON.stringify(store.summary()));
    break;
  }
  case "log": {
    const a = await phone("a", false);
    const records = workoutRecords(`${account}-new`, Date.now(), Date.now() - 3600_000);
    a.store.putMany(records);
    console.log(JSON.stringify(await timed("phone A uploads one workout", () => a.client.sync())));
    const b = await phone("b", false);
    console.log(JSON.stringify(await timed("phone B downloads it", () => b.client.sync())));
    break;
  }
  case "live": {
    const a = await phone("a", false);
    const b = await phone("b", false);
    await b.client.sync();
    const startedWait = performance.now();
    const waiting = b.client.waitForChanges(20_000).then((outcome) => ({
      outcome,
      seconds: Math.round(performance.now() - startedWait) / 1000,
    }));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    a.store.putMany(workoutRecords(`${account}-live`, Date.now(), Date.now() - 600_000));
    const pushedAt = performance.now();
    await a.client.sync();
    const result = await waiting;
    console.log(
      JSON.stringify({
        ...result,
        arrivedAfterPushMs: Math.round(performance.now() - pushedAt),
      }),
    );
    break;
  }
  case "fanout": {
    // Many accounts at once, each a new phone logging its first workout.
    const count = Number(weeksArg);
    const phones = await Promise.all(
      Array.from({ length: count }, (_, i) => phone("a", true, `${account}-${i}`)),
    );
    for (const [i, p] of phones.entries()) {
      p.store.putMany(workoutRecords(`${account}-${i}`, 1, Date.now() - 3600_000));
    }
    const outcomes = await timed(`${count} accounts sync at once`, () =>
      Promise.all(phones.map((p) => p.client.sync())),
    );
    const states: Record<string, number> = {};
    for (const { state } of outcomes) states[state] = (states[state] ?? 0) + 1;
    console.log(JSON.stringify(states));
    break;
  }
  case "soak": {
    // Many accounts, a fixed number syncing at any time: each a new phone logging one workout.
    const [count, parallel] = weeksArg.split("x").map(Number) as [number, number];
    if (!(count > 0 && parallel > 0)) throw new Error("usage: soak <account> <count>x<parallel>");
    // Timed end to end on the client, including creating each phone: compare server times instead.
    let next = 0;
    const states: Record<string, number> = {};
    await timed(`${count} accounts, ${parallel} at a time`, async () => {
      await Promise.all(
        Array.from({ length: parallel }, async () => {
          while (next < count) {
            const i = next++;
            const p = await phone("a", true, `${account}-${i}`);
            p.store.putMany(workoutRecords(`${account}-${i}`, 1, Date.now() - 3600_000));
            const { state } = await p.client.sync();
            states[state] = (states[state] ?? 0) + 1;
            p.store.close();
          }
        }),
      );
    });
    console.log(JSON.stringify(states));
    break;
  }
  case "hello":
    await timed("hello", () => call("/sync/hello", { releases: ["1.0"], app: "load-test" })());
    break;
  case "stats":
  case "export":
  case "bookmark":
  case "delete": {
    const { status, answer } = await admin(`/admin/${scenario}`);
    console.log(
      status,
      scenario === "export" ? `${answer.split("\n").length} lines, ${answer.length} bytes` : answer,
    );
    break;
  }
  case "restore": {
    console.log((await admin("/admin/restore", { bookmark: weeksArg })).answer);
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
