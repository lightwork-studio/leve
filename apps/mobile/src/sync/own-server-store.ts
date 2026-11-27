import * as SecureStore from "expo-secure-store";
import type { OwnServer } from "./own-server.ts";

/*
 * Which server this phone syncs with, when it isn't the build's own: kept in the keychain, because
 * it holds the phone's device token. Readable after the first unlock, so syncing in the background
 * works, and never moved to another phone by a backup: the token belongs to this one.
 *
 * Besides the current choice it remembers the one before, so a person who switched by mistake can
 * switch back to the server that still holds their unsynced changes.
 */

const KEY = "sync.ownServer";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** `null` is the build's own server. `"local"` explicitly turns off sync. */
export type ServerChoice = OwnServer | "local" | null;

interface Stored {
  current: ServerChoice;
  previous: OwnServer | null;
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
    stored = {
      current: value?.current === "local" || isOwnServer(value?.current) ? value.current : null,
      previous: isOwnServer(value?.previous) ? value.previous : null,
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
  const choice = read()?.current;
  return choice && choice !== "local" ? choice : null;
}

/** Undefined means the keychain is unreadable and syncing must wait. */
export function readServerChoice(): ServerChoice | undefined {
  return read()?.current;
}

/** The choice before the current one, for switching back. */
export function previousServer(): OwnServer | null {
  return read()?.previous ?? null;
}

function editableChoice(): Stored {
  const choice = read();
  if (!choice) throw new Error("the keychain is unavailable");
  return choice;
}

/** Use this paired server from now on. Throws when the keychain refuses it; nothing changes then. */
export function chooseOwnServer(server: OwnServer): void {
  const { current, previous } = editableChoice();
  write({ current: server, previous: current === "local" ? previous : current });
}

/** Go back to the build's own server. The paired server is remembered for switching back. */
export function chooseBuiltInServer(): void {
  const { current, previous } = editableChoice();
  if (current !== null)
    write({ current: null, previous: current === "local" ? previous : current });
}

/** Leave sync off while keeping the last destination available for the data recovery prompt. */
export function chooseLocalSync(): void {
  const { current } = editableChoice();
  if (current !== "local") write({ current: "local", previous: current });
}

/** Swap the current and the previous choice. */
export function switchBack(): void {
  const { current, previous } = editableChoice();
  write({ current: previous, previous: current === "local" ? null : current });
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
