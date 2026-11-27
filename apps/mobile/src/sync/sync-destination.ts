import { chooseLocalSync } from "./own-server-store.ts";
import { setSyncPaused, syncPaused, syncPauseIsTemporary } from "./sync-preferences.ts";

/** Older builds also stay offline after a rollback: they understand the persisted pause. */
export function turnSyncOff(): void {
  const paused = syncPaused();
  if (!paused || syncPauseIsTemporary()) {
    setSyncPaused(true);
    if (syncPauseIsTemporary()) {
      setSyncPaused(paused);
      throw new Error("could not save the sync pause");
    }
  }
  try {
    chooseLocalSync();
  } catch (error) {
    if (!paused) setSyncPaused(false);
    throw error;
  }
}
