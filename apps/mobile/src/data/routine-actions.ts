import { MAX_POSITION, type RecordContent } from "@leve/contract";
import { type EffortScale, LIMITS } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { effortValue, equivalentEffort, parseEffort, routineEffortScale } from "../model/effort.ts";
import { correctionValues, type Draft, parseTyped } from "../model/log-values.ts";
import type { Settings } from "../model/types.ts";
import type { BuiltInExercise } from "./exercises.ts";
import { newId } from "./ids.ts";
import { parseRestSeconds } from "./settings-actions.ts";

export type StoredPlan = RecordContent<"routine">["exercises"];
type StoredEntry = StoredPlan[number];

export interface PlannedExercise {
  id: string;
  exercise: BuiltInExercise;
  original?: StoredEntry;
  supersetId?: number | null;
  restSecondsText?: string;
  useRepRange?: boolean;
  sets: {
    id: string;
    original?: StoredEntry["sets"][number];
    type?: StoredEntry["sets"][number]["type"];
    effortText?: string;
    values: Draft & { repRangeMin?: string; repRangeMax?: string };
  }[];
}

export function createRoutine(
  store: DeviceStore,
  name: string,
  folderId: string | null,
  plan: readonly PlannedExercise[],
  settings: Settings,
  effortScale = plannedEffortScale(plan),
): string {
  const title = name.trim();
  if (!title || title.length > LIMITS.titleLength) {
    throw new Error(`Enter a routine name of 1–${LIMITS.titleLength} characters.`);
  }
  if (!plan.length) throw new Error("Add an exercise to the routine.");
  if (folderId) {
    const folder = store.get("routine_folder", folderId);
    if (!folder?.content || folder.deleted) throw new Error("Choose an available folder.");
  }
  const exercises = writePlan(plan, settings, effortScale);
  const position = nextRoutinePosition(store, folderId);
  const id = newId();
  store.put("routine", id, { title, folderId, position, exercises, effortScale });
  return id;
}

/**
 * The position after the last routine of the group Train shows in that folder. Without one, that
 * group includes the routines whose folder is gone.
 */
export function nextRoutinePosition(store: DeviceStore, folderId: string | null): number {
  const folders = new Set(
    store
      .list("routine_folder")
      .filter((row) => row.content && !row.deleted)
      .map((row) => row.id),
  );
  let last: number | null = null;
  for (const row of store.list("routine")) {
    if (!row.content || row.deleted) continue;
    const filed = typeof row.content.folderId === "string" ? row.content.folderId : null;
    const group = filed && folders.has(filed) ? filed : null;
    const position = row.content.position;
    if (group === folderId && typeof position === "number" && (last === null || position > last))
      last = position;
  }
  return last === null ? 1 : Math.min(last + 1, MAX_POSITION);
}

export function openPlan(exercises: StoredPlan): PlannedExercise[] {
  return exercises.map((original, index) => ({
    id: `opened-${index}`,
    original,
    supersetId: original.supersetId,
    exercise: { id: original.exerciseId, name: original.exerciseName, type: original.exerciseType },
    sets: original.sets.map((set, i) => ({ id: `opened-${i}`, original: set, values: {} })),
  }));
}

function rangePatch(
  min: string | undefined,
  max: string | undefined,
  original: StoredEntry["sets"][number] | undefined,
  activatingRange: boolean,
) {
  if (!activatingRange && min === undefined && max === undefined) return {};
  const repRangeMin =
    min === undefined ? (original?.repRangeMin ?? null) : parseTyped("reps", min, "kg");
  const repRangeMax =
    max === undefined ? (original?.repRangeMax ?? null) : parseTyped("reps", max, "kg");
  if (repRangeMin === "invalid" || repRangeMax === "invalid")
    throw new Error("Enter a whole number for the rep range.");
  if (repRangeMin === null && repRangeMax !== null)
    throw new Error("Enter minimum reps for this range.");
  if (repRangeMin !== null && repRangeMax !== null && repRangeMin > repRangeMax)
    throw new Error("Minimum reps must be at most maximum reps.");
  return { repRangeMin, repRangeMax };
}

export function plannedEffortScale(plan: readonly PlannedExercise[]): EffortScale {
  return routineEffortScale({
    exercises: plan.map(({ sets }) => ({ sets: sets.flatMap(({ original }) => original ?? []) })),
  });
}

export function changePlanEffort(
  plan: readonly PlannedExercise[],
  from: EffortScale,
  to: EffortScale,
) {
  let cleared = 0;
  const next = plan.map((entry) => ({
    ...entry,
    sets: entry.sets.map((set) => {
      const value =
        set.effortText === undefined
          ? effortValue(set.original, from)
          : parseEffort(set.effortText, from);
      if (value === null && set.effortText === undefined && effortValue(set.original, to) === null)
        return set;
      const converted = value === null ? null : equivalentEffort(value, to);
      if (value !== null && converted === null) cleared += 1;
      return { ...set, effortText: converted === null ? "" : String(converted) };
    }),
  }));
  return { next, cleared };
}

export function writePlan(
  plan: readonly PlannedExercise[],
  settings: Settings,
  effortScale = plannedEffortScale(plan),
): StoredPlan {
  return plan.map((entry) => {
    const { id, exercise, sets, original, restSecondsText } = entry;
    const useRepRange = entry.useRepRange ?? original?.useRepRange ?? false;
    if (!original && !sets.length) throw new Error(`Add a set for ${exercise.name}.`);
    const restSeconds =
      restSecondsText === undefined
        ? (original?.restSeconds ?? settings.defaultRestSeconds)
        : parseRestSeconds(restSecondsText);
    if (restSeconds === null) throw new Error(`Enter 0–3600 seconds of rest for ${exercise.name}.`);
    const distanceUnit =
      exercise.type === "distance_duration" ? settings.distanceUnit : settings.shortDistanceUnit;
    return {
      ...(original ?? {
        id,
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        exerciseType: exercise.type,
      }),
      supersetId:
        entry.supersetId === undefined ? (original?.supersetId ?? null) : entry.supersetId,
      restSeconds,
      useRepRange,
      sets: sets.map(
        ({
          id,
          values: { reps, repRangeMin, repRangeMax, ...metrics },
          original,
          type,
          effortText,
        }) => ({
          ...(original ?? {
            id,
            weightKg: null,
            reps: null,
            repRangeMin: null,
            repRangeMax: null,
            durationSeconds: null,
            distanceMeters: null,
            count: null,
            rpe: null,
          }),
          type: type ?? original?.type ?? "normal",
          ...(effortText !== undefined && {
            rpe: effortScale === "rpe" ? parseEffort(effortText, effortScale) : null,
            ...(effortScale === "rir" || original?.repsInReserve != null
              ? {
                  repsInReserve:
                    effortScale === "rir" ? parseEffort(effortText, effortScale) : null,
                }
              : {}),
          }),
          ...(useRepRange &&
            rangePatch(repRangeMin, repRangeMax, original, entry.useRepRange === true)),
          ...correctionValues(
            !useRepRange && reps !== undefined ? { ...metrics, reps } : metrics,
            settings.weightUnit,
            distanceUnit,
          ),
        }),
      ),
    };
  });
}
