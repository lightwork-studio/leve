import { EFFORT_SCALES, type EffortScale, type SetMetric, type WeightUnit } from "@leve/core";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { newId } from "../data/ids.ts";
import { effortLabel, effortValue } from "../model/effort.ts";
import { emptyWorkoutSet } from "../model/live.ts";
import { measurementName, missingMeasurements } from "../model/log-values.ts";
import type { RecordedSet } from "../model/past-workouts.ts";
import { estimatedOneRepMax } from "../model/progress.ts";
import type { WithId, WorkoutSet } from "../model/types.ts";
import { numeral, touch, type } from "../theme.ts";
import { type DistancePreferences, distanceUnitFor, wholeWeight } from "./format.ts";
import { PlusIcon } from "./icons.tsx";
import { SetChip, setLabel, setNumbers } from "./set-chip.tsx";
import { SetEditor } from "./set-editor.tsx";
import { SetSyncReview } from "./set-sync-review.tsx";
import { setCell, setColumns } from "./set-values.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * An exercise's sets as logged: a chip (W, D, F or the working-set number) and the values its type
 * records. Sets that weren't completed are greyed. Weight-and-reps sets also show their estimated
 * one-rep max at the end.
 */
export function SetTable({
  workoutId,
  type,
  sets,
  editableExercise,
  addTo,
  unit,
  prefs,
  effortScale,
}: {
  workoutId: string;
  type: string;
  editableExercise?: string;
  addTo?: { workoutId: string; entryId: string };
  sets: RecordedSet[];
  unit: WeightUnit;
  prefs: DistancePreferences;
  effortScale?: EffortScale | null | undefined;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [editing, setEditing] = useState<{ id: string; metric?: SetMetric } | null>(null);
  const [newSet, setNewSet] = useState<WithId<WorkoutSet> | null>(null);
  const selected = sets.find((s) => s.id === editing?.id);
  useEffect(() => {
    if (selected?.needsSyncReview) setEditing(null);
  }, [selected?.needsSyncReview]);
  const cols = setColumns(type, unit);
  const numbers = setNumbers(sets);
  const effortColumns = (effortScale ? [effortScale] : EFFORT_SCALES).filter((scale) =>
    sets.some(({ content }) => effortValue(content, scale) !== null),
  );
  const showEstimate = type === "weight_reps";
  return (
    <View>
      <View style={[styles.row, styles.headRow]}>
        <Text style={[styles.headCell, styles.setCol]}>SET</Text>
        {cols.map((col) => (
          <Text key={col.metric} style={[styles.headCell, styles.valueCol]}>
            {col.heading}
          </Text>
        ))}
        {effortColumns.map((scale) => (
          <Text
            key={scale}
            accessibilityLabel={scale === "rir" ? "Reps in reserve" : "RPE"}
            style={[styles.headCell, styles.valueCol]}
          >
            {effortLabel(scale)}
          </Text>
        ))}
        {showEstimate && (
          <Text
            accessibilityLabel="Estimated one-rep max"
            style={[styles.headCell, styles.valueCol, styles.end]}
          >
            E1RM
          </Text>
        )}
      </View>
      {sets.map((set, i) => {
        if (set.needsSyncReview) {
          return (
            <SetSyncReview
              key={set.id}
              workoutId={workoutId}
              id={set.id}
              entryId={set.content.workoutExerciseId}
              label={setLabel(set.content.type, numbers[i] ?? 0)}
            />
          );
        }
        const done = set.content.completedAt !== null;
        const missing = missingMeasurements(type, set.content);
        return (
          <View key={set.id} style={[styles.row, styles.divider]}>
            <View style={styles.setCol}>
              {editableExercise ? (
                <Tap
                  accessibilityRole="button"
                  accessibilityLabel={`Edit set ${setLabel(set.content.type, numbers[i] ?? 0)}`}
                  onPress={() => setEditing({ id: set.id })}
                >
                  <SetChip type={set.content.type} number={numbers[i] ?? 0} />
                </Tap>
              ) : (
                <SetChip type={set.content.type} number={numbers[i] ?? 0} />
              )}
            </View>
            {cols.map((col) => (
              <Text
                key={col.metric}
                accessibilityRole={editableExercise && done ? "button" : undefined}
                onPress={
                  editableExercise && done
                    ? () => setEditing({ id: set.id, metric: col.metric })
                    : undefined
                }
                style={[
                  styles.value,
                  styles.valueCol,
                  !done && styles.skipped,
                  missing.includes(col.metric) && styles.missing,
                ]}
              >
                {missing.includes(col.metric)
                  ? (editableExercise ? "Add " : "Missing ") + measurementName(col.metric, type)
                  : setCell(set.content, col.metric, unit, prefs)}
              </Text>
            ))}
            {effortColumns.map((scale) => (
              <Text key={scale} style={[styles.value, styles.valueCol]}>
                {effortValue(set.content, scale) ?? "–"}
              </Text>
            ))}
            {showEstimate && (
              <Text style={[styles.estimate, styles.valueCol, styles.end, !done && styles.skipped]}>
                {estimateText(
                  set.content.weightKg,
                  set.content.reps,
                  unit,
                  !done || set.content.type === "warmup",
                )}
              </Text>
            )}
          </View>
        );
      })}
      {editableExercise && addTo && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`Add set to ${editableExercise}`}
          onPress={() => setNewSet({ id: newId(), content: emptyWorkoutSet(addTo.entryId) })}
          scaleTo={0.98}
          style={styles.add}
        >
          <PlusIcon color={c.fg2} size={15} strokeWidth={2} />
          <Text style={styles.addLabel}>Add set</Text>
        </Tap>
      )}
      {editableExercise && addTo && newSet && (
        <SetEditor
          set={newSet}
          exercise={editableExercise}
          rowLabel="new"
          addToWorkout={addTo.workoutId}
          exerciseType={type}
          unit={unit}
          distanceUnit={distanceUnitFor(0, prefs)}
          onClose={() => setNewSet(null)}
        />
      )}
      {editableExercise && selected && !selected.needsSyncReview && (
        <SetEditor
          set={selected}
          focusMetric={editing?.metric}
          rowLabel={setLabel(selected.content.type, numbers[sets.indexOf(selected)] ?? 0)}
          exercise={editableExercise}
          exerciseType={type}
          unit={unit}
          distanceUnit={distanceUnitFor(selected.content.distanceMeters ?? 0, prefs)}
          onClose={() => setEditing(null)}
        />
      )}
    </View>
  );
}

/** A set's estimated one-rep max in the unit shown, or a dash when it has none (or is a warm-up or wasn't logged). */
function estimateText(
  weightKg: number | null,
  reps: number | null,
  unit: WeightUnit,
  skipped: boolean,
) {
  const kg = skipped ? null : estimatedOneRepMax(weightKg, reps);
  return kg === null ? "—" : wholeWeight(kg, unit);
}

const sheet = themedStyles((c) => ({
  add: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 46,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  addLabel: { ...type.action, letterSpacing: 1.47, color: c.fg2 },
  end: { textAlign: "right" },
  estimate: { ...type.value, color: c.fg2 },
  row: { flexDirection: "row", alignItems: "center", minHeight: touch },
  headRow: { minHeight: 24 },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  headCell: { ...type.labelSmall, fontWeight: "500", color: c.fg3 },
  setCol: { width: 64 },
  valueCol: { flex: 1, textAlign: "center" },
  value: { ...numeral(22), color: c.fg },
  missing: { ...type.meta, fontSize: 12, color: c.alert },
  skipped: { color: c.fg3 },
}));
