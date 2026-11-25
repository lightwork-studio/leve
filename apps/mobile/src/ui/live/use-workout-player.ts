import { router } from "expo-router";
import { useAppData } from "../../data/app-data.tsx";
import { useLive, usePastWorkouts } from "../../data/queries.ts";
import { useRest } from "../../data/rest-timer.ts";
import { logSet } from "../../data/workout-actions.ts";
import { routineTarget, setProgress } from "../../model/live.ts";
import { previousValue } from "../../model/log-values.ts";
import { totalWeight } from "../format.ts";
import { haptic } from "../haptics.ts";
import { readSetStopwatch, useSetStopwatch } from "../use-set-stopwatch.ts";
import { useWorkoutInputs } from "../use-workout-inputs.ts";
import { useWorkoutSelection } from "../use-workout-selection.ts";
import {
  fieldUnit,
  fieldView,
  logValues,
  metricsOf,
  setDefaults,
  show,
  valuesLine,
} from "./set-fields.ts";
import {
  afterLog,
  dockTarget,
  entryDistanceUnit,
  exerciseAfterLog,
  pendingAsk,
  previousForWorkout,
} from "./targets.ts";

export function useWorkoutPlayer() {
  const { store, version, change } = useAppData();
  const live = useLive();
  const tree = live?.tree;
  const workoutId = tree?.workout.id;
  const { drafts, setDrafts, distanceUnits } = useWorkoutInputs(store, workoutId);
  const { focusIndex, pickedSetId, focusExercise } = useWorkoutSelection(store, tree);
  const rest = useRest(store, workoutId, version);
  const target = tree ? dockTarget(tree, focusIndex, pickedSetId) : null;
  // Last time's values, read with the rest of the history while the minimised workout shows.
  const history = usePastWorkouts(!!live);
  const previous =
    live && history
      ? previousForWorkout(history, live.tree, live.settings, live.initialPlan)
      : null;
  // The set's stopwatch decides whether it can be logged from here.
  useSetStopwatch(store, workoutId ?? "", target?.set.id);
  if (!live || !tree) return null;
  const { settings, initialPlan } = live;
  const unit = settings.weightUnit;
  const title = tree.workout.content.title || "Workout";
  const progress = setProgress(tree);
  const name = target?.entry.entry.content.exerciseName;
  const distanceUnit = target
    ? entryDistanceUnit(
        target.entry.entry.content.exerciseType,
        distanceUnits[target.entry.entry.id],
        settings,
      )
    : "m";
  const defaults = target
    ? setDefaults(
        target.entry,
        target.setIndex,
        drafts,
        unit,
        previous?.get(target.entry.entry.id)?.sets[target.setIndex],
      )
    : undefined;
  const metrics = target ? metricsOf(target.entry.entry.content.exerciseType) : [];
  const views = target
    ? metrics.map((metric) => ({
        metric,
        view: fieldView({
          set: target.set.content,
          metric,
          type: target.entry.entry.content.exerciseType,
          unit,
          distanceUnit,
          draft: drafts[target.set.id],
          timer: readSetStopwatch(store, tree.workout.id, target.set.id),
          previous: defaults,
          target: routineTarget(initialPlan, target.set.content),
          ready: previous !== null,
        }),
      }))
    : [];
  const values = valuesLine(views, unit);
  const measurements = views
    .map(({ metric, view }) =>
      metric === "duration" ? view.text : `${view.text} ${fieldUnit(metric, unit, distanceUnit)}`,
    )
    .join(metrics.includes("reps") ? " × " : " · ");
  const last = target && previous?.get(target.entry.entry.id)?.sets[target.setIndex];
  const lastValues = last
    ? metrics
        .map((metric) => show(metric, previousValue(last, metric), unit, distanceUnit) || "–")
        .join(metrics.includes("reps") ? " × " : " · ")
    : "";
  const resume = () => router.push("/workout/active");
  const result =
    target &&
    logValues({
      set: target.set.content,
      type: target.entry.entry.content.exerciseType,
      unit,
      distanceUnit,
      draft: drafts[target.set.id],
      timer: readSetStopwatch(store, tree.workout.id, target.set.id),
      previous: defaults,
      target: routineTarget(initialPlan, target.set.content),
    });
  /** Logs the next set if it can be logged as it stands; otherwise opens it to be typed. */
  const log = (expectedVersion?: string) => {
    if (!target) return;
    // Until last time's values are known, a set logged here could miss them.
    if (!previous) return resume();
    const { entry, set } = target;
    const type = entry.entry.content.exerciseType;
    if (result === null) return resume();
    const ask = (message: string, metric = metricsOf(type)[0] ?? "reps") => {
      haptic.warning();
      pendingAsk.set(store, {
        workoutId: tree.workout.id,
        entryId: entry.entry.id,
        setId: set.id,
        metric,
        message,
      });
      resume();
    };
    if ("error" in result) return ask(result.error, result.missing);
    try {
      const recorded = change((db) => {
        const row = db.get("workout_set", set.id);
        if (
          db !== store ||
          db.activeWorkout()?.id !== tree.workout.id ||
          row?.deleted ||
          row?.content?.workoutExerciseId !== entry.entry.id ||
          db.get("workout_exercise", entry.entry.id)?.content?.workoutId !== tree.workout.id ||
          (row.content.completedAt ?? null) !== null
        )
          return false;
        logSet(db, set.id, result.values, {
          expectedVersion,
          id: set.id,
          values: set.content,
          parent: { workoutId: tree.workout.id, exerciseId: entry.entry.content.exerciseId },
          exerciseType: type,
        });
        return true;
      }, "active-workout");
      if (!recorded) return;
    } catch (error) {
      return ask((error as Error).message);
    }
    haptic.tap();
    focusExercise(exerciseAfterLog(tree, entry.entry.id));
    afterLog(store, tree.workout.id, entry, set.id, setDrafts);
    return true;
  };
  const setName = target
    ? target.set.content.type === "warmup"
      ? "warm-up"
      : `set ${target.label}`
    : "";
  return {
    store,
    tree,
    rest,
    target,
    name,
    title,
    setName,
    values,
    progress,
    resume,
    log,
    canLog: !!(previous && result && "values" in result),
    logValues: result && "values" in result ? result.values : null,
    measurements,
    lastValues,
    volume: totalWeight(live.summary.volumeKg, unit),
  };
}
