// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The Worker's bindings, as declared in wrangler.jsonc.
interface Env {
  ACCOUNTS: DurableObjectNamespace<import("./account-object.ts").AccountObject>;
  RESTORES: DurableObjectNamespace<import("./account-object.ts").RestoreMarker>;
  /** The spike's shared token, set as a Worker secret. */
  SPIKE_TOKEN: string;
}
