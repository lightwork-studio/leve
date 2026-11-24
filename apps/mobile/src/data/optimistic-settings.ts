import type { DeviceStore } from "@leve/storage";
import { useSyncExternalStore } from "react";
import { afterFeedback } from "../ui/after-feedback.ts";
import type { AppData } from "./app-data.tsx";
import { type StoredSettings, saveSettings } from "./settings-actions.ts";

type SettingsPatch = Partial<Omit<StoredSettings, "trackRepsInReserve">>;
type Pending = {
  patch: SettingsPatch | null;
  problem: string | null;
};

const settingsWrites = new WeakMap<DeviceStore, ReturnType<typeof settingsWriteState>>();

function settingsWriteState(store: DeviceStore) {
  let current: Pending = { patch: null, problem: null };
  const listeners = new Set<() => void>();
  const publish = (next: Pending) => {
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => current,
    dismiss: () => publish({ ...current, problem: null }),
    enqueue(
      edit: (pending: SettingsPatch) => SettingsPatch | null,
      change: AppData["change"],
      onFailure: (problem: string) => void,
    ): boolean {
      const patch = edit(current.patch ?? {});
      if (!patch) return false;
      const alreadyScheduled = current.patch !== null;
      publish({ patch: { ...current.patch, ...patch }, problem: null });
      if (!alreadyScheduled) {
        afterFeedback(() => {
          const pending = current.patch;
          if (!pending) return;
          try {
            change((db) => {
              if (db === store) saveSettings(db, pending);
            });
          } catch (error) {
            const problem = (error as Error).message;
            publish({ patch: null, problem });
            onFailure(problem);
            return;
          }
          publish({ patch: null, problem: null });
        });
      }
      return true;
    },
  };
}

/** Settings on this device share a draft until the scheduled atomic write settles. */
export function useOptimisticSettings(store: DeviceStore) {
  let writes = settingsWrites.get(store);
  if (!writes) {
    writes = settingsWriteState(store);
    settingsWrites.set(store, writes);
  }
  return {
    ...useSyncExternalStore(writes.subscribe, writes.snapshot, writes.snapshot),
    enqueue: writes.enqueue,
    dismiss: writes.dismiss,
  };
}
