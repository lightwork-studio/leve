// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { MAX_REQUEST_BYTES, type ReleaseId } from "@leve/contract";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { allows, type Principal, SCOPES } from "../auth.ts";
import type { SyncService } from "../service.ts";
import { AccountView } from "./account-view.ts";
import { registerReadTools } from "./read-tools.ts";
import { registerWriteTools } from "./write-tools.ts";

export interface McpEndpointOptions {
  /** The account-scoped service the tools read through, the same one phones sync with. */
  service: SyncService;
  /** The server's version, shown to clients. */
  version: string;
  /** The release records are read in; the server's newest by default. */
  release?: ReleaseId;
  /** Whether this host offers write tools to MCP clients. Defaults to false. */
  writesEnabled?: boolean;
  /** Verified OAuth resource metadata URL for per-tool scope challenges. */
  resourceMetadataUrl?: string;
}

/** Answered by the endpoint itself when a principal without read access gets this far. */
const forbidden = () =>
  new Response(JSON.stringify({ error: "insufficient_scope" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

/**
 * Leve's MCP endpoint: Streamable HTTP, stateless, answering JSON. The host signs the client in
 * and passes the principal; every tool reads only that principal's account. A fresh server is
 * built for each request, so nothing of one request (or one account) can reach another.
 */
export function createMcpEndpoint(options: McpEndpointOptions) {
  const release = options.release ?? (options.service.releases.at(-1) as ReleaseId);
  return async (request: Request, principal: Principal): Promise<Response> => {
    if (!allows(principal, SCOPES.read)) return forbidden();
    const account = principal.account;
    const handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: "leve", title: "Leve", version: options.version },
          {
            instructions:
              "Leve is the lifter's workout log. Read workouts, exercise history, progress, " +
              "routines, notes and body measurements. Records come with their id and revision.",
          },
        );
        registerReadTools(server, (kinds, workouts) =>
          AccountView.load(options.service, account, release, kinds, workouts),
        );
        if (options.writesEnabled) registerWriteTools(server, options.service, principal, release);
        return server;
      },
      { maxRequestBodySize: MAX_REQUEST_BYTES },
    );
    try {
      return await handler.fetch(request, {
        authInfo: {
          token: "",
          clientId: principal.client.id,
          scopes: [...(principal.scopes ?? [])],
          ...(options.resourceMetadataUrl
            ? { resourceMetadataUrl: options.resourceMetadataUrl }
            : {}),
        },
      });
    } finally {
      await handler.close();
    }
  };
}
