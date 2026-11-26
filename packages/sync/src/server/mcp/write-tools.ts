// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import {
  type JsonObject,
  MAX_DESCENDANTS,
  MAX_REVISION,
  type ReleaseId,
  type Submission,
} from "@leve/contract";
import { LIMITS } from "@leve/core";
import { type McpServer, requireScopes } from "@modelcontextprotocol/server";
import * as z from "zod";
import { allows, type Principal, SCOPES } from "../auth.ts";
import { LineageChangedError, type SyncService } from "../service.ts";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().min(1).max(MAX_REVISION);
const writableKinds = [
  "workout",
  "workout_exercise",
  "workout_set",
  "workout_rest",
  "routine",
  "routine_folder",
  "custom_exercise",
  "body_measurement",
] as const;
const noteKinds = ["workout_note", "exercise_note"] as const;
const commentKinds = ["workout_note_comment", "exercise_note_comment"] as const;
const recordKind = z.enum([...writableKinds, ...noteKinds, ...commentKinds, "settings"]);
const writeKind = z.enum(writableKinds);
const deleteKind = z.enum([
  "workout",
  "workout_exercise",
  "workout_set",
  "routine",
  "routine_folder",
  "body_measurement",
]);
const fields = z.record(z.string(), z.json());
const writeContext = {
  lineage: id.describe("The account history identifier from get_record"),
  requestId: id.describe(
    "A unique ID for this write. Reuse it with the same arguments when retrying.",
  ),
};
const newRecord = {
  ...writeContext,
  id: id.optional().describe("The new record ID. If omitted, the request ID determines it."),
};
const noteFields = {
  ...newRecord,
  text: z.string().min(1).max(LIMITS.noteLength),
  createdAt: z.iso.datetime({ precision: 3 }).describe("When written, in UTC with milliseconds."),
};

interface WriteContext {
  lineage: string;
  requestId: string;
}

const reply = (value: Record<string, unknown>, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
  ...(isError ? { isError } : {}),
});

function requestKey(clientId: string, requestId: string, purpose: "receipt" | "record") {
  return createHash("sha256")
    .update(JSON.stringify(["leve-mcp", purpose, clientId, requestId]))
    .digest("hex");
}

/** A stable UUIDv8 for a create whose caller omitted the record ID. */
function recordId(clientId: string, requestId: string) {
  const key = requestKey(clientId, requestId, "record");
  const variant = ((Number.parseInt(key.charAt(16), 16) & 3) | 8).toString(16);
  return [
    key.slice(0, 8),
    key.slice(8, 12),
    `8${key.slice(13, 16)}`,
    `${variant}${key.slice(17, 20)}`,
    key.slice(20, 32),
  ].join("-");
}

