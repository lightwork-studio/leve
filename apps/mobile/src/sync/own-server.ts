/*
 * Syncing with a server someone runs themselves (apps/sync-node). Its operator hands out a one-time
 * pairing link; the phone trades the link's code for a device token of its own, which then signs
 * every sync request in. No Clerk sign-in is involved. Nothing here touches the sync protocol:
 * pairing is the server's own endpoint, next to it.
 */

/** A paired server: where it is, the account the phone joined, and the phone's token there. */
export interface OwnServer {
  /** The server's address, without trailing slashes. The phone's data is tied to this string. */
  server: string;
  account: string;
  /** The operator's name for the account, when the server said it. */
  accountName?: string;
  device: string;
  token: string;
}

export interface PairingLink {
  server: string;
  code: string;
}

const CODE = /^[A-Za-z0-9_-]{8,64}$/;
/** The app's URL schemes: App Store, TestFlight preview, development builds. */
const SCHEMES = new Set(["leve:", "leve-preview:", "leve-dev:"]);

/**
 * A server address phones may use: HTTPS, or plain HTTP to this machine for development. No user
 * name, query or fragment. Trailing slashes go, as the same server written another way would count
 * as another server.
 */
export function normalizeServer(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  // A path that reads like another address ("/https://other.example", "/@other") would make the
  // server's name, as the person checks it, look like someone else's.
  if (/\/\/|@|:/.test(url.pathname.replace(/\/+$/, ""))) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Reads a pairing link: the server's page (`https://sync.example.com/connect#code=…`, what the
 * operator's command prints and a QR code holds) or the app link that page opens
 * (`leve://connect?server=…&code=…`). Null for anything else.
 */
export function parsePairingLink(text: string): PairingLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  let server: string | null;
  let code: string | null;
  if (SCHEMES.has(url.protocol)) {
    // `leve://connect?…`: "connect" is the host, or the path when written `leve:///connect`.
    if (url.hostname !== "connect" && url.pathname.replace(/^\/+/, "") !== "connect") return null;
    server = normalizeServer(url.searchParams.get("server") ?? "");
    code = url.searchParams.get("code");
  } else {
    if (!/\/connect\/?$/.test(url.pathname)) return null;
    code = new URLSearchParams(url.hash.slice(1)).get("code");
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/connect\/?$/, "");
    server = normalizeServer(url.toString());
  }
  if (!server || !code || !CODE.test(code)) return null;
  return { server, code };
}

/** A pairing link from its parts, as the app link carries them; null when either is unusable. */
export function pairingLinkFrom(
  server: string | undefined,
  code: string | undefined,
): PairingLink | null {
  const normalized = normalizeServer(server ?? "");
  if (!normalized || !code || !CODE.test(code)) return null;
  return { server: normalized, code };
}

/** Why pairing didn't work, in words for the person. */
export type PairingProblem =
  | "code" // used, expired or mistyped
  | "off" // the server doesn't pair new phones now
  | "offline" // no answer
  | "not_leve"; // something answered, but not a Leve sync server

export class PairingError extends Error {
  override name = "PairingError";
  readonly problem: PairingProblem;
  constructor(problem: PairingProblem) {
    super(problem);
    this.problem = problem;
  }
}

export const PAIRING_PROBLEMS: Record<PairingProblem, string> = {
  code: "This link has been used or has run out. Ask for a new one.",
  off: "This server doesn't accept new phones right now. Ask whoever runs it.",
  offline: "The server couldn't be reached. Check the connection and try again.",
  not_leve: "That address doesn't answer like a Leve sync server.",
};

/** How long pairing waits for the server before saying it couldn't be reached. */
export const PAIRING_TIMEOUT_MS = 20_000;
/** What a device token and id may look like; anything else is refused as not Leve's. */
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Trades a pairing link for this phone's device token. Redirects are refused: the code goes to
 * the server the person confirmed and nowhere else.
 */
export async function pair(
  link: PairingLink,
  deviceName: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = PAIRING_TIMEOUT_MS,
): Promise<OwnServer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let body: unknown;
  try {
    try {
      response = await fetchFn(`${link.server}/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: link.code, device: deviceName }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new PairingError("offline");
    }
    // An answer from somewhere else, from a fetch that followed a redirect anyway.
    if (response.redirected) throw new PairingError("not_leve");
    try {
      body = await response.json();
    } catch {
      throw new PairingError(
        response.status >= 500 || controller.signal.aborted ? "offline" : "not_leve",
      );
    }
  } finally {
    clearTimeout(timer);
  }
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (response.status === 401 && code === "unauthorized") throw new PairingError("code");
  if (response.status === 403 && code === "pairing_off") throw new PairingError("off");
  if (response.status >= 500) throw new PairingError("offline");
  const paired = body as Partial<Record<"account" | "accountName" | "device" | "token", unknown>>;
  if (
    response.status !== 200 ||
    typeof paired.account !== "string" ||
    typeof paired.device !== "string" ||
    typeof paired.token !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(paired.account) ||
    !DEVICE_ID.test(paired.device) ||
    !TOKEN.test(paired.token)
  ) {
    throw new PairingError("not_leve");
  }
  return {
    server: link.server,
    account: paired.account,
    ...(typeof paired.accountName === "string" ? { accountName: paired.accountName } : {}),
    device: paired.device,
    token: paired.token,
  };
}

/** The server's host, for showing which server this is. */
export function serverLabel(server: string): string {
  try {
    const url = new URL(server);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return server;
  }
}
