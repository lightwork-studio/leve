import { useNavigation } from "expo-router";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { useAppData } from "./app-data.tsx";
import {
  historyData,
  lastTime,
  liveData,
  readAllWorkoutTrees,
  readSettings,
  sharedProgress,
  trainData,
  workoutDetail,
} from "./read.ts";

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

export function useLive() {
  const { store, version } = useAppData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks every data change.
  return useMemo(() => liveData(store), [store, version]);
}

/** Refresh previous-set suggestions after a history correction. Active-set edits keep the cache. */
export function usePastWorkouts(ready: boolean) {
  const { store, historyVersion } = useAppData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyVersion tracks changes to the stored history.
  return useMemo(() => (ready ? readAllWorkoutTrees(store) : null), [store, ready, historyVersion]);
}

/**
 * The progress data, for the tab and the screens pushed from it. Out of sight (under the live
 * workout, say) they keep what they showed rather than reading the whole history on every set.
 */
export function useProgress() {
  const { store, historyVersion } = useAppData();
  return useWhileFocused(() => sharedProgress(store, historyVersion), [store, historyVersion]);
}

export function useSettings() {
  const { store, version } = useAppData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks every data change.
  return useMemo(() => readSettings(store), [store, version]);
}
