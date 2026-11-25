import type { EffortScale, SetDistanceUnit, WeightUnit } from "@leve/core";
import { useMemo, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import type { PickerExercise } from "../data/exercises.ts";
import { newId } from "../data/ids.ts";
import { usePastWorkouts } from "../data/queries.ts";
import { addHistoricalExercises, canRecordSetReserve } from "../data/workout-actions.ts";
import { effortLabel } from "../model/effort.ts";
import {
  blankRow,
  followingRow,
  type LogRow,
  nextSetType,
  resolveRows,
} from "../model/historical-log.ts";
import { sessionBefore } from "../model/live.ts";
import type { WorkoutSet } from "../model/types.ts";
import { numeral, radius, space, touch, type } from "../theme.ts";
import { Button } from "./buttons.tsx";
import { ExercisePicker } from "./exercise-picker.tsx";
import { FieldError } from "./field.tsx";
import { type DistancePreferences, dayLabel, distanceUnitFor } from "./format.ts";
import { CloseIcon, PlusIcon } from "./icons.tsx";
import { SetChip, setLabel, setNumbers } from "./set-chip.tsx";
import { SetMetricInput } from "./set-metric-input.tsx";
import { setTypeNames } from "./set-type-choices.tsx";
import { inputValue, sessionSetLabel, setColumns } from "./set-values.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

type Drafted = { entryId: string; rows: LogRow[] };

const blank = (): LogRow => followingRow([], newId());
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Adding exercises to a finished workout: choose them as in Train, then log each one's sets on
 * the next page of the same sheet, starting from the session before this one if wanted. One save
 * adds them all with their sets, or nothing.
 */
export function AddPastExercises({
  workoutId,
  startedAt,
  eyebrow,
  included,
  effortScale,
  unit,
  prefs,
  onClose,
}: {
  workoutId: string;
  startedAt: string;
  eyebrow: string;
  included: string[];
  effortScale: EffortScale;
  unit: WeightUnit;
  prefs: DistancePreferences;
  onClose: () => void;
}) {
  const distanceUnit = distanceUnitFor(0, prefs);
  const styles = useStyles(sheet);
  const { change, store } = useAppData();
  const history = usePastWorkouts(true);
  // The session before this one, looked up once per exercise rather than on every keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new history read starts afresh.
  const earlier = useMemo(() => new Map<string, ReturnType<typeof sessionBefore>>(), [history]);
  const sessionFor = (exerciseId: string) => {
    if (!earlier.has(exerciseId))
      earlier.set(
        exerciseId,
        sessionBefore(history ?? [], exerciseId, { before: startedAt, exceptWorkoutId: workoutId }),
      );
    return earlier.get(exerciseId) ?? null;
  };
  const [drafts, setDrafts] = useState<Record<string, Drafted>>({});
  const [error, setError] = useState("");
  // Each exercise starts with one empty set; its ids stay put so a repeated save adds nothing.
  const fresh = useRef(new Map<string, Drafted>());
  const draftFor = (id: string): Drafted => {
    const drafted = drafts[id] ?? fresh.current.get(id);
    if (drafted) return drafted;
    const created = { entryId: newId(), rows: [blank()] };
    fresh.current.set(id, created);
    return created;
  };
  const update = (id: string, rows: (current: LogRow[]) => LogRow[]) => {
    setError("");
    setDrafts((current) => {
      const drafted = current[id] ?? draftFor(id);
      return { ...current, [id]: { ...drafted, rows: rows(drafted.rows) } };
    });
  };
  const recordsEffort = canRecordSetReserve(store, effortScale);
  const saved = useRef(false);
  const save = (selected: PickerExercise[]) => {
    if (saved.current) return;
    try {
      const additions = selected.map((exercise) => {
        const { entryId, rows } = draftFor(exercise.id);
        const resolved = resolveRows(rows, {
          exercise: exercise.name,
          entryId,
          metrics: setColumns(exercise.type, unit).map(({ metric }) => metric),
          unit,
          distanceUnit,
          effortScale,
          recordsEffort:
            recordsEffort &&
            setColumns(exercise.type, unit).some(({ metric }) => metric === "reps"),
        });
        if ("error" in resolved) throw Error(resolved.error);
        return { entryId, exercise, sets: resolved.sets };
      });
      change((db) => addHistoricalExercises(db, workoutId, additions));
      saved.current = true;
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  return (
    <ExercisePicker
      included={included}
      includedLabel="In this workout"
      eyebrow={eyebrow}
      onClose={onClose}
      next={{
        title: "Log sets",
        backLabel: "Exercises",
        render: (selected) => {
          const sets = selected.reduce(
            (total, { id }) => total + draftFor(id).rows.filter((row) => !blankRow(row)).length,
            0,
          );
          return {
            body: (
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
              >
                {selected.map((exercise) => (
                  <ExerciseLog
                    key={exercise.id}
                    exercise={exercise}
                    rows={draftFor(exercise.id).rows}
                    before={sessionFor(exercise.id)}
                    recordsEffort={recordsEffort}
                    effortScale={effortScale}
                    unit={unit}
                    prefs={prefs}
                    distanceUnit={distanceUnit}
                    onChange={(rows) => update(exercise.id, rows)}
                  />
                ))}
              </ScrollView>
            ),
            footer: (
              <>
                <FieldError message={error} />
                <Button
                  rank="primary"
                  label={`Save · ${plural(selected.length, "exercise")} · ${plural(sets, "set")}`}
                  onPress={() => save(selected)}
                />
              </>
            ),
          };
        },
      }}
    />
  );
}

/** One chosen exercise: the session before this one, and a row for each set to log. */
function ExerciseLog({
  exercise,
  rows,
  before,
  recordsEffort,
  effortScale,
  unit,
  prefs,
  distanceUnit,
  onChange,
}: {
  exercise: PickerExercise;
  rows: LogRow[];
  before: ReturnType<typeof sessionBefore>;
  recordsEffort: boolean;
  effortScale: EffortScale;
  unit: WeightUnit;
  prefs: DistancePreferences;
  distanceUnit: SetDistanceUnit;
  onChange: (rows: (current: LogRow[]) => LogRow[]) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const columns = setColumns(exercise.type, unit);
  const showEffort = recordsEffort && columns.some(({ metric }) => metric === "reps");
  const numbers = setNumbers(rows.map((row) => ({ content: { type: row.type } })));
  // The heaviest set that wasn't a warm-up stands for the session.
  const top =
    before?.sets
      .filter((set) => set.type !== "warmup")
      .reduce<WorkoutSet | undefined>(
        (heaviest, set) =>
          !heaviest || (set.weightKg ?? 0) > (heaviest.weightKg ?? 0) ? set : heaviest,
        undefined,
      ) ?? before?.sets[0];
  const edit = (id: string, change: (row: LogRow) => LogRow) =>
    onChange((current) => current.map((row) => (row.id === id ? change(row) : row)));
  const copy = () => {
    if (!before) return;
    onChange(() =>
      before.sets.map((set) => ({
        id: newId(),
        type: set.type,
        draft: Object.fromEntries(
          columns.map(({ metric }) => [metric, inputValue(set, metric, unit, distanceUnit)]),
        ),
        effort: "",
      })),
    );
  };
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.name} numberOfLines={1}>
        {exercise.name}
      </Text>
      <View style={styles.before}>
        <Text style={styles.meta} numberOfLines={2}>
          {before && top
            ? `Before this: ${dayLabel(before.startedAt)} · ${plural(before.sets.length, "set")} · top ${sessionSetLabel(exercise.type, top, unit, prefs)}`
            : "No earlier sessions"}
        </Text>
        {before && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Copy ${exercise.name} from ${dayLabel(before.startedAt)}`}
            onPress={copy}
            scaleTo={0.96}
            style={styles.copy}
          >
            <Text style={styles.copyLabel}>Copy</Text>
          </Tap>
        )}
      </View>
      <View style={[styles.row, styles.headRow]}>
        <Text style={[styles.head, styles.setCol]}>SET</Text>
        {columns.map(({ metric, heading }) => (
          <Text key={metric} style={[styles.head, styles.valueCol]}>
            {heading}
          </Text>
        ))}
        {showEffort && (
          <Text style={[styles.head, styles.valueCol]}>{effortLabel(effortScale)}</Text>
        )}
        <View style={styles.removeCol} />
      </View>
      {rows.map((row, index) => {
        const label = setLabel(row.type, numbers[index] ?? 0);
        const name = `${exercise.name} set ${index + 1}`;
        return (
          <View key={row.id} style={[styles.row, styles.divider]}>
            <View style={styles.setCol}>
              <Tap
                accessibilityRole="button"
                accessibilityLabel={`${name}, ${setTypeNames[row.type]}`}
                accessibilityHint="Changes the set type"
                onPress={() => edit(row.id, (r) => ({ ...r, type: nextSetType(r.type) }))}
                scaleTo={0.92}
              >
                <SetChip type={row.type} number={numbers[index] ?? 0} />
              </Tap>
            </View>
            {columns.map(({ metric, heading }) => (
              <View key={metric} style={styles.valueCol}>
                <SetMetricInput
                  metric={metric}
                  accessibilityLabel={`${name} ${heading}`}
                  value={row.draft[metric] ?? ""}
                  onChangeText={(value) =>
                    edit(row.id, (r) => ({ ...r, draft: { ...r.draft, [metric]: value } }))
                  }
                  placeholder={metric === "duration" ? "m:ss" : "–"}
                  placeholderTextColor={c.fg3}
                  style={styles.input}
                />
              </View>
            ))}
            {showEffort && (
              <View style={styles.valueCol}>
                <TextInput
                  accessibilityLabel={`${name} ${effortScale === "rpe" ? "RPE" : "reps in reserve"}`}
                  inputMode={effortScale === "rpe" ? "decimal" : "numeric"}
                  value={row.effort}
                  onChangeText={(effort) => edit(row.id, (r) => ({ ...r, effort }))}
                  placeholder="–"
                  placeholderTextColor={c.fg3}
                  style={styles.input}
                />
              </View>
            )}
            <Tap
              accessibilityRole="button"
              accessibilityLabel={`Remove ${exercise.name} set ${label}`}
              onPress={() => onChange((current) => current.filter((r) => r.id !== row.id))}
              scaleTo={0.9}
              style={styles.removeCol}
            >
              <CloseIcon color={c.fg3} size={13} />
            </Tap>
          </View>
        );
      })}
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Add set to ${exercise.name}`}
        onPress={() => onChange((current) => [...current, followingRow(current, newId())])}
        scaleTo={0.98}
        style={styles.add}
      >
        <PlusIcon color={c.fg2} size={15} strokeWidth={2} />
        <Text style={styles.addLabel}>Add set</Text>
      </Tap>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 12, paddingBottom: space.lg, gap: space.md },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  name: { ...type.rowTitle, color: c.fg },
  before: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: touch,
  },
  meta: { ...type.meta, color: c.fg3, flex: 1, minWidth: 0 },
  copy: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  copyLabel: { ...type.action, color: c.fg },
  row: { flexDirection: "row", alignItems: "center", minHeight: touch, gap: 6 },
  headRow: { minHeight: 24 },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  head: { ...type.labelSmall, fontWeight: "500", color: c.fg3, textAlign: "center" },
  setCol: { width: 44 },
  valueCol: { flex: 1, minWidth: 0 },
  removeCol: { width: 32, height: touch, alignItems: "center", justifyContent: "center" },
  input: {
    ...numeral(20, "300"),
    height: 38,
    textAlign: "center",
    color: c.fg,
    backgroundColor: c.bg,
    borderRadius: 10,
    // Its own ring shows while typing; browsers would add a second one.
    outlineWidth: 0,
  },
  add: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 46,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  addLabel: { ...type.action, letterSpacing: 1.47, color: c.fg2 },
}));
