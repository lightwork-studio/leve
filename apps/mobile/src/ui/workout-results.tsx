import type { ExerciseType, WeightUnit } from "@leve/core";
import { Text, View } from "react-native";
import type { BarcodeSet } from "../model/barcode.ts";
import type { ExerciseMetric } from "../model/progress.ts";
import type { ExerciseChange, VersusLastTime } from "../model/session-compare.ts";
import type { Settings } from "../model/types.ts";
import type { BestSet, loggedExercises } from "../model/workout-done.ts";
import { numeral, radius, space, type } from "../theme.ts";
import { SetBarcode } from "./barcode.tsx";
import { metricParts, recordName } from "./exercise-metrics.ts";
import { durationLabel, shortDay, weightValue } from "./format.ts";
import { Group } from "./group.tsx";
import { ArrowIcon } from "./icons.tsx";
import { RecordMark } from "./record-mark.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** Records an exercise reached in a workout, each with the best it beat (null the first time). */
export interface ExerciseRecords {
  exerciseId: string;
  exerciseName: string;
  type: ExerciseType;
  records: { metric: ExerciseMetric; value: number; before: number | null }[];
}

/**
 * What a workout reached, leading its summary: its records first, each saying what it beat, in
 * brass. Without any, how it compares with last time takes their place, in plain ink.
 */
export function WorkoutResults({
  records,
  versus,
  last,
  best,
  settings,
}: {
  records: readonly ExerciseRecords[];
  versus: VersusLastTime | null;
  last: { title: string; startedAt: string } | null;
  best: BestSet | null;
  settings: Settings;
}) {
  const styles = useStyles(sheet);
  const unit = settings.weightUnit;
  const count = records.reduce((sum, group) => sum + group.records.length, 0);
  if (!count) {
    return versus ? <VersusCard versus={versus} last={last} settings={settings} /> : null;
  }
  return (
    <View style={styles.group}>
      <View style={styles.card}>
        <View
          accessible
          accessibilityLabel={`${count} new ${count === 1 ? "record" : "records"}`}
          style={styles.lead}
        >
          <Text style={[styles.leadNumber, styles.record]}>{count}</Text>
          <View style={styles.leadKey}>
            <Text style={[styles.label, styles.record]}>
              New {count === 1 ? "record" : "records"}
            </Text>
            <Text style={styles.label}>Each beats your best before this workout</Text>
          </View>
        </View>
        {records.flatMap(({ exerciseId, exerciseName, type: exerciseType, records: held }) =>
          held.map((record) => {
            const [value, valueUnit] = metricParts(record.metric, record.value, unit, settings);
            const was =
              record.before === null
                ? "first time"
                : `was ${metricParts(record.metric, record.before, unit, settings)
                    .filter(Boolean)
                    .join(" ")}`;
            const from =
              record.metric === "oneRepMax" && best?.exerciseId === exerciseId
                ? `from ${weightValue(best.weightKg, unit)} ${unit} × ${best.reps}`
                : null;
            const name = recordName(record.metric, exerciseType);
            return (
              <View
                key={`${exerciseId}-${record.metric}`}
                accessible
                accessibilityLabel={`${exerciseName}, ${name} record, ${[value, valueUnit].filter(Boolean).join(" ")}, ${was}`}
                style={[styles.row, styles.divider]}
              >
                <RecordMark />
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {exerciseName}
                  </Text>
                  <Text style={styles.rowDetail} numberOfLines={1}>
                    {[name, from].filter(Boolean).join(" · ")} ·{" "}
                    <Text style={styles.was}>{was}</Text>
                  </Text>
                </View>
                <Text style={[styles.rowNumber, styles.record]}>
                  {value}
                  {valueUnit ? <Text style={styles.unit}> {valueUnit}</Text> : null}
                </Text>
              </View>
            );
          }),
        )}
      </View>
    </View>
  );
}

/**
 * Without records: how many exercises went up on the last time each was done, the volume change
 * since the routine's last session, and what went up. In plain ink; records alone are brass.
 */
