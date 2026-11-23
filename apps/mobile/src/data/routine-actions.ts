import type { RecordContent } from "@leve/contract";
import { LIMITS, RPE_VALUES } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { correctionValues, type Draft, parseTyped } from "../model/log-values.ts";
import type { Settings } from "../model/types.ts";
import type { BuiltInExercise } from "./exercises.ts";
import { newId } from "./ids.ts";
import { parseRestSeconds } from "./settings-actions.ts";

export type StoredPlan = RecordContent<"routine">["exercises"];
type StoredEntry = StoredPlan[number];

export const MAX_EXERCISE_CUES = 100;

export interface PlannedCue {
  key: string;
  note: StoredEntry["notes"][number];
  originalText?: string;
}

export interface PlannedExercise {
  id: string;
  exercise: BuiltInExercise;
  original?: StoredEntry;
  supersetId?: number | null;
  cues?: PlannedCue[];
  restSecondsText?: string;
  useRepRange?: boolean;
  sets: {
    id: string;
    original?: StoredEntry["sets"][number];
    type?: StoredEntry["sets"][number]["type"];
    rpeText?: string;
    values: Draft & { repRangeMin?: string; repRangeMax?: string };
  }[];
}

export function createRoutine(
  store: DeviceStore,
  name: string,
  folderId: string | null,
  plan: readonly PlannedExercise[],
  settings: Settings,
  notes = "",
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
  const exercises = writePlan(plan, settings);
  const existing = store.list("routine").filter((r) => r.content?.folderId === folderId);
  const last = existing.at(-1)?.content?.position;
  const position = typeof last === "number" ? Math.min(last + 1, 1e15) : 1;
  const id = newId();
  store.put("routine", id, { title, folderId, position, notes, exercises });
  return id;
}

export function openPlan(exercises: StoredPlan): PlannedExercise[] {
  return exercises.map((original, index) => ({
    id: `opened-${index}`,
    original,
    supersetId: original.supersetId,
    cues: original.notes.map((note, index) => ({
      key: `opened-${index}`,
      note,
      originalText: note.text,
    })),
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

function targetRpe(text: string) {
  const value = text.trim().replace(",", ".");
  if (!value) return null;
  const target = RPE_VALUES.find((rpe) => rpe === Number(value));
  if (target === undefined || !/^\d+(?:\.\d+)?$/.test(value))
    throw new Error(`Choose a target RPE of ${RPE_VALUES.join(", ")} or leave it empty.`);
  return target;
}

export function writePlan(plan: readonly PlannedExercise[], settings: Settings): StoredPlan {
  return plan.map((entry) => {
    const { id, exercise, sets, original, restSecondsText } = entry;
    const useRepRange = entry.useRepRange ?? original?.useRepRange ?? false;
    if (!original && !sets.length) throw new Error(`Add a set for ${exercise.name}.`);
    const restSeconds =
      restSecondsText === undefined
        ? (original?.restSeconds ?? settings.defaultRestSeconds)
        : parseRestSeconds(restSecondsText);
    if (restSeconds === null) throw new Error(`Enter 0–3600 seconds of rest for ${exercise.name}.`);
    if (entry.cues && entry.cues.length > MAX_EXERCISE_CUES)
      throw new Error(`Use at most ${MAX_EXERCISE_CUES} cues for ${exercise.name}.`);
    const notes = entry.cues?.map(({ note, originalText }) => {
      if (note.text === originalText) return note;
      const text = note.text.trim();
      if (!text || text.length > LIMITS.noteLength)
        throw new Error(
          `Enter a cue of 1–${LIMITS.noteLength} characters for ${exercise.name}, or remove it.`,
        );
      return { ...note, text };
    });
    const distanceUnit =
      exercise.type === "distance_duration" ? settings.distanceUnit : settings.shortDistanceUnit;
    return {
      ...(original ?? {
        id,
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        exerciseType: exercise.type,
        notes: [],
      }),
      supersetId:
        entry.supersetId === undefined ? (original?.supersetId ?? null) : entry.supersetId,
      ...(notes && { notes }),
      restSeconds,
      useRepRange,
      sets: sets.map(
        ({
          id,
          values: { reps, repRangeMin, repRangeMax, ...metrics },
          original,
          type,
          rpeText,
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
          ...(rpeText !== undefined && { rpe: targetRpe(rpeText) }),
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
