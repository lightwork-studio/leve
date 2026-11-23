import type { DeviceStore } from "@leve/storage";
import { useEffect, useMemo, useSyncExternalStore } from "react";

// The rest timer lives outside any screen, so it keeps running when the workout is minimised. It
// is device-only and not stored: a restart ends it.

export interface Rest {
  endsAt: number;
  totalSeconds: number;
}

interface SetRest extends Rest {
  source: { workoutId: string; entryId: string; setId: string; completedAt: string };
}

const current = new WeakMap<DeviceStore, SetRest>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

/** Shortening skips part of the interval. Adding time extends the interval as before. */
export function adjustRest(rest: Rest, seconds: number, now: number): Rest {
  return {
    ...rest,
    endsAt: Math.max(now, rest.endsAt + seconds * 1000),
    totalSeconds: rest.totalSeconds + Math.max(0, seconds),
  };
}

/**
 * The same rest with a new length, counted from when it started. A length it has already passed
 * ends it now.
 */
export function retimeRest(rest: Rest, seconds: number, now: number): Rest {
  const startedAt = rest.endsAt - rest.totalSeconds * 1000;
  return { endsAt: Math.max(now, startedAt + seconds * 1000), totalSeconds: seconds };
}

export function restProgress(rest: Rest, now: number) {
  const left = Math.min(rest.totalSeconds * 1000, Math.max(0, rest.endsAt - now));
  return { left, fraction: Math.max(0, 1 - left / (rest.totalSeconds * 1000)) };
}

export const restTimer = {
  start(store: DeviceStore, workoutId: string, setId: string, seconds: number): void {
    const set = store.get("workout_set", setId)?.content;
    const entryId = set?.workoutExerciseId;
    const completedAt = set?.completedAt;
    if (seconds > 0 && typeof completedAt === "string" && typeof entryId === "string") {
      current.set(store, {
        source: { workoutId, entryId, setId, completedAt },
        endsAt: Date.now() + seconds * 1000,
        totalSeconds: seconds,
      });
    } else {
      current.delete(store);
    }
    emit();
  },
  adjust(store: DeviceStore, rest: SetRest, seconds: number): void {
    const latest = current.get(store);
    if (!latest || latest.source !== rest.source) return;
    current.set(store, { ...latest, ...adjustRest(latest, seconds, Date.now()) });
    emit();
  },
  /** Gives the running rest a new length (see retimeRest); none ends it. */
  retime(store: DeviceStore, rest: SetRest, seconds: number): void {
    const latest = current.get(store);
    if (!latest || latest.source !== rest.source) return;
    const now = Date.now();
    const retimed = retimeRest(latest, seconds, now);
    if (seconds <= 0 || retimed.endsAt <= now) current.delete(store);
    else current.set(store, { ...latest, ...retimed });
    emit();
  },
  expire(store: DeviceStore, rest: SetRest): boolean {
    if (current.get(store) !== rest) return false;
    restTimer.skip(store, rest.source.workoutId);
    return true;
  },
  skip(store: DeviceStore, workoutId: string, expected?: SetRest["source"]): void {
    const rest = current.get(store);
    if (rest?.source.workoutId !== workoutId || (expected && rest.source !== expected)) return;
    current.delete(store);
    emit();
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRest(store: DeviceStore, workoutId: string | undefined, version: number) {
  const snapshot = () => current.get(store) ?? null;
  const rest = useSyncExternalStore(subscribe, snapshot, snapshot);
  const source = rest?.source;
  // biome-ignore lint/correctness/useExhaustiveDependencies: version changes on data writes, including remote corrections.
  const valid = useMemo(() => {
    if (!source) return false;
    const { workoutId, entryId, setId, completedAt } = source;
    if (store.get("workout", workoutId)?.content?.endedAt !== null) return false;
    if (store.get("workout_exercise", entryId)?.content?.workoutId !== workoutId) return false;
    const sets = store.list("workout_set", { parentId: entryId });
    return sets.some((set) => set.id === setId && set.content?.completedAt === completedAt);
  }, [source, store, version]);
  useEffect(() => {
    if (source && !valid) restTimer.skip(store, source.workoutId, source);
  }, [source, store, valid]);
  return valid && source?.workoutId === workoutId ? rest : null;
}
