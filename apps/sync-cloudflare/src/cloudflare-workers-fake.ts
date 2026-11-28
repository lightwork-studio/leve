// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

// For tests on Node: `cloudflare:workers` as far as the account object uses it (see
// vitest.config.ts). The runtime hands a Durable Object its state and environment.
export class DurableObject<E = unknown> {
  ctx: unknown;
  env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
