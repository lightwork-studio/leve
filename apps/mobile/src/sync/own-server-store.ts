import * as SecureStore from "expo-secure-store";
import type { OwnServer } from "./own-server.ts";

/*
 * Pairings hold this phone's device token. They are readable after the first unlock, so
 * background sync works, and never move to another phone in a backup.
 */

const KEY = "sync.ownServer";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** Null is the legacy default. The named choices explicitly select Leve or turn off sync. */
export type ServerChoice = OwnServer | "leve" | "local" | null;

interface BoundAccount {
  server: string | null;
  account: string | null;
}

interface Stored {
  current: OwnServer | null;
  previous: OwnServer | null;
  // These are additive so a rollback still sees the chosen pairing while sync is paused.
  mode?: "leve" | "local";
}

let cached: Stored | null = null;
const listeners = new Set<() => void>();

function isOwnServer(value: unknown): value is OwnServer {
  const v = value as Partial<OwnServer> | null;
  return (
    !!v &&
    typeof v.server === "string" &&
    typeof v.account === "string" &&
    typeof v.device === "string" &&
    typeof v.token === "string"
  );
}

function read(): Stored | null {
  if (cached) return cached;
  let stored: Stored = { current: null, previous: null };
  try {
    const text = SecureStore.getItem(KEY, OPTIONS);
    const value = text ? (JSON.parse(text) as Partial<Stored>) : null;
    const mode = value?.mode;
    stored = {
      current: isOwnServer(value?.current) ? value.current : null,
      previous: isOwnServer(value?.previous) ? value.previous : null,
      ...(mode === "leve" || mode === "local" ? { mode } : {}),
    };
  } catch (error) {
    // A damaged value counts as none. A keychain that can't be read (a locked phone) is unknown:
    // nothing is cached, so the next read tries again.
    if (!(error instanceof SyntaxError)) return null;
  }
  cached = stored;
  return stored;
}

function write(next: Stored): void {
  SecureStore.setItem(KEY, JSON.stringify(next), OPTIONS);
  cached = next;
  for (const listener of listeners) listener();
}

/** The server this phone syncs with, if it is one of the person's own. */
export function ownServer(): OwnServer | null {
  const choice = readServerChoice();
  return choice && typeof choice === "object" ? choice : null;
}

/** Undefined means the keychain is unreadable and syncing must wait. */
export function readServerChoice(): ServerChoice | undefined {
  const stored = read();
  return stored ? (stored.mode ?? stored.current) : undefined;
}

function matches(server: OwnServer | null, bound: BoundAccount): server is OwnServer {
  return server !== null && server.server === bound.server && server.account === bound.account;
}

/** A paired destination whose credentials still match where this phone's data belongs. */
export function canRestorePairedServer(bound: BoundAccount): boolean {
  const stored = read();
  return (
    !!stored &&
    (matches(stored.previous, bound) || (stored.mode === "local" && matches(stored.current, bound)))
  );
}

function editableChoice(): Stored {
  const choice = read();
  if (!choice) throw new Error("the keychain is unavailable");
  return choice;
}

/** Use this paired server from now on. Throws when the keychain refuses it; nothing changes then. */
export function chooseOwnServer(server: OwnServer, bound?: BoundAccount): void {
  const { current, previous } = editableChoice();
  const recovery =
    bound && !matches(current, bound) && matches(previous, bound) ? previous : current;
  write({ current: server, previous: recovery });
}

/** Go back to the build's own server, keeping a paired server for data recovery. */
export function chooseBuiltInServer(bound?: BoundAccount): void {
  const { current, previous, mode } = editableChoice();
  if (mode === "leve") return;
  const recovery =
    bound && !matches(current, bound) && matches(previous, bound)
      ? previous
      : (current ?? previous);
  write({ mode: "leve", current: null, previous: recovery });
}

/** Leave sync off, retaining both pairings for data recovery and compatibility with older builds. */
export function chooseLocalSync(): void {
  const stored = editableChoice();
  if (stored.mode !== "local") write({ ...stored, mode: "local" });
}

/** Swap the current and the previous choice. */
export function switchBack(): void {
  const { current, previous } = editableChoice();
  write({ current: previous, previous: current });
}

/** Restore only credentials that still match the data at the time the user confirms. */
export function restorePairedServer(bound: BoundAccount): void {
  const { current, previous, mode } = editableChoice();
  if (mode === "local" && matches(current, bound)) write({ current, previous });
  else if (matches(previous, bound)) switchBack();
  else throw new Error("the previous pairing is no longer available");
}

/** The prior pairing, retained for recovery. */
export function previousServer(): OwnServer | null {
  return read()?.previous ?? null;
}

export function subscribeServerChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests start from nothing. */
export function forgetServerChoice(): void {
  cached = null;
}
