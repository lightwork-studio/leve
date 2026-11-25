import { writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_REQUEST_BYTES } from "@leve/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check } from "../../contract/history/1.0/peer.ts";
import { createSyncHttpHandler } from "../src/server/index.ts";
import { httpTransport, TransportError } from "../src/transport.ts";
import { archivedContract, Peer1, workout } from "./support/content.ts";
import { type ServerHarness, World } from "./support/harness.ts";

/* The HTTP boundary on a real node:http server on an ephemeral port. */

const frozen = archivedContract("1.0");
let world: World;
let server: ServerHarness;
let http: Server;
let base: string;
/** Unexpected failures the handler reported, with the request path. */
let reported: { error: unknown; url: string | undefined }[];
/** Makes the onError hook itself fail: by throwing, or with a rejected promise. */
let hookFails: "throws" | "rejects" | null;

beforeEach(async () => {
  world = new World();
  server = world.server();
  reported = [];
  hookFails = null;
  http = createServer(
    createSyncHttpHandler({
      service: server.service,
      authenticate: (request) => {
        const match = /^Bearer (\w+)$/.exec(request.headers.authorization ?? "");
        return match?.[1] ?? null;
      },
      onError: (error, request) => {
        reported.push({ error, url: request.url });
        if (hookFails === "throws") throw new Error("the error reporter is down");
        if (hookFails === "rejects") return Promise.reject(new Error("the report wasn't sent"));
        return undefined;
      },
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await world.dispose();
});

/** A raw request, so tests control method, headers and body bytes. */
function raw(
  path: string,
  options: {
    method?: string;
    body?: string | Buffer;
    auth?: string | null;
    contentType?: string;
    /** Sends the body without a content-length, in chunks. */
    chunked?: boolean;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const {
    method = "POST",
    body,
    auth = "Bearer alice",
    contentType = "application/json",
    chunked = false,
  } = options;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      {
        method,
        headers: {
          "content-type": contentType,
          ...(auth ? { authorization: auth } : {}),
          ...(body !== undefined && !chunked ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const errorEnvelope = (reply: { status: number; body: unknown }, status: number, code: string) => {
  expect(reply.status).toBe(status);
  expect(reply.body).toEqual({ error: { code, message: expect.any(String) } });
  expect(check(frozen.negotiation.errorResponse, reply.body)).toEqual([]);
};

it("distinguishes a written revision from an equivalent legacy create, including receipt replay", async () => {
  const send = httpTransport(base, { authorization: "Bearer alice" });
  const hello = await send("/sync/hello", { releases: ["1.0"], app: "test" });
  const { lineage } = hello.body as { lineage: string };
  const content = workout("Push", { initialPlan: null });
  const create = (submissionId: string) => ({
    submissionId,
    op: "put",
    kind: "workout",
    id: "shared",
    baseRevision: null,
    content,
  });
  const upload = { release: "1.0", lineage, submissions: [create("first"), create("equivalent")] };
  const expected = {
    release: "1.0",
    results: [
      { submissionId: "first", status: "accepted", revision: 1 },
      { submissionId: "equivalent", status: "accepted", revision: 1 },
    ],
  };
  expect(await send("/sync/push", upload)).toMatchObject({
    status: 200,
    body: expected,
    writtenRevisions: "10",
  });
  expect(
    await send("/sync/push", { ...upload, submissions: [...upload.submissions].reverse() }),
  ).toMatchObject({
    status: 200,
    writtenRevisions: "01",
    body: { results: [...expected.results].reverse() },
  });
});

describe("HTTP boundary", () => {
  it("answers unknown routes, other methods, missing auth and bad bodies with the error envelope", async () => {
    const hello = JSON.stringify({ releases: ["1.0"], app: "x" });
    errorEnvelope(await raw("/sync/nowhere", { body: hello }), 400, "invalid_request");
    errorEnvelope(await raw("/sync/hello", { method: "GET" }), 400, "invalid_request");
    errorEnvelope(await raw("/sync/hello", { method: "PUT", body: hello }), 400, "invalid_request");
    errorEnvelope(await raw("/sync/hello", { body: hello, auth: null }), 401, "unauthorized");
    errorEnvelope(await raw("/sync/hello", { body: hello, auth: "Basic x" }), 401, "unauthorized");
    // An account id the server cannot store under is refused like a bad sign-in.
    errorEnvelope(
      await raw("/sync/hello", { body: hello, auth: `Bearer ${"x".repeat(65)}` }),
      401,
      "unauthorized",
    );
    errorEnvelope(await raw("/sync/hello", { body: "{not json" }), 400, "invalid_request");
    errorEnvelope(await raw("/sync/hello", { body: "" }), 400, "invalid_request");
    const array = await raw("/sync/push", { body: "[]" });
    expect(array).toEqual({
      status: 400,
      body: {
        error: {
          code: "unsupported_release",
          message: expect.any(String),
          serverReleases: ["1.0"],
        },
      },
    });
    expect(check(frozen.negotiation.errorResponse, array.body)).toEqual([]);
    // A body may be up to MAX_REQUEST_BYTES; padding with whitespace keeps it valid JSON.
    const padded = (bytes: number) => hello + " ".repeat(bytes - Buffer.byteLength(hello));
    expect(await raw("/sync/hello", { body: padded(MAX_REQUEST_BYTES) })).toMatchObject({
      status: 200,
      body: { release: "1.0" },
    });
    errorEnvelope(
      await raw("/sync/hello", { body: padded(MAX_REQUEST_BYTES + 1) }),
      400,
      "invalid_request",
    );
    // Larger bodies get the same answer, never a reset connection, however they are sent.
    for (const bytes of [2 * MAX_REQUEST_BYTES, 8 * MAX_REQUEST_BYTES]) {
      errorEnvelope(await raw("/sync/hello", { body: padded(bytes) }), 400, "invalid_request");
      errorEnvelope(
        await raw("/sync/hello", { body: padded(bytes), chunked: true }),
        400,
        "invalid_request",
      );
    }
    // Only JSON is accepted, so a cross-site form can't post here.
    errorEnvelope(
      await raw("/sync/hello", { body: hello, contentType: "text/plain" }),
      400,
      "invalid_request",
    );
    expect(
      await raw("/sync/hello", { body: hello, contentType: "application/json; charset=utf-8" }),
    ).toMatchObject({ status: 200 });
    expect(await raw("/sync/hello?x=1", { body: hello })).toMatchObject({
      status: 200,
      body: { release: "1.0" },
    });
    expect(await server.rows("alice")).toEqual([]);
    // Refused requests are answers, not failures.
    expect(reported).toEqual([]);
  });

  it("answers update_required and service failures in the frozen envelope", async () => {
    const tooNew = await raw("/sync/hello", {
      body: JSON.stringify({ releases: ["9.0"], app: "x" }),
    });
    expect(tooNew).toEqual({
      status: 426,
      body: {
        error: {
          code: "update_required",
          message: expect.any(String),
          update: "server",
          serverReleases: ["1.0"],
        },
      },
    });
    expect(check(frozen.negotiation.errorResponse, tooNew.body)).toEqual([]);

    writeFileSync(server.dbPath("broken"), "not a database");
    const failing = await raw("/sync/hello", {
      body: JSON.stringify({ releases: ["1.0"], app: "x" }),
      auth: "Bearer broken",
    });
    errorEnvelope(failing, 503, "unavailable");
    expect(JSON.stringify(failing.body)).not.toMatch(/database|sqlite|SQL/i);
    // The operator is told what went wrong; the client is not.
    expect(reported).toHaveLength(1);
    expect(reported[0]?.url).toBe("/sync/hello");
    expect(reported[0]?.error).toBeInstanceOf(Error);
    expect(String((reported[0]?.error as Error | undefined)?.message)).toMatch(/database|file/i);

    // A failing hook, whether it throws or rejects, doesn't keep the client from its answer.
    for (const failure of ["throws", "rejects"] as const) {
      hookFails = failure;
      const again = await raw("/sync/hello", {
        body: JSON.stringify({ releases: ["1.0"], app: "x" }),
        auth: "Bearer broken",
      });
      errorEnvelope(again, 503, "unavailable");
    }
    expect(reported).toHaveLength(3);
  });

  it("runs a full sync between a phone and an old peer over HTTP", async () => {
    const phone = await world.phone("phone", {
      account: "alice",
      server: base,
      transport: httpTransport(base, { authorization: "Bearer alice" }),
      pageSize: 1,
    });
    const peer = new Peer1(httpTransport(base, { authorization: "Bearer alice" }));
    await peer.hello();
    await peer.push([peer.put("workout", "w-peer", workout("From the peer"))]);
    phone.store.put("workout", "w-phone", workout("From the phone"));
    expect(await phone.sync()).toEqual({ state: "synced", pushed: 1, pulled: 2 });
    phone.store.put("workout", "w-peer", workout("Edited on the phone"));
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect((await peer.pull()).map((c) => [c.id, (c.content as { title: string }).title])).toEqual([
      ["w-phone", "From the phone"],
      ["w-peer", "Edited on the phone"],
    ]);

    // Another account sees nothing of it.
    const other = new Peer1(httpTransport(base, { authorization: "Bearer bob" }), "bob");
    expect(await other.hello()).toMatchObject({ revision: 0 });
    expect(await other.pull()).toEqual([]);

    // A stopped server is reported as offline and nothing is lost.
    await new Promise<void>((resolve) => http.close(() => resolve()));
    http = createServer();
    phone.store.put("workout", "w-phone", workout("Offline edit"));
    expect(await phone.sync()).toMatchObject({ state: "offline" });
    expect(phone.store.get("workout", "w-phone")).toMatchObject({ status: "pending" });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  });

  it("asks for a fresh token per request, and stops with signed_out when it is refused", async () => {
    let token: string | null = "alice";
    let asked = 0;
    const phone = await world.phone("phone", {
      account: "alice",
      server: base,
      transport: httpTransport(base, async (): Promise<Record<string, string>> => {
        asked += 1;
        return token ? { authorization: `Bearer ${token}` } : {};
      }),
    });
    phone.store.put("workout", "w1", workout("Kept"));
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(asked).toBeGreaterThanOrEqual(3); // hello, push and pull each asked.

    token = null;
    phone.store.put("workout", "w1", workout("Edited while signed out"));
    const before = phone.store.syncState();
    expect(await phone.sync()).toEqual({ state: "signed_out" });
    expect(phone.store.syncState()).toEqual(before);
    expect(phone.store.get("workout", "w1")).toMatchObject({ status: "pending" });

    token = "alice";
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
  });

  it("treats a token that can't be had as offline, and nothing is sent", async () => {
    const phone = await world.phone("phone", {
      account: "alice",
      server: base,
      transport: httpTransport(base, () => Promise.reject(new Error("no connection"))),
    });
    phone.store.put("workout", "w1", workout("Kept"));
    expect(await phone.sync()).toMatchObject({ state: "offline" });
    expect(phone.store.syncState().account).toBe("alice");
    expect(await server.row("alice", "workout", "w1")).toBeFalsy();
  });

  it("probes an account without connecting the device to it", async () => {
    const peer = new Peer1(httpTransport(base, { authorization: "Bearer alice" }));
    const phone = await world.phone("phone", {
      account: "alice",
      server: base,
      transport: httpTransport(base, { authorization: "Bearer alice" }),
    });
    phone.store.put("workout", "w-phone", workout("On the phone"));
    expect(await phone.client.probe()).toEqual({ state: "ready", revision: 0 });

    await peer.hello();
    await peer.push([peer.put("workout", "w-peer", workout("Elsewhere"))]);
    const before = phone.store.syncState();
    expect(await phone.client.probe()).toEqual({ state: "ready", revision: 1 });
    expect(phone.store.syncState()).toEqual(before);
    expect(before).toMatchObject({ account: null, server: null, lineage: null });

    const stranger = await world.phone("stranger", {
      account: "alice",
      server: base,
      transport: httpTransport(base, { authorization: "Bearer" }),
    });
    expect(await stranger.client.probe()).toEqual({ state: "signed_out" });
  });
});

describe("HTTP transport", () => {
  it("keeps the base URL's path and gives up on a stuck connection", async () => {
    const seen: string[] = [];
    const stub = createServer((request, response) => {
      seen.push(request.url ?? "");
      if (request.url?.endsWith("/stuck")) return; // Never answers.
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const root = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    try {
      await httpTransport(`${root}/leve`)("/sync/hello", {});
      await httpTransport(`${root}/leve/`)("/sync/hello", {});
      expect(seen).toEqual(["/leve/sync/hello", "/leve/sync/hello"]);
      await expect(httpTransport(root, {}, 200)("/stuck", {})).rejects.toThrow(TransportError);
      // Given up by the caller long before its timeout, and the connection closes.
      const abort = new AbortController();
      const waiting = httpTransport(root)("/stuck", {}, { signal: abort.signal });
      setTimeout(() => abort.abort(), 20);
      await expect(waiting).rejects.toThrow("request given up");
      await expect(httpTransport(root)("/stuck", {}, { signal: abort.signal })).rejects.toThrow(
        "request given up",
      );
    } finally {
      stub.closeAllConnections();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});
