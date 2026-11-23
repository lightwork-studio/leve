import type { DeviceStore } from "@leve/storage";
import { useEffect, useReducer } from "react";

export type Measurement =
  | { startedAt: number; seconds?: never; text?: never }
  | { seconds: number; startedAt?: never; text?: never }
  | { text: string; startedAt?: never; seconds?: never };
type Session = { workoutId: string; sets: Map<string, Measurement> };
const sessions = new WeakMap<DeviceStore, Session>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function clearSetStopwatch(store: DeviceStore, workoutId: string, setId: string) {
  const session = sessions.get(store);
  if (session?.workoutId !== workoutId || !session.sets.has(setId)) return;
  session.sets.delete(setId);
  notify();
}

/** A set's timer or typed time on this device, if it has one. */
export function readSetStopwatch(
  store: DeviceStore,
  workoutId: string,
  setId: string | undefined,
): Measurement | undefined {
  const session = sessions.get(store);
  return session?.workoutId === workoutId && setId ? session.sets.get(setId) : undefined;
}

/** Records a set's timer or typed time (or clears it, without a measurement). */
export function writeSetStopwatch(
  store: DeviceStore,
  workoutId: string,
  setId: string,
  measurement?: Measurement,
) {
  let current = sessions.get(store);
  if (current?.workoutId !== workoutId) {
    if (!measurement) return;
    current = { workoutId, sets: new Map() };
    sessions.set(store, current);
  }
  if (measurement) current.sets.set(setId, measurement);
  else current.sets.delete(setId);
  notify();
}

/** The stopwatch follows its set across navigation. Only Log commits the measured time. */
export function useSetStopwatch(store: DeviceStore, workoutId: string, setId?: string) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, []);
  const value = readSetStopwatch(store, workoutId, setId);
  const write = (measurement?: Measurement) => {
    if (setId) writeSetStopwatch(store, workoutId, setId, measurement);
  };
  return {
    value,
    start: () => write({ startedAt: Date.now() }),
    stop: () => {
      if (value?.startedAt !== undefined)
        write({ seconds: Math.max(0, Math.floor((Date.now() - value.startedAt) / 1000)) });
    },
    edit: (text: string) => write({ text }),
    clear: () => write(),
  };
}
