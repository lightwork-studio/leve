import type { DeviceStore } from "@leve/storage";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { newId } from "./ids.ts";
import { readLiveActivityRest } from "./live-activity-rest";

// The rest timer lives outside any screen, so it keeps running when the workout is minimised. It
// is device-only and not stored: a restart ends it.

export interface Rest {
  endsAt: number;
  totalSeconds: number;
}

interface SetRest extends Rest {
  key: string;
  owner: string;
  source: { workoutId: string; entryId: string; setId: string; completedAt: string };
}

const current = new WeakMap<DeviceStore, SetRest>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function restOwner(store: DeviceStore): string {
  const { server, account, lineage } = store.syncState();
  return JSON.stringify([server, account, lineage]);
}

function latestRest(store: DeviceStore): SetRest | undefined {
  const rest = current.get(store);
  if (!rest) return;
  const owner = restOwner(store);
  if (owner !== rest.owner) {
    // Keep the countdown, but invalidate controls published under the prior sync owner.
    const rebound = { ...rest, owner, key: newId() };
    current.set(store, rebound);
    return rebound;
  }
  const change = readLiveActivityRest(rest.key);
  if (!change) return rest;
  if (change.end === 0) {
    current.delete(store);
    return;
  }
  const totalSeconds = (change.end - change.start) / 1000;
  if (rest.endsAt === change.end && rest.totalSeconds === totalSeconds) return rest;
  const updated = { ...rest, endsAt: change.end, totalSeconds };
  current.set(store, updated);
  return updated;
}

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
  refresh: emit,
  start(store: DeviceStore, workoutId: string, setId: string, seconds: number): void {
    const set = store.get("workout_set", setId)?.content;
    const entryId = set?.workoutExerciseId;
    const completedAt = set?.completedAt;
    if (seconds > 0 && typeof completedAt === "string" && typeof entryId === "string") {
      current.set(store, {
        source: { workoutId, entryId, setId, completedAt },
        key: newId(),
        owner: restOwner(store),
        endsAt: Date.now() + seconds * 1000,
        totalSeconds: seconds,
      });
    } else {
      current.delete(store);
    }
    emit();
  },
  adjust(store: DeviceStore, rest: SetRest, seconds: number): void {
    const latest = latestRest(store);
    if (!latest || latest.source !== rest.source) return;
    current.set(store, { ...latest, ...adjustRest(latest, seconds, Date.now()), key: newId() });
    emit();
  },
  /** Gives the running rest a new length (see retimeRest); none ends it. */
  retime(store: DeviceStore, rest: SetRest, seconds: number): void {
    const latest = latestRest(store);
    if (!latest || latest.source !== rest.source) return;
    const now = Date.now();
    const retimed = retimeRest(latest, seconds, now);
    if (seconds <= 0 || retimed.endsAt <= now) current.delete(store);
    else current.set(store, { ...latest, ...retimed, key: newId() });
    emit();
  },
  expire(store: DeviceStore, rest: SetRest): boolean {
    if (latestRest(store) !== rest) return false;
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

function validRest(store: DeviceStore, source: SetRest["source"]) {
  const { workoutId, entryId, setId, completedAt } = source;
  if (store.get("workout", workoutId)?.content?.endedAt !== null) return false;
  if (store.get("workout_exercise", entryId)?.content?.workoutId !== workoutId) return false;
  return store
    .list("workout_set", { parentId: entryId })
    .some((set) => set.id === setId && set.content?.completedAt === completedAt);
}

export function readWorkoutRest(store: DeviceStore, workoutId: string): SetRest | null {
  const rest = latestRest(store);
  return rest?.source.workoutId === workoutId && validRest(store, rest.source) ? rest : null;
}

export function useRest(store: DeviceStore, workoutId: string | undefined, version: number) {
  const snapshot = () => latestRest(store) ?? null;
  const rest = useSyncExternalStore(subscribe, snapshot, snapshot);
  const source = rest?.source;
  // biome-ignore lint/correctness/useExhaustiveDependencies: version changes on data writes, including remote corrections.
  const valid = useMemo(() => {
    return source != null && validRest(store, source);
  }, [source, store, version]);
  useEffect(() => {
    if (source && !valid) restTimer.skip(store, source.workoutId, source);
  }, [source, store, valid]);
  return valid && source?.workoutId === workoutId ? rest : null;
}
