import { MAX_WAIT_MS } from "@leve/contract";

/** Sends one JSON request and returns the HTTP status and parsed JSON body. */
export interface TransportResponse {
  status: number;
  body: unknown;
  writtenRevisions?: string;
}
export type Transport = (path: string, body: unknown) => Promise<TransportResponse>;
/**
 * Headers sent with every request: fixed, or worked out for each request, for a sign-in token that
 * only lives a minute.
 */
export type RequestHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);
export const WRITTEN_REVISIONS_HEADER = "leve-written-revisions";

export class TransportError extends Error {
  override name = "TransportError";
}

/** Longer than the longest wait a pull may ask for, so only a stuck connection times out. */
export const DEFAULT_TIMEOUT_MS = MAX_WAIT_MS + 20_000;
/** Extra time per byte sent, so a large upload on a slow link (8 KB/s) isn't cut off. */
const MS_PER_BYTE = 1 / 8;

/**
 * A transport over fetch, for the app and for HTTP tests. Paths are joined onto `baseUrl`, so a
 * server behind a path prefix (`https://host/leve`) works.
 */
export function httpTransport(
  baseUrl: string,
  headers: RequestHeaders = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Transport {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return async (path, body) => {
    let sent: Record<string, string>;
    try {
      sent = typeof headers === "function" ? await headers() : headers;
    } catch (error) {
      // Getting a token usually fails for want of a connection; nothing was sent.
      throw new TransportError(`couldn't prepare the request: ${(error as Error).message}`);
    }
    const text = JSON.stringify(body);
    // A plain controller and timer: AbortSignal.timeout isn't available on every platform.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs + Math.ceil(text.length * MS_PER_BYTE),
    );
    let response: Response;
    let parsed: unknown;
    try {
      try {
        response = await fetch(new URL(path.replace(/^\/+/, ""), base), {
          method: "POST",
          headers: { "content-type": "application/json", ...sent },
          body: text,
          signal: controller.signal,
        });
      } catch (error) {
        throw new TransportError(
          controller.signal.aborted ? "request timed out" : (error as Error).message,
        );
      }
      try {
        parsed = await response.json();
      } catch {
        throw new TransportError(
          controller.signal.aborted
            ? "request timed out"
            : `unreadable response (${response.status})`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    const writtenRevisions = response.headers.get(WRITTEN_REVISIONS_HEADER);
    return {
      status: response.status,
      body: parsed,
      ...(writtenRevisions ? { writtenRevisions } : {}),
    };
  };
}
