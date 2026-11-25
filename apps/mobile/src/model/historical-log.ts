import type { EffortScale, SetDistanceUnit, SetMetric, SetType, WeightUnit } from "@leve/core";
import { effortField, parseEffort } from "./effort.ts";
import { emptyWorkoutSet } from "./live.ts";
import { type Draft, resolveLog } from "./log-values.ts";
import type { WorkoutSet } from "./types.ts";

/** One set being logged for an exercise added to a finished workout, as typed. */
export type LogRow = { id: string; type: SetType; draft: Draft; effort: string };

const SET_TYPES: SetType[] = ["normal", "warmup", "drop", "failure"];

/** Tapping a set's chip steps through working, warm-up, drop and failure. */
export const nextSetType = (type: SetType): SetType =>
  SET_TYPES[(SET_TYPES.indexOf(type) + 1) % SET_TYPES.length] ?? "normal";

/** A new row repeats the one above it, except that a warm-up is followed by a working set. */
export function followingRow(rows: readonly LogRow[], id: string): LogRow {
  const last = rows.at(-1);
  return {
    id,
    type: !last || last.type === "warmup" ? "normal" : last.type,
    draft: { ...last?.draft },
    effort: "",
  };
}

/** A row with nothing typed in it is left out when saving. */
export const blankRow = (row: LogRow) =>
  !row.effort.trim() && Object.values(row.draft).every((value) => !value?.trim());

/**
 * The sets an exercise's rows log, in order, skipping blank rows. Refuses an exercise with no set
 * and any set its type can't log, naming the exercise and the row as it is shown. Effort typed
 * while it could be recorded is dropped once it can't.
 */
export function resolveRows(
  rows: readonly LogRow[],
  options: {
    exercise: string;
    /** The entry the sets will belong to. */
    entryId: string;
    metrics: readonly SetMetric[];
    unit: WeightUnit;
    distanceUnit: SetDistanceUnit;
    effortScale: EffortScale;
    recordsEffort: boolean;
  },
): { sets: { id: string; content: WorkoutSet }[] } | { error: string } {
  const shown = options.recordsEffort ? rows : rows.map((row) => ({ ...row, effort: "" }));
  if (shown.every(blankRow)) return { error: `Enter a set for ${options.exercise}.` };
  const sets: { id: string; content: WorkoutSet }[] = [];
  for (const [index, row] of shown.entries()) {
    if (blankRow(row)) continue;
    const where = `${options.exercise}, set ${index + 1}`;
    const set = { ...emptyWorkoutSet(options.entryId), type: row.type };
    const result = resolveLog({
      set,
      metrics: options.metrics,
      draft: row.draft,
      previous: undefined,
      target: undefined,
      unit: options.unit,
      distanceUnit: options.distanceUnit,
    });
    if ("error" in result) return { error: `${where}: ${result.error}` };
    const content: WorkoutSet = { ...set, ...result.values };
    if (row.effort.trim()) {
      try {
        content[effortField(options.effortScale)] = parseEffort(row.effort, options.effortScale);
      } catch (cause) {
        return { error: `${where}: ${(cause as Error).message}` };
      }
    }
    sets.push({ id: row.id, content });
  }
  return { sets };
}
