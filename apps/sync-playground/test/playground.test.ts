import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type Playground, shownUrl, startPlayground } from "../src/playground.ts";

/* Drives the playground through its control API, the way the page does. */

let playground: Playground;
let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "leve-playground-"));
  playground = await startPlayground({ directory });
});
afterEach(async () => {
  await playground.close();
  rmSync(directory, { recursive: true, force: true });
});

async function post(path: string, body: unknown = {}) {
  const response = await fetch(`${playground.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = (await response.json()) as { result?: unknown; error?: string };
  if (reply.error) throw new Error(reply.error);
  return reply.result as Record<string, unknown> | null;
}

// biome-ignore lint/suspicious/noExplicitAny: the state is plain JSON read by the page.
const state = async (): Promise<any> => (await fetch(`${playground.url}/dev/state`)).json();
const workout = (title: string) => ({
  title,
  startedAt: "2026-11-12T08:00:00.000Z",
  endedAt: null,
  routineId: null,
});

it("serves the page", async () => {
  const page = await (await fetch(playground.url)).text();
  expect(page).toContain("<title>Sync Playground</title>");
});

it("runs a conflict, an assistant write and a restore between the two phones", async () => {
  await post("/dev/devices/phone-a/put", { kind: "workout", id: "w1", content: workout("Push") });
  expect(await post("/dev/devices/phone-a/sync")).toMatchObject({ state: "synced", pushed: 1 });
  await post("/dev/devices/phone-b/sync");
  await post("/dev/backup");

  // Both phones rename the workout; the second upload is kept for review.
  await post("/dev/devices/phone-a/put", { kind: "workout", id: "w1", content: workout("A") });
  await post("/dev/devices/phone-b/put", { kind: "workout", id: "w1", content: workout("B") });
  await post("/dev/devices/phone-a/sync");
  await post("/dev/devices/phone-b/sync");
  let current = await state();
  const b = current.devices.find((d: { name: string }) => d.name === "phone-b");
  expect(b.problems).toMatchObject([
    { id: "w1", status: "conflict", content: { title: "B" }, server: { content: { title: "A" } } },
  ]);
  await post("/dev/devices/phone-b/resolve", { kind: "workout", id: "w1", choice: "keep_mine" });
  await post("/dev/devices/phone-b/sync");

  // The assistant writes against the revision it read; an older one is rejected.
  expect(
    await post("/dev/assistant", {
      kind: "workout",
      id: "w1",
      baseRevision: 2,
      content: workout("Stale"),
    }),
  ).toMatchObject({ status: "conflict", reason: "stale", current: { revision: 3 } });
  expect(
    await post("/dev/assistant", {
      kind: "workout",
      id: "w1",
      baseRevision: 3,
      content: workout("Assistant"),
    }),
  ).toMatchObject({ status: "accepted", revision: 4 });

  // An edit made offline stays on the phone until it is online again.
  await post("/dev/devices/phone-a/online", { online: false });
  await post("/dev/devices/phone-a/put", { kind: "workout", id: "w9", content: workout("Off") });
  expect(await post("/dev/devices/phone-a/sync")).toMatchObject({ state: "offline" });
  expect((await state()).devices[0]).toMatchObject({ unsynced: true });
  await post("/dev/devices/phone-a/online", { online: true });
  await post("/dev/devices/phone-a/delete", { kind: "workout", id: "w9" });

  // A restore of the backup: what the server lost is offered again and reviewed.
  await post("/dev/restore", { how: "command" });
  await post("/dev/devices/phone-a/sync");
  current = await state();
  expect(current.server.restoredFrom).toMatchObject({ restorePoint: 1 });
  const a = current.devices.find((d: { name: string }) => d.name === "phone-a");
  expect(a.problems).toMatchObject([
    { id: "w1", fromRestore: true, content: { title: "A" }, server: { revision: 1 } },
  ]);
  expect(await post("/dev/devices/phone-a/resolve-restored")).toEqual({ resolved: 1 });
  current = await state();
  expect(current.devices[0].records).toMatchObject([{ id: "w1", content: { title: "Push" } }]);
});

it("restores by copying the files back, and resets", async () => {
  await post("/dev/devices/phone-a/put", { kind: "workout", id: "w1", content: workout("One") });
  await post("/dev/devices/phone-a/sync");
  await post("/dev/backup");
  await post("/dev/devices/phone-a/put", { kind: "workout", id: "w2", content: workout("Two") });
  await post("/dev/devices/phone-a/sync");
  await post("/dev/restore", { how: "copy" });
  expect((await state()).server.revision).toBe(1);
  // The phone is ahead of the copied file; it notices, resets and offers w2 again.
  await post("/dev/devices/phone-a/sync");
  await post("/dev/devices/phone-a/sync");
  const current = await state();
  expect(current.server.records.map((r: { id: string }) => r.id).sort()).toEqual(["w1", "w2"]);
  expect(current.devices[0].problems).toEqual([]);

  await post("/dev/reset");
  const fresh = await state();
  expect(fresh.server.records).toEqual([]);
  expect(fresh.devices[0].records).toEqual([]);
});

it("lets the assistant delete a workout only with the descendants it saw", async () => {
  await post("/dev/devices/phone-a/put", { kind: "workout", id: "w1", content: workout("Legs") });
  await post("/dev/devices/phone-a/put", {
    kind: "workout_exercise",
    id: "e1",
    content: {
      workoutId: "w1",
      exerciseId: "squat",
      exerciseName: "Squat",
      exerciseType: "weight_reps",
      position: 1,
      supersetId: null,
      restSeconds: 120,
      doubleDumbbellVolume: false,
    },
  });
  await post("/dev/devices/phone-a/sync");
  const missing = { kind: "workout", id: "w1", baseRevision: 1, content: null, descendants: [] };
  expect(await post("/dev/assistant", missing)).toMatchObject({ status: "conflict" });
  expect(
    await post("/dev/assistant", {
      ...missing,
      descendants: [{ kind: "workout_exercise", id: "e1", revision: 2 }],
    }),
  ).toMatchObject({ status: "accepted" });
  await post("/dev/devices/phone-a/sync");
  expect((await state()).devices[0].records).toEqual([]);
});

it("resets only its own data in the directory", async () => {
  writeFileSync(join(directory, "notes.txt"), "keep me");
  await post("/dev/backup");
  await post("/dev/reset");
  expect(existsSync(join(directory, "notes.txt"))).toBe(true);
  expect(existsSync(join(directory, "backup.db"))).toBe(false);
});

it("answers unknown actions and bad input with an error", async () => {
  await expect(post("/dev/devices/phone-z/sync")).rejects.toThrow(/no device/);
  await expect(post("/dev/nothing")).rejects.toThrow(/unknown/);
  await expect(post("/dev/devices/phone-a/put", { kind: "workout", content: {} })).rejects.toThrow(
    /workout/,
  );
  // An id the server would refuse never reaches the phone's upload queue.
  await expect(
    post("/dev/devices/phone-a/put", { kind: "workout", id: '"><img>', content: workout("X") }),
  ).rejects.toThrow(/invalid id/);
  // Names inherited by plain objects aren't actions, and account actions aren't device actions.
  await expect(post("/dev/constructor")).rejects.toThrow(/unknown/);
  await expect(post("/dev/devices/phone-a/backup")).rejects.toThrow(/unknown/);
  // Only JSON is accepted, so another web page can't post here unasked.
  const form = await fetch(`${playground.url}/dev/reset`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  expect(form.status).toBe(415);
  expect((await state()).devices[0].records).toEqual([]);
});

it("syncs the phones over their own loopback listener, apart from the page's address", async () => {
  await post("/dev/devices/phone-a/put", { kind: "workout", id: "w1", content: workout("Push") });
  await post("/dev/devices/phone-a/sync");
  const server: string = (await state()).devices[0].sync.server;
  expect(server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(server).not.toBe(playground.url);
  await playground.close();
  // Closing releases the phones' listener as well as the page's.
  await expect(fetch(`${server}/`)).rejects.toThrow();
});

it("fails to start on a busy port instead of waiting", async () => {
  const port = Number(new URL(playground.url).port);
  const other = mkdtempSync(join(tmpdir(), "leve-playground-"));
  try {
    await expect(startPlayground({ directory: other, port })).rejects.toThrow(/EADDRINUSE/);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

it("keeps the phones on loopback when the page listens on another address", async () => {
  const other = mkdtempSync(join(tmpdir(), "leve-playground-"));
  const v6 = await startPlayground({ directory: other, host: "::1" });
  try {
    expect(v6.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    const send = (path: string) =>
      fetch(`${v6.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "workout", id: "w1", content: workout("Push") }),
      });
    await send("/dev/devices/phone-a/put");
    const synced = (await (await send("/dev/devices/phone-a/sync")).json()) as { result: unknown };
    expect(synced.result).toMatchObject({ state: "synced" });
    const current = (await (await fetch(`${v6.url}/dev/state`)).json()) as {
      devices: { sync: { server: string } }[];
    };
    expect(current.devices[0]?.sync.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await v6.close();
    rmSync(other, { recursive: true, force: true });
  }
});

it("shows wildcard addresses as loopback", () => {
  expect(shownUrl("0.0.0.0", 41787)).toBe("http://127.0.0.1:41787");
  expect(shownUrl("::", 41787)).toBe("http://[::1]:41787");
  expect(shownUrl("::1", 41787)).toBe("http://[::1]:41787");
  expect(shownUrl("100.64.0.1", 41787)).toBe("http://100.64.0.1:41787");
});