function VersusCard({
  versus,
  last,
  settings,
}: {
  versus: VersusLastTime;
  last: { title: string; startedAt: string } | null;
  settings: Settings;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const unit = settings.weightUnit;
  const up = versus.up.length;
  const matched = !up && !versus.down.length && versus.same.length > 0;
  const percent = versus.volume?.percent;
  const volume =
    percent === undefined
      ? null
      : `volume ${percent > 0 ? "+" : percent < 0 ? "−" : "±"}${Math.abs(percent)}%`;
  const since =
    last && versus.volume ? `${last.title} · ${shortDay(Date.parse(last.startedAt))}` : null;
  const heading = matched
    ? "Matched last time"
    : `${up === 1 ? "Exercise" : "Exercises"} up on last time`;
  const names = (list: ExerciseChange[]) => list.map((change) => change.exerciseName).join(", ");
  return (
    <View style={styles.group}>
      <View style={styles.card}>
        <View
          accessible
          accessibilityLabel={[
            matched ? "Matched last time" : `${up} ${heading.toLowerCase()}`,
            volume && since ? `${volume} on ${since}` : volume,
          ]
            .filter(Boolean)
            .join(", ")}
          style={styles.lead}
        >
          <Text style={styles.leadNumber}>{matched ? "±0" : up}</Text>
          <View style={styles.leadKey}>
            <Text style={[styles.label, styles.strong]}>{heading}</Text>
            {(since || volume) && (
              <Text style={styles.label}>{[since, volume].filter(Boolean).join(" · ")}</Text>
            )}
          </View>
        </View>
        {versus.up.map((change) => {
          const [now, nowUnit] = metricParts(change.metric, change.now, unit, settings);
          const was = metricParts(change.metric, change.before, unit, settings)
            .filter(Boolean)
            .join(" ");
          const [gain, gainUnit] = increase(change, unit, settings);
          const name = recordName(change.metric, change.type as ExerciseType);
          return (
            <View
              key={change.exerciseId}
              accessible
              accessibilityLabel={`${change.exerciseName}, ${name} up ${[gain, gainUnit].filter(Boolean).join(" ")}, ${[now, nowUnit].filter(Boolean).join(" ")}, was ${was}`}
              style={[styles.row, styles.divider]}
            >
              <ArrowIcon direction="up" color={c.fg} size={14} strokeWidth={2.6} />
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {change.exerciseName}
                </Text>
                <Text style={styles.rowDetail} numberOfLines={1}>
                  {name} · <Text style={styles.was}>was {was}</Text>
                </Text>
              </View>
              <Text style={styles.rowNumber}>
                +{gain}
                {gainUnit ? <Text style={styles.unit}> {gainUnit}</Text> : null}
              </Text>
            </View>
          );
        })}
        {(versus.same.length > 0 || versus.down.length > 0) && (
          <View style={styles.versusTail}>
            {versus.same.length > 0 && (
              <Text style={styles.tailText}>
                Same as last time · <Text style={styles.tailNames}>{names(versus.same)}</Text>
              </Text>
            )}
            {versus.down.length > 0 && (
              <Text style={styles.tailText}>
                Below last time · <Text style={styles.tailNames}>{names(versus.down)}</Text>
              </Text>
            )}
          </View>
        )}
      </View>
      <Text style={styles.footnote}>
        No records this time. Each exercise is compared with the last time you did it.
      </Text>
    </View>
  );
}

/** How much an exercise went up, in its measure's unit. */
function increase(change: ExerciseChange, unit: WeightUnit, settings: Settings) {
  return metricParts(change.metric, change.now - change.before, unit, settings);
}

/**
 * Each exercise done, with its sets as a barcode in front of last time's, and a key under them.
 */
export function ExercisesCompared({
  exercises,
  bars,
  best,
  unit,
}: {
  exercises: ReturnType<typeof loggedExercises>;
  bars: ReadonlyMap<string, BarcodeSet[]>;
  best: BestSet | null;
  unit: WeightUnit;
}) {
  const styles = useStyles(sheet);
  const sets = (n: number) => `${n} ${n === 1 ? "set" : "sets"}`;
  return (
    <>
      <Group
        label={`Exercises · ${exercises.length}`}
        aside="This time vs last"
        style={styles.flatGroup}
      >
        {exercises.map((exercise, i) => {
          const marks = bars.get(exercise.id) ?? [];
          const holdsRecord = marks.some((bar) => bar.record);
          const bestHere = best?.entryId === exercise.id ? best : null;
          const detail = [
            exercise.otherSets > 0 && sets(exercise.otherSets),
            exercise.warmups > 0 &&
              `${exercise.warmups} ${exercise.warmups === 1 ? "warm-up" : "warm-ups"}`,
            exercise.seconds !== null &&
              (exercise.partialTime
                ? `${durationLabel(exercise.seconds)} recorded (partial)`
                : durationLabel(exercise.seconds)),
            bestHere && `best ${weightValue(bestHere.weightKg, unit)} ${unit} × ${bestHere.reps}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <View
              key={exercise.id}
              accessible
              accessibilityLabel={`${exercise.name}${holdsRecord ? ", record" : ""}, ${detail}`}
              style={[styles.row, i > 0 && styles.divider]}
            >
              <View style={styles.rowMain}>
                <View style={styles.nameLine}>
                  <Text style={[styles.rowTitle, styles.shrink]} numberOfLines={1}>
                    {exercise.name}
                  </Text>
                  {holdsRecord && <RecordMark small />}
                </View>
                <Text style={styles.rowDetail} numberOfLines={1}>
                  {detail}
                </Text>
              </View>
              <SetBarcode exercises={[marks]} variant="compare" />
            </View>
          );
        })}
      </Group>
      <View style={styles.legend}>
        <LegendItem kind="now" label="This time" />
        <LegendItem kind="last" label="Last time" />
        <LegendItem kind="record" label="Record" />
      </View>
    </>
  );
}

/** One swatch of the barcode key. */
function LegendItem({ kind, label }: { kind: "now" | "last" | "record"; label: string }) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.legendItem}>
      <View
        style={[
          styles.swatch,
          kind === "now"
            ? styles.swatchNow
            : kind === "last"
              ? styles.swatchLast
              : styles.swatchRecord,
        ]}
      />
      <Text style={styles.footnoteText}>{label}</Text>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  label: { ...type.label, color: c.fg3 },
  strong: { color: c.fg },
  record: { color: c.record },
  group: { marginHorizontal: 14, marginBottom: 22 },
  flatGroup: { marginBottom: 0 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  lead: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 14,
    paddingTop: space.lg,
    paddingBottom: space.md,
    paddingHorizontal: space.lg,
  },
  leadNumber: { ...numeral(64), color: c.fg },
  leadKey: { flex: 1, minWidth: 0, gap: 6, paddingBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  rowMain: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: space.sm },
  shrink: { flexShrink: 1 },
  rowTitle: { ...type.rowTitle, color: c.fg },
  rowDetail: { ...type.meta, color: c.fg3, marginTop: 4 },
  was: { color: c.fg2 },
  rowNumber: { ...numeral(24), color: c.fg, textAlign: "right" },
  unit: { ...type.unit, color: c.fg3 },
  versusTail: {
    gap: 2,
    paddingTop: space.md,
    paddingBottom: 14,
    paddingHorizontal: space.lg,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  tailText: { ...type.meta, lineHeight: 17, color: c.fg3 },
  tailNames: { color: c.fg2 },
  footnote: { ...type.caption, fontSize: 12, color: c.fg3, paddingTop: 9, paddingHorizontal: 6 },
  footnoteText: { ...type.caption, fontSize: 12, color: c.fg3 },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 14,
    rowGap: 6,
    paddingTop: 9,
    paddingBottom: 22,
    paddingHorizontal: 20,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 6, height: 12, borderTopLeftRadius: 1.5, borderTopRightRadius: 1.5 },
  swatchNow: { backgroundColor: c.fg },
  swatchLast: { borderWidth: 1, borderBottomWidth: 0, borderColor: c.fg3 },
  swatchRecord: { backgroundColor: c.record },
}));
