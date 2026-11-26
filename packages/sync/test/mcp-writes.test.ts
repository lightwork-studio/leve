// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { MAX_DESCENDANTS } from "@leve/contract";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { type Principal, SCOPES } from "../src/server/index.ts";
import { createMcpEndpoint } from "../src/server/mcp/index.ts";
import { World } from "./support/harness.ts";

const url = new URL("https://leve.test/mcp");
const metadata = "https://leve.test/.well-known/oauth-protected-resource/mcp";
const createdAt = "2026-11-12T12:00:00.000Z";

const agent = (account: string, scopes: string[] = [SCOPES.write]): Principal => ({
  account,
  client: { kind: "agent", id: "oauth-coach", name: "Coach" },
  scopes,
});

const workout = (title: string) => ({
  title,
  startedAt: createdAt,
  endedAt: null,
  routineId: null,
  initialPlan: null,
});

const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
});

async function setup() {
  const world = new World();
  worlds.push(world);
  const server = world.server();
  async function phone(name: string, account: string) {
    const phone = await world.phone(name, {
      server: url.origin,
      account,
      transport: server.transport(account),
    });
    return phone;
  }

  const alice = await phone("alice-phone", "alice");
  const other = await phone("alice-other-phone", "alice");
  const bob = await phone("bob-phone", "bob");
  alice.store.put("workout", "workout-a", workout("Push"));
  bob.store.put("workout", "workout-b", workout("Private pull"));
  expect((await alice.sync()).state).toBe("synced");
  expect((await other.sync()).state).toBe("synced");
  expect((await bob.sync()).state).toBe("synced");
  const endpoint = createMcpEndpoint({
    service: server.service,
    version: "test",
    writesEnabled: true,
    resourceMetadataUrl: metadata,
  });
  const connect = async (principal = agent("alice")) => {
    // The MCP initialization name and the authenticated OAuth identity are intentionally different.
    const client = new Client({ name: "Claimed UI name", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        fetch: (input, init) => endpoint(new Request(input, init), principal),
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return result.structuredContent as Record<string, unknown> | undefined;
    };
    const get = async (kind = "workout", id = "workout-a") => {
      return (await call("get_record", { kind, id })) as {
        lineage: string;
        record: { revision: number; content: Record<string, unknown> } | null;
        descendants: { kind: string; id: string; revision: number }[];
      };
    };
    return { call, get };
  };
  return { server, alice, other, bob, endpoint, connect };
}

describe("MCP writes through phone sync", () => {
  it("creates a record the phone can download and validates the supplied content", async () => {
    const { alice, server, connect } = await setup();
    const { get, call } = await connect();
    const initial = await get();
    const args = {
      requestId: "create",
      lineage: initial.lineage,
      kind: "workout",
      content: workout("New workout"),
    };
    expect(
      await call("create_record", { ...args, content: { ...args.content, extra: true } }),
    ).toMatchObject({ status: "invalid", code: "invalid_content", current: null });
    const created = await call("create_record", args);
    expect(created).toMatchObject({ status: "accepted", kind: "workout", revision: 2 });
    expect(await call("create_record", args)).toEqual(created);
    expect(await server.head("alice")).toBe(2);
    await alice.sync();
    expect(alice.store.get("workout", String(created?.id))?.content).toEqual(
      workout("New workout"),
    );
  });

  it("applies one field, replays its receipt and leaves a concurrent phone edit for review", async () => {
    const { server, alice, other, connect } = await setup();
    const { call, get } = await connect();
    const initial = await get();
    other.store.put("workout", "workout-a", workout("Phone title"));
    const args = {
      requestId: "edit-1",
      lineage: initial.lineage,
      kind: "workout",
      id: "workout-a",
      baseRevision: initial.record?.revision,
      fields: { title: "Agent title" },
    };
    const written = await call("update_record", args);
    expect(written).toMatchObject({ status: "accepted", revision: 2 });
    expect((await get()).record?.content).toMatchObject({ ...workout("Agent title") });
    expect((await alice.sync()).state).toBe("synced");
    expect(alice.store.get("workout", "workout-a")?.content).toMatchObject({
      title: "Agent title",
    });

    expect(await call("update_record", args)).toEqual(written);
    expect(
      await call("update_record", { ...args, fields: { title: "Changed retry" } }),
    ).toMatchObject({
      status: "invalid",
      code: "submission_reused",
      current: { content: { title: "Agent title" } },
    });
    expect(
      await call("update_record", { ...args, requestId: "edit-2", fields: { endedAt: createdAt } }),
    ).toMatchObject({
      status: "conflict",
      reason: "stale",
      current: { content: { title: "Agent title", endedAt: null } },
    });

    await other.sync();
    expect(other.store.get("workout", "workout-a")?.content).toMatchObject({
      title: "Phone title",
    });
    expect((await server.row("alice", "workout", "workout-a"))?.content).toMatchObject({
      title: "Agent title",
    });
    expect(await server.head("alice")).toBe(2);
    server.clock.advanceDays(91);
    expect(await call("update_record", args)).toEqual(written);
    expect(await server.head("alice")).toBe(2);
  });

  it("uses the authenticated agent name and creates notes and comments idempotently", async () => {
    const { server, alice, connect } = await setup();
    const { call, get } = await connect();
    const initial = await get();
    const args = {
      requestId: "note-1",
      lineage: initial.lineage,
      text: "Slow down the eccentric",
      createdAt,
      target: { kind: "workout_note", workoutId: "workout-a" },
    };
    const note = await call("add_note", args);
    expect(note).toMatchObject({ status: "accepted", kind: "workout_note", revision: 2 });
    expect(await call("add_note", args)).toEqual(note);
    const comment = {
      requestId: "comment-1",
      lineage: initial.lineage,
      kind: "workout_note_comment",
      noteId: note?.id,
      text: "One more detail",
      createdAt,
    };
    expect(await call("add_comment", { ...comment, agent: "Lifter" })).toBeUndefined();
    const written = await call("add_comment", comment);
    expect(written).toMatchObject({ status: "accepted", revision: 3 });
    expect(await call("add_comment", comment)).toEqual(written);
    const renamed = await connect({
      ...agent("alice"),
      client: { kind: "agent", id: "oauth-coach", name: "Renamed Coach" },
    });
    expect(await renamed.call("add_note", args)).toEqual(note);
    expect(await renamed.call("add_comment", comment)).toEqual(written);
    await alice.sync();
    expect(alice.store.get("workout_note", String(note?.id))?.content).toMatchObject({
      agent: "Coach",
      text: args.text,
    });
    expect((await get("workout_note_comment", String(written?.id))).record?.content).toMatchObject({
      agent: "Coach",
      text: comment.text,
    });
    expect(await server.head("alice")).toBe(3);
  });

  it("keeps an authenticated author label within the contract's text limit", async () => {
    const { connect } = await setup();
    const { call, get } = await connect({
      ...agent("alice"),
      client: { kind: "agent", id: "oauth-coach", name: "🏋".repeat(40) },
    });
    const { lineage } = await get();
    const note = await call("add_note", {
      lineage,
      requestId: "long-label",
      createdAt,
      text: "A note",
      target: { kind: "workout_note", workoutId: "workout-a" },
    });
    expect(note).toMatchObject({ status: "accepted" });
    expect((await get("workout_note", String(note?.id))).record?.content.agent).toBe(
      "🏋".repeat(30),
    );
  });

  it("preserves built-in exercise IDs and the measurement type of a custom exercise", async () => {
    const { connect } = await setup();
    const { call, get } = await connect();
    const { lineage } = await get();
    const args = {
      requestId: "custom",
      lineage,
      kind: "custom_exercise",
      content: {
        name: "My Press",
        type: "weight_reps",
        primaryMuscle: "chest",
        secondaryMuscles: [],
        equipment: "barbell",
        usesBodyweight: false,
        archived: false,
      },
    };
    expect(
      await call("create_record", { ...args, id: "builtin:barbell-bench-press" }),
    ).toMatchObject({ status: "invalid", code: "invalid_content", current: null });
    const created = await call("create_record", { ...args, id: "my-press" });
    expect(created).toMatchObject({ status: "accepted" });
    expect(
      await call("update_record", {
        requestId: "change-type",
        lineage,
        kind: args.kind,
        id: "my-press",
        baseRevision: created?.revision,
        fields: { type: "duration" },
      }),
    ).toMatchObject({
      status: "invalid",
      code: "invalid_content",
      current: { content: { type: "weight_reps" } },
    });
  });

  it("denies cross-account edits, reads and deletes, even with the other record's revision", async () => {
    const { server, connect } = await setup();
    const bob = await connect(agent("bob"));
    const remote = await bob.get("workout", "workout-b");
    const { call, get } = await connect();
    const local = await get();
    expect((await get("workout", "workout-b")).record).toBeNull();
    const args = {
      requestId: "other",
      lineage: local.lineage,
      kind: "workout",
      id: "workout-b",
      baseRevision: remote.record?.revision,
    };
    expect(await call("update_record", { ...args, fields: { title: "Changed" } })).toMatchObject({
      status: "conflict",
      current: null,
    });
    expect(await call("delete_record", { ...args, descendants: [] })).toMatchObject({
      status: "conflict",
      current: null,
    });
    expect(await server.row("alice", "workout", "workout-b")).toBeUndefined();
    expect((await bob.get("workout", "workout-b")).record).toEqual(remote.record);
    expect(await server.head("alice")).toBe(1);
    expect(await server.head("bob")).toBe(1);
  });

  it("requires descendant revisions and rejects a request from before an account restore", async () => {
    const { server, connect } = await setup();
    const { call, get } = await connect();
    const initial = await get();
    const note = await call("add_note", {
      requestId: "new-child",
      lineage: initial.lineage,
      text: "A new child",
      createdAt,
      target: { kind: "workout_note", workoutId: "workout-a" },
    });
    expect(note?.status).toBe("accepted");
    const deletion = {
      requestId: "delete-1",
      lineage: initial.lineage,
      kind: "workout",
      id: "workout-a",
      baseRevision: initial.record?.revision,
      descendants: initial.descendants,
    };
    expect(await call("delete_record", deletion)).toMatchObject({
      status: "conflict",
      reason: "stale",
    });
    const complete = await get();
    expect(complete.descendants).toMatchObject([{ id: note?.id, revision: note?.revision }]);
    const store = await server.storage.account("alice");
    store.transaction((tx) => tx.setLineage("restored-lineage"));
    expect(
      await call("delete_record", { ...deletion, descendants: complete.descendants }),
    ).toMatchObject({
      status: "cursor_reset",
      lineage: "restored-lineage",
      current: { revision: initial.record?.revision },
    });
    expect(
      await call("delete_record", {
        ...deletion,
        lineage: "restored-lineage",
        descendants: complete.descendants,
      }),
    ).toMatchObject({ status: "accepted" });
    expect((await get()).record).toMatchObject({ state: "deleted" });
  });

  it("returns an OAuth scope challenge to read-only clients before any write executes", async () => {
    const { endpoint, server } = await setup();
    const lineage = (await server.storage.account("alice")).lineage();
    const request = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_record",
          arguments: {
            requestId: "scope",
            lineage,
            kind: "workout",
            id: "blocked",
            content: workout("Blocked"),
          },
        },
      }),
    });
    const response = await endpoint(request, agent("alice", [SCOPES.read]));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="leve:write"');
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${metadata}"`);
    expect(await server.row("alice", "workout", "blocked")).toBeUndefined();
  });

  it("returns bounded descendant revisions and refuses deletion of a larger tree", async () => {
    const { server, connect } = await setup();
    const { get, call } = await connect();
    const store = await server.storage.account("alice");
    store.transaction((tx) => {
      for (let n = 0; n < 20; n++) {
        const noteId = `note-${n}`;
        tx.writeLive("workout_note", noteId, {
          workoutId: "workout-a",
          pinned: false,
          text: "Note",
          createdAt,
          agent: null,
        });
        for (let c = 0; c < 99; c++) {
          tx.writeLive("workout_note_comment", `${noteId}-comment-${c}`, {
            noteId,
            text: "Comment",
            createdAt,
            agent: null,
          });
        }
      }
    });
    const full = await get();
    expect(full.descendants).toHaveLength(MAX_DESCENDANTS);
    expect(full).toMatchObject({ descendantsTruncated: false });
    store.transaction((tx) =>
      tx.writeLive("workout_note_comment", "extra-comment", {
        noteId: "note-0",
        text: "Comment",
        createdAt,
        agent: null,
      }),
    );
    const overflow = await get();
    expect(overflow.descendants).toHaveLength(MAX_DESCENDANTS);
    expect(overflow).toMatchObject({ descendantsTruncated: true });
    expect(
      await call("delete_record", {
        requestId: "too-big",
        lineage: overflow.lineage,
        kind: "workout",
        id: "workout-a",
        baseRevision: overflow.record?.revision,
        descendants: overflow.descendants,
      }),
    ).toMatchObject({ status: "conflict", reason: "stale", current: { state: "live" } });
  });

  it("keeps writes disabled even for a write-scoped client while reads work", async () => {
    const { server } = await setup();
    const endpoint = createMcpEndpoint({ service: server.service, version: "test" });
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        fetch: (input, init) => endpoint(new Request(input, init), agent("alice")),
      }),
    );
    expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain("create_record");
    const lineage = (await server.storage.account("alice")).lineage();
    await expect(
      client.callTool({
        name: "create_record",
        arguments: {
          requestId: "disabled",
          lineage,
          kind: "workout",
          id: "blocked",
          content: workout("Blocked"),
        },
      }),
    ).rejects.toThrow("Tool create_record not found");
    expect(
      (await client.callTool({ name: "get_workout", arguments: { id: "workout-a" } }))
        .structuredContent,
    ).toMatchObject({ workout: { title: "Push" } });
    expect(await server.row("alice", "workout", "blocked")).toBeUndefined();
  });
});
