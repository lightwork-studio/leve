import type { SetDistanceUnit, WeightUnit } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { useSyncExternalStore } from "react";
import type { Draft } from "../model/log-values.ts";

export type SetDrafts = Record<
  string,
  Draft & { weightUnit?: WeightUnit; distanceUnit?: SetDistanceUnit }
>;
export type UpdateSetDrafts = (update: (drafts: SetDrafts) => SetDrafts) => void;

interface WorkoutInputs {
  drafts: SetDrafts;
  distanceUnits: Record<string, SetDistanceUnit>;
}
const empty: WorkoutInputs = { drafts: {}, distanceUnits: {} };

function createInputs(store: DeviceStore) {
  let owner: string | undefined;
  let current = empty;
  const listeners = new Set<() => void>();
  const read = (id: string | undefined) => (owner === id ? current : empty);
  return {
    read,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(id: string | undefined, edit: (inputs: WorkoutInputs) => WorkoutInputs) {
      if (!id || (id !== owner && store.activeWorkout()?.id !== id)) return;
      current = edit(read(id));
      owner = id;
      for (const listener of listeners) listener();
    },
  };
}

const devices = new WeakMap<DeviceStore, ReturnType<typeof createInputs>>();

/** This device's unfinished entries, for reading and changing them outside the workout screen. */
export function workoutInputs(store: DeviceStore) {
  let session = devices.get(store);
  if (!session) {
    session = createInputs(store);
    devices.set(store, session);
  }
  return session;
}

/** Keep unfinished entries on this device while the workout is minimised. Only Log records them. */
export function useWorkoutInputs(store: DeviceStore, workoutId: string | undefined) {
  const session = workoutInputs(store);
  const snapshot = () => session.read(workoutId);
  const values = useSyncExternalStore(session.subscribe, snapshot, snapshot);
  const setDrafts: UpdateSetDrafts = (update) =>
    session.update(workoutId, (inputs) => ({ ...inputs, drafts: update(inputs.drafts) }));
  const chooseDistanceUnit = (entryId: string, unit: SetDistanceUnit) =>
    session.update(workoutId, (inputs) => ({
      ...inputs,
      distanceUnits: { ...inputs.distanceUnits, [entryId]: unit },
    }));
  return { ...values, setDrafts, chooseDistanceUnit };
}
