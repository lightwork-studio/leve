// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { Transport } from "../transport.ts";
import type { SyncService } from "./service.ts";

const ROUTES = { "/sync/hello": "hello", "/sync/push": "push", "/sync/pull": "pull" } as const;

/**
 * Calls the service directly, with a JSON round trip so neither side can share objects. Used by
 * simulations; the HTTP handler is tested separately.
 */
export function serviceTransport(service: SyncService, accountId: string): Transport {
  return async (path, body) => {
    const route = ROUTES[path as keyof typeof ROUTES];
    if (!route) return { status: 400, body: { error: { code: "invalid_request", message: path } } };
    const reply = await service[route](accountId, JSON.parse(JSON.stringify(body)));
    return { ...reply, body: JSON.parse(JSON.stringify(reply.body)) };
  };
}
