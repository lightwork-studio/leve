// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The Worker's bindings, as declared in wrangler.jsonc, and its secrets (see GateEnv in gate.ts).
interface Env {
  ACCOUNTS: DurableObjectNamespace<import("./account-object.ts").AccountObject>;
  RESTORES: DurableObjectNamespace<import("./account-object.ts").RestoreMarker>;
  CLERK_ISSUER?: string;
  CLERK_JWT_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  ADMIN_TOKEN?: string;
  MCP_RESOURCE_URL?: string;
  MCP_WRITES_ENABLED?: string;
  MCP_CLIENT_NAMES?: string;
  // Deleting accounts (see account-deletion.ts): Clerk's Backend API and the Sign in with Apple key.
  CLERK_SECRET_KEY?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  APPLE_CLIENT_ID?: string;
}
