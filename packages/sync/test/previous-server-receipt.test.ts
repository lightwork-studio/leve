import { join } from "node:path";
import { ServerStorage, serverStorageDefinition } from "@leve/storage/server";
import { expect, it } from "vitest";
import {
  previewContract,
  previewContractThrough,
} from "../../contract/test/support/preview-contract.ts";
import { SyncService } from "../src/server/index.ts";
import { workout } from "./support/content.ts";
import { engine, World } from "./support/harness.ts";

it("replays a version-3 receipt with its original revision and write evidence after upgrading", async () => {
  const world = new World(previewContract);
  const server = world.server();
  const contract = previewContractThrough("1.2");
  const current = serverStorageDefinition({ contract });
  const old = new ServerStorage({
    engine,
    directory: server.directory,
    contract,
    definition: { ...current, version: 3, steps: current.steps.filter((step) => step.from < 3) },
    appVersion: "previous",
  });
  try {
    const service = new SyncService({
      storage: old,
      contract,
      releases: ["1.2"],
      now: world.clock.now,
    });
    const request = {
      release: "1.2",
      lineage: (await old.account("alice")).lineage(),
      submissions: [
        {
          submissionId: "save",
          op: "put",
          kind: "workout",
          id: "w",
          baseRevision: null,
          content: workout("Session", { initialPlan: null }),
        },
      ],
    };
    const original = await service.push("alice", request);
    expect(original).toMatchObject({
      status: 200,
      writtenRevisions: "1",
      body: { results: [{ status: "accepted", revision: 1 }] },
    });
    await old.close();
    expect(await server.service.push("alice", request)).toEqual(original);
    expect(await server.head("alice")).toBe(1);
  } finally {
    await old.close();
    await world.dispose();
  }
});

it.each(["numeric", "case-folding", "unique revision"])(
  "refuses %s submission keys before distinct requests can collide",
  async (damage) => {
    const world = new World();
    try {
      const server = world.server();
      const lineage = (await server.storage.account("alice")).lineage();
      const submit = (submissionId: string, record = submissionId) =>
        server.service.push("alice", {
          lineage,
          release: "1.0",
          submissions: [
            {
              submissionId,
              op: "put",
              kind: "workout",
              id: "w-" + record,
              baseRevision: null,
              content: workout(record, { initialPlan: null }),
            },
          ],
        });
      expect(await submit("seed")).toMatchObject({
        body: { results: [{ status: "accepted", revision: 1 }] },
      });
      const file = join(world.directory, "backup.db");
      await server.snapshot("alice", file);
      const staged = engine.open(file);
      try {
        if (damage !== "case-folding") {
          const submissionKey = damage === "numeric" ? "NUMERIC PRIMARY KEY" : "TEXT UNIQUE";
          const revisionKey = damage === "numeric" ? "INTEGER NOT NULL" : "INTEGER PRIMARY KEY";
          staged.exec(`CREATE TABLE replacement(submission_id ${submissionKey}, kind TEXT NOT NULL, id TEXT NOT NULL,
          revision ${revisionKey}, digest TEXT NOT NULL, accepted_at TEXT NOT NULL, wrote_revision INTEGER CHECK(wrote_revision=1));
          INSERT INTO replacement SELECT * FROM receipts; DROP TABLE receipts; ALTER TABLE replacement RENAME TO receipts;`);
        } else staged.exec("CREATE UNIQUE INDEX folded ON receipts(submission_id COLLATE NOCASE)");
      } finally {
        staged.close();
      }
      await expect(server.restoreWithCommand("alice", file)).rejects.toThrow(
        "invalid receipt submission ID constraint",
      );
      const ids = ["01", "1", "abc", "ABC"];
      for (const [i, id] of ids.entries()) {
        const response = await submit(id);
        expect(response).toMatchObject({
          status: 200,
          body: { results: [{ status: "accepted", revision: i + 2 }] },
        });
        expect(await submit(id)).toEqual(response);
      }
      expect(await submit("equivalent", "seed")).toMatchObject({
        writtenRevisions: "0",
        body: { results: [{ status: "accepted", revision: 1 }] },
      });
      expect(await server.head("alice")).toBe(5);
    } finally {
      await world.dispose();
    }
  },
);

it("replays case-distinct receipts after restoring a binary primary key on a NOCASE column", async () => {
  const world = new World();
  try {
    const server = world.server();
    const submit = async (submissionId: string) =>
      server.service.push("alice", {
        release: "1.0",
        lineage: (await server.storage.account("alice")).lineage(),
        submissions: [
          {
            op: "put",
            submissionId,
            kind: "workout",
            id: submissionId,
            baseRevision: null,
            content: workout(submissionId, { initialPlan: null }),
          },
        ],
      });
    const lower = await submit("abc");
    const upper = await submit("ABC");
    expect(lower).toMatchObject({ body: { results: [{ status: "accepted", revision: 1 }] } });
    expect(upper).toMatchObject({ body: { results: [{ status: "accepted", revision: 2 }] } });
    const file = join(world.directory, "case-distinct.db");
    await server.snapshot("alice", file);
    const backup = engine.open(file);
    try {
      backup.exec(`CREATE TABLE replacement(submission_id TEXT COLLATE NOCASE, kind TEXT NOT NULL, id TEXT NOT NULL,
        revision INTEGER NOT NULL, digest TEXT NOT NULL, accepted_at TEXT NOT NULL, wrote_revision INTEGER CHECK(wrote_revision=1),
        PRIMARY KEY(submission_id COLLATE BINARY));
        INSERT INTO replacement SELECT * FROM receipts; DROP TABLE receipts; ALTER TABLE replacement RENAME TO receipts;`);
    } finally {
      backup.close();
    }
    await server.restoreWithCommand("alice", file);
    expect(await submit("abc")).toEqual(lower);
    expect(await submit("ABC")).toEqual(upper);
    expect(await server.head("alice")).toBe(2);
  } finally {
    await world.dispose();
  }
});
