import type { DeviceStore } from "@leve/storage";
import { useNavigation } from "expo-router";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { recordsByWorkout } from "../model/progress.ts";
import { whenIdle } from "../ui/when-idle.ts";
import { useAppData } from "./app-data.tsx";
import {
  cachedProgress,
  historyData,
  lastTime,
  liveData,
  readAllWorkoutTrees,
  readSettings,
  sharedProgress,
  trainData,
  weekBarData,
  workoutDetail,
} from "./read.ts";
import { heldSet } from "./set-removal.ts";

/**
 * Like useMemo, but a screen out of sight (a tab under the live workout, say) keeps what it last
 * showed instead of reading again on every change; it catches up when it is shown again.
 */
function useWhileFocused<T>(compute: () => T, deps: readonly unknown[]): T {
  const navigation = useNavigation();
  const last = useRef<{ deps: readonly unknown[]; value: T } | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  const stale = (now: readonly unknown[]) => {
    const current = last.current;
    return !current || now.some((dep, i) => !Object.is(dep, current.deps[i]));
  };
  // Focus is followed in a ref, not state: re-rendering the whole screen on every tab switch is
  // what this avoids. Coming back renders again only if something changed while out of sight. A
  // screen built ahead of time (a preloaded tab) learns it is out of sight once mounted.
  const focused = useRef(true);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stale only reads refs.
  useEffect(() => {
    focused.current = navigation.isFocused();
    const stopFocus = navigation.addListener("focus", () => {
      focused.current = true;
      if (stale(latest.current)) refresh();
    });
    const stopBlur = navigation.addListener("blur", () => {
      focused.current = false;
    });
    return () => {
      stopFocus();
      stopBlur();
    };
  }, [navigation]);
  if (!last.current || (stale(deps) && focused.current)) {
    last.current = { deps, value: compute() };
  }
  return last.current.value;
}

export function useTrain(now: number) {
  const { store, version } = useAppData();
  return useWhileFocused(() => trainData(store, now), [store, version, now]);
}

export function useHistory() {
  const { store, historyVersion } = useAppData();
  return useWhileFocused(() => historyData(store), [store, historyVersion]);
}

/** The previous session of the same routine, for the saved summary's comparison. */
export function useLastTime(workoutId: string) {
  const { store, version } = useAppData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks every data change.
  return useMemo(() => lastTime(store, workoutId), [store, version, workoutId]);
}

export function useWorkoutDetail(workoutId: string) {
  const { store, version } = useAppData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks every data change.
  return useMemo(() => workoutDetail(store, workoutId), [store, version, workoutId]);
}

// The full workout, mini-player and Live Activity can hand off the same snapshot.
const liveCache = new WeakMap<
  DeviceStore,
  { version: number; removal: ReturnType<typeof heldSet>; data: ReturnType<typeof liveData> }
>();

export function useLive() {
  const { store, version } = useAppData();
  const cached = liveCache.get(store);
  // Settling Undo can release a held set even when its deletion is refused.
  const removal = heldSet(store);
  if (cached?.version === version && cached.removal === removal) return cached.data;
  const data = liveData(store);
  liveCache.set(store, { version, removal, data });
  return data;
}

const pastWorkoutsCache = new WeakMap<
  DeviceStore,
  { historyVersion: number; data: ReturnType<typeof readAllWorkoutTrees> }
>();

/** Use current history if another view has already read it. Defer a cold read if needed. */
export function usePastWorkouts(allowRead: boolean) {
  const { store, historyVersion } = useAppData();
  const cached = pastWorkoutsCache.get(store);
  if (cached?.historyVersion === historyVersion) return cached.data;
  if (!allowRead) return null;
  const data = readAllWorkoutTrees(store);
  pastWorkoutsCache.set(store, { historyVersion, data });
  return data;
}

/**
 * The progress data, for the tab and the screens pushed from it. Out of sight (under the live
 * workout, say) they keep what they showed rather than reading the whole history on every set.
 */
export function useProgress() {
  const { store, historyVersion } = useAppData();
  return useWhileFocused(() => sharedProgress(store, historyVersion), [store, historyVersion]);
}

/**
 * The week bar over the tabs, read again when finished workouts change or the day does. Records
 * need the whole history read, which an edit must not wait for: the bar takes them from the
 * progress index once another screen (or an idle moment) has read it, and keeps the last ones it
 * had until then.
 */
export function useWeekBar(today: number) {
  const { store, historyVersion } = useAppData();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const cached = cachedProgress(store, historyVersion);
  const held = useRef<ReadonlyMap<string, readonly unknown[]> | null>(null);
  if (cached) held.current = recordsByWorkout(cached.index);
  useEffect(() => {
    if (cachedProgress(store, historyVersion)) return;
    return whenIdle(() => {
      sharedProgress(store, historyVersion);
      refresh();
    });
  }, [store, historyVersion]);
  return useWhileFocused(
    () => weekBarData(store, today, held.current),
    [store, historyVersion, today, cached],
  );
}

export function useSettings() {
  const { store, version } = useAppData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks every data change.
  return useMemo(() => readSettings(store), [store, version]);
}
