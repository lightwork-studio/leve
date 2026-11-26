// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

/*
 * The seam every way of signing in plugs into: Clerk session tokens on the managed Worker, OAuth
 * access tokens for MCP clients, a self-hosted server's own device tokens. An authenticator turns
 * a bearer token into the account it may reach. Hosts never take the account from anything else
 * the client sends.
 */

/** Scopes an agent can be granted. Writing includes reading. */
export const SCOPES = { read: "leve:read", write: "leve:write" } as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** Who a request acts as. */
export interface Principal {
  /** The account the request may reach, and no other. */
  account: string;
  /** A phone or other device of the lifter, or an agent such as an MCP client. */
  client: { kind: "device" | "agent"; id: string; name?: string };
  /** What an agent was granted. Devices have none and reach their whole account. */
  scopes?: readonly string[];
}

/**
 * - `principal`: the token is good.
 * - `refused`: the token isn't good; the client should sign in again (401).
 * - `unavailable`: the server can't check tokens right now, for example a missing or broken key;
 *   telling the client to sign in again would not help (503).
 */
export type AuthOutcome = { principal: Principal } | { refused: true } | { unavailable: true };

export type Authenticator = (bearer: string) => Promise<AuthOutcome>;

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** One run of visible ASCII after the scheme; a token never contains spaces. */
const BEARER = /^Bearer +([\x21-\x7e]+) *$/i;

/** The token of an `Authorization: Bearer …` header, or "" when there is none. */
export function bearerToken(authorization: string | null | undefined): string {
  return authorization?.match(BEARER)?.[1] ?? "";
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The principal rebuilt from exactly the fields this seam defines, or null when it isn't one: an
 * account id storage would refuse, an unknown client kind, an empty client id, scopes that aren't
 * a list (an OAuth `scope` claim is one space-separated string), or a device with scopes, which
 * would look limited but isn't.
 */
function checkedPrincipal(value: unknown): Principal | null {
  if (!value || typeof value !== "object") return null;
  const { account, client, scopes } = value as Record<string, unknown>;
  if (typeof account !== "string" || !ACCOUNT_ID.test(account)) return null;
  if (!client || typeof client !== "object") return null;
  const { kind, id, name } = client as Record<string, unknown>;
  if (kind !== "device" && kind !== "agent") return null;
  if (typeof id !== "string" || id === "") return null;
  if (name !== undefined && typeof name !== "string") return null;
  if (scopes !== undefined && (kind === "device" || !isStringList(scopes))) return null;
  return {
    account,
    client: { kind, id, ...(name === undefined ? {} : { name }) },
    ...(scopes === undefined ? {} : { scopes: [...(scopes as string[])] }),
  };
}

/**
 * Runs an authenticator on a request's `Authorization` header and checks what it returns. A
 * request without a bearer token is refused without asking it. An authenticator that fails or
 * answers something other than the three outcomes is `unavailable`, never a way in, and a
 * principal that isn't well formed is `refused`.
 */
export async function authenticateBearer(
  authenticator: Authenticator,
  authorization: string | null | undefined,
  onError?: (error: unknown) => void,
): Promise<AuthOutcome> {
  const token = bearerToken(authorization);
  if (!token) return { refused: true };
  const failed = (error: unknown): AuthOutcome => {
    try {
      onError?.(error);
    } catch {}
    return { unavailable: true };
  };
  try {
    const outcome: unknown = await authenticator(token);
    // Exactly one of the three answers, as the object's own property: an answer that is both a
    // principal and a refusal is a bug, and it must not let anyone in.
    if (outcome && typeof outcome === "object") {
      const keys = Object.keys(outcome);
      const value = (outcome as Record<string, unknown>)[keys[0] as string];
      if (keys.length === 1 && keys[0] === "principal") {
        const principal = checkedPrincipal(value);
        return principal ? { principal } : { refused: true };
      }
      if (keys.length === 1 && keys[0] === "refused" && value === true) return { refused: true };
      if (keys.length === 1 && keys[0] === "unavailable" && value === true) {
        return { unavailable: true };
      }
    }
    throw new Error("the authenticator answered something other than an outcome");
  } catch (error) {
    // Including a throwing getter or proxy in the answer.
    return failed(error);
  }
}

/**
 * Whether the principal may do what `scope` covers. Devices reach their whole account; an agent
 * needs the scope, or a broader one (writing includes reading).
 */
export function allows(principal: Principal, scope: Scope): boolean {
  if (principal.client.kind === "device") return true;
  const granted = isStringList(principal.scopes) ? principal.scopes : [];
  if (granted.includes(scope)) return true;
  return scope === SCOPES.read && granted.includes(SCOPES.write);
}