export function registerWriteTools(
  server: McpServer,
  service: SyncService,
  principal: Principal,
  release: ReleaseId,
): void {
  const { account, client } = principal;
  const agent = (client.name?.trim() || client.id)
    .slice(0, LIMITS.agentNameLength)
    .replace(/[\uD800-\uDBFF]$/, "");
  const scopeChallenge = requireScopes(SCOPES.write);
  const writeAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  };
  const createAnnotations = { ...writeAnnotations, destructiveHint: false };

  async function submit(
    submission: Submission,
    context: WriteContext,
    { patch = false, author }: { patch?: boolean; author?: string } = {},
  ) {
    // Also enforce the scope in the handler, independently of the transport's OAuth challenge.
    if (client.kind !== "agent" || !allows(principal, SCOPES.write)) {
      return reply({ status: "insufficient_scope", scope: SCOPES.write }, true);
    }
    const { kind, id } = submission;
    try {
      const [result] = await service.submit(account, release, [submission], {
        lineage: context.lineage,
        patch,
        agent: author === undefined ? {} : { name: author },
      });
      if (!result) throw new Error("Missing sync write result");
      if (result.status === "accepted")
        return reply({ status: result.status, kind, id, revision: result.revision });
      const current =
        result.status === "conflict"
          ? result.current
          : await service.read(account, kind, id, release);
      return reply({ ...result, kind, id, current }, true);
    } catch (error) {
      if (!(error instanceof LineageChangedError)) throw error;
      const { record, lineage } = await service.readRecordTree(account, kind, id, release, false);
      return reply({ status: "cursor_reset", kind, id, lineage, current: record }, true);
    }
  }

  const submissionId = ({ requestId }: WriteContext) => requestKey(client.id, requestId, "receipt");

  const create = (
    args: WriteContext & { id?: string },
    kind: string,
    content: JsonObject,
    author?: string,
  ) =>
    submit(
      {
        op: "put",
        submissionId: submissionId(args),
        id: args.id ?? recordId(client.id, args.requestId),
        kind,
        baseRevision: null,
        content,
      },
      args,
      author === undefined ? {} : { author },
    );

  server.registerTool(
    "get_record",
    {
      title: "Get a record",
      description:
        "Read a synced record, its revision, the account history identifier, and the live descendant revisions required for deletion. Set includeSchema to see the full sync content schema for its kind.",
      inputSchema: z.strictObject({
        kind: recordKind,
        id,
        includeSchema: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, id, includeSchema }) => {
      const snapshot = await service.readRecordTree(account, kind, id, release);
      return reply({
        ...snapshot,
        ...(includeSchema && service.contract.hasKind(kind, release)
          ? { contentSchema: service.contract.wireSchema(kind, release).description }
          : {}),
      });
    },
  );

  server.registerTool(
    "create_record",
    {
      title: "Create a record",
      description:
        "Create a record with complete sync content. See get_record with includeSchema for its fields. Use add_note or add_comment for notes. Reuse the request ID and arguments if retrying.",
      inputSchema: z.strictObject({ ...newRecord, kind: writeKind, content: fields }),
      annotations: createAnnotations,
      scopeChallenge,
    },
    async (args) => create(args, args.kind, args.content),
  );

  server.registerTool(
    "update_record",
    {
      title: "Update fields of a record",
      description:
        "Apply only the provided fields to the record from get_record. Arrays and nested values are replaced whole. If the revision is stale, inspect the current copy and decide how to proceed.",
      inputSchema: z.strictObject({
        ...writeContext,
        kind: writeKind,
        id,
        baseRevision: revision,
        fields: fields.refine(
          (value) => Object.keys(value).length > 0,
          "Provide at least one field.",
        ),
      }),
      annotations: writeAnnotations,
      scopeChallenge,
    },
    async (args) =>
      submit(
        {
          op: "put",
          submissionId: submissionId(args),
          kind: args.kind,
          id: args.id,
          baseRevision: args.baseRevision,
          content: args.fields,
        },
        args,
        { patch: true },
      ),
  );

  server.registerTool(
    "delete_record",
    {
      title: "Delete a record and its descendants",
      description:
        "Permanently delete a record. Pass its revision and every live descendant revision from get_record. If any has changed, review the current copy before retrying.",
      inputSchema: z.strictObject({
        ...writeContext,
        kind: deleteKind,
        id,
        baseRevision: revision,
        descendants: z
          .array(z.strictObject({ kind: recordKind, id, revision }))
          .max(MAX_DESCENDANTS),
      }),
      annotations: writeAnnotations,
      scopeChallenge,
    },
    async (args) =>
      submit(
        {
          op: "delete",
          submissionId: submissionId(args),
          kind: args.kind,
          id: args.id,
          baseRevision: args.baseRevision,
          descendants: args.descendants,
        },
        args,
      ),
  );

  server.registerTool(
    "add_note",
    {
      title: "Add an agent note",
      description:
        "Write a new note on a workout or exercise. Leve sets the agent name from the authenticated client.",
      inputSchema: z.strictObject({
        ...noteFields,
        target: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("workout_note"), workoutId: id }),
          z.strictObject({
            kind: z.literal("exercise_note"),
            exerciseId: z.string().min(1).max(100),
            workoutId: id.nullable().optional(),
            pinned: z.boolean().default(false),
          }),
        ]),
      }),
      annotations: createAnnotations,
      scopeChallenge,
    },
    async (args) => {
      const { text, createdAt, target } = args;
      const content =
        target.kind === "workout_note"
          ? { workoutId: target.workoutId, pinned: false }
          : {
              exerciseId: target.exerciseId,
              workoutId: target.workoutId ?? null,
              pinned: target.pinned,
            };
      return create(args, target.kind, { ...content, text, createdAt }, agent);
    },
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add an agent comment",
      description:
        "Reply to an existing workout or exercise note. Leve sets the agent name from the authenticated client.",
      inputSchema: z.strictObject({ ...noteFields, kind: z.enum(commentKinds), noteId: id }),
      annotations: createAnnotations,
      scopeChallenge,
    },
    async (args) =>
      create(
        args,
        args.kind,
        {
          noteId: args.noteId,
          text: args.text,
          createdAt: args.createdAt,
        },
        agent,
      ),
  );
}
