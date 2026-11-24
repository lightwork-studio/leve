import type { SetDistanceUnit, SetMetric, WeightUnit } from "@leve/core";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../data/app-data.tsx";
import type { BuiltInExercise } from "../data/exercises.ts";
import {
  addHistoricalSet,
  canRecordSetReserve,
  removeWorkoutSet,
  updateSet,
} from "../data/workout-actions.ts";
import {
  effortField,
  effortLabel,
  effortValue,
  parseEffort,
  setEffortScale,
} from "../model/effort.ts";
import { correctionValues, type Draft, resolveLog, storedValue } from "../model/log-values.ts";
import type { WithId, WorkoutSet } from "../model/types.ts";
import { font, radius, space, type } from "../theme.ts";
import { DestructiveButton } from "./action-sheet.tsx";
import { distanceSuffix } from "./format.ts";
import { SetMetricInput } from "./set-metric-input.tsx";
import { SetTypeChoices } from "./set-type-choices.tsx";
import { inputValue, setColumns } from "./set-values.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

export function SetEditor({
  set,
  exercise,
  rowLabel,
  exerciseType,
  focusMetric,
  addToWorkout,
  newExercise,
  scope,
  unit: currentUnit,
  distanceUnit: currentDistanceUnit,
  onClose,
}: {
  set: WithId<WorkoutSet>;
  exercise: string;
  rowLabel: string;
  exerciseType: string;
  scope?: "active-workout";
  focusMetric?: SetMetric | undefined;
  addToWorkout?: string;
  newExercise?: BuiltInExercise;
  unit: WeightUnit;
  distanceUnit: SetDistanceUnit;
  onClose: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { change, store } = useAppData();
  const [opened] = useState(() => {
    const parent = store.get("workout_exercise", set.content.workoutExerciseId)?.content ?? null;
    const workoutId = addToWorkout ?? parent?.workoutId;
    const plan =
      typeof workoutId === "string" ? store.get("workout", workoutId)?.content?.initialPlan : null;
    const scale =
      plan && typeof plan === "object" && "effortScale" in plan ? plan.effortScale : null;
    const effortScale = setEffortScale(
      set.content,
      scale === "rir" || scale === "rpe" ? scale : undefined,
    );
    return {
      id: set.id,
      values: set.content,
      parent,
      effortScale,
      exercise,
      exerciseType,
      rowLabel,
      unit: currentUnit,
      distanceUnit: currentDistanceUnit,
    } as const;
  });
  const { unit, distanceUnit, effortScale } = opened;
  const canRecordReserve = canRecordSetReserve(store, effortScale);
  const recordedEffort = effortValue(opened.values, effortScale);
  const [reserve, setReserve] = useState<string>();
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState(opened.values.type);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const columns = setColumns(opened.exerciseType, unit);
  const countsReps = columns.some(({ metric }) => metric === "reps");
  const cleared = columns.find(
    ({ metric }) =>
      (metric === "reps" || metric === "duration") &&
      draft[metric]?.trim() === "" &&
      storedValue(opened.values, metric) !== null,
  )?.metric;
  const missingLabel = cleared === "duration" ? "time" : "reps";
  const save = () => {
    try {
      let values: Partial<WorkoutSet>;
      if (addToWorkout) {
        const result = resolveLog({
          set: set.content,
          metrics: columns.map((col) => col.metric),
          draft,
          previous: undefined,
          target: undefined,
          unit,
          distanceUnit,
        });
        if ("error" in result) throw Error(result.error);
        values = result.values;
      } else {
        values = correctionValues(draft, unit, distanceUnit);
      }
      if (reserve !== undefined) {
        values[effortField(effortScale)] = parseEffort(reserve, effortScale);
      }
      if (kind !== opened.values.type) values.type = kind;
      if (addToWorkout || Object.keys(values).length)
        change((store) => {
          if (addToWorkout) {
            addHistoricalSet(
              store,
              addToWorkout,
              opened.exerciseType,
              {
                id: set.id,
                content: { ...set.content, ...values },
              },
              newExercise,
              opened.parent,
            );
            return;
          }
          updateSet(store, set.id, values, opened);
        }, scope);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const editor = (
    <View style={[styles.overlay, { paddingTop: insets.top + space.md }]}>
      <Pressable accessible={false} onPress={onClose} style={StyleSheet.absoluteFill} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={styles.page}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
      >
        <Text style={styles.meta}>
          {opened.exercise}
          {!addToWorkout && ` · Set ${opened.rowLabel}`}
        </Text>
        <Text accessibilityRole="header" style={styles.title}>
          {newExercise ? "First set" : addToWorkout ? "Add set" : "Edit set"}
        </Text>
        {addToWorkout && <Text style={styles.meta}>This set uses the workout’s finish time.</Text>}
        <Text style={styles.label}>Set type</Text>
        <SetTypeChoices value={kind} onChange={setKind} />
        {/* A rep-counted set's values sit side by side, reps in reserve third. */}
        <View style={countsReps && styles.cells}>
          {(addToWorkout || opened.values.completedAt !== null) &&
            columns.map(({ metric, heading }) => {
              const label =
                metric === "distance"
                  ? `Distance (${distanceSuffix(distanceUnit)})`
                  : metric === "duration"
                    ? "Time (m:ss or seconds)"
                    : heading;
              return (
                <View key={metric} style={countsReps && styles.cell}>
                  <Text style={styles.label}>{label}</Text>
                  <SetMetricInput
                    metric={metric}
                    accessibilityLabel={label}
                    autoFocus={focusMetric === metric}
                    onSubmitEditing={save}
                    value={draft[metric] ?? inputValue(opened.values, metric, unit, distanceUnit)}
                    onChangeText={(value) => setDraft((d) => ({ ...d, [metric]: value }))}
                    style={styles.input}
                  />
                </View>
              );
            })}
          {countsReps && (canRecordReserve || recordedEffort !== null) && (
            <View style={styles.cell}>
              <Text style={styles.label}>{effortLabel(effortScale)}</Text>
              <TextInput
                accessibilityLabel={effortScale === "rpe" ? "RPE" : "Reps in reserve"}
                inputMode={effortScale === "rpe" ? "decimal" : "numeric"}
                editable={canRecordReserve}
                value={reserve ?? String(recordedEffort ?? "")}
                onChangeText={setReserve}
                placeholder="–"
                placeholderTextColor={c.fg2}
                style={styles.input}
              />
            </View>
          )}
        </View>
        {cleared && (
          <Text style={styles.error}>
            This set will stay logged with its {missingLabel} missing.
          </Text>
        )}
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Tap accessibilityRole="button" onPress={save} style={[styles.action, styles.selected]}>
          <Text style={[styles.label, styles.selectedLabel]}>
            {newExercise
              ? "Save exercise and set"
              : addToWorkout
                ? "Save set"
                : cleared
                  ? `Save without ${missingLabel}`
                  : "Save changes"}
          </Text>
        </Tap>
        <Tap accessibilityRole="button" onPress={onClose} style={styles.action}>
          <Text style={styles.label}>Cancel</Text>
        </Tap>
        {!addToWorkout && (
          <DestructiveButton
            label="Remove set"
            message={`Set ${opened.rowLabel} of ${opened.exercise} will be removed from this workout.`}
            keep="Keep it"
            busyLabel="Removing…"
            onConfirm={() => {
              try {
                change((store) => removeWorkoutSet(store, set.id, opened), scope);
                onClose();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        )}
      </ScrollView>
    </View>
  );
  return newExercise ? (
    editor
  ) : (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      {editor}
    </Modal>
  );
}

const sheet = themedStyles((c) => ({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: c.scrim },
  page: {
    flexGrow: 0,
    maxHeight: "100%",
    backgroundColor: c.bg,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
  },
  content: { padding: space.xl, gap: space.md },
  meta: { ...font.body, color: c.fg2, fontSize: 15 },
  title: { ...type.title, color: c.fg },
  label: { ...font.bodySemi, fontSize: 16, color: c.fg },
  selected: { backgroundColor: c.fg },
  selectedLabel: { color: c.bg },
  input: {
    backgroundColor: c.s1,
    padding: space.md,
    borderRadius: radius.input,
    ...font.body,
    fontSize: 18,
    color: c.fg,
    marginTop: space.xs,
  },
  action: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.input,
  },
  error: { ...font.body, color: c.alert },
  cells: { flexDirection: "row", gap: space.sm },
  cell: { flex: 1, minWidth: 0 },
}));
