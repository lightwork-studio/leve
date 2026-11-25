import { type WeightUnit, weightFromKg } from "@leve/core";
import { Link } from "expo-router";
import { Fragment, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAppData } from "../../src/data/app-data.tsx";
import { recordBodyweight } from "../../src/data/bodyweight.ts";
import { useProgress } from "../../src/data/queries.ts";
import {
  type Bucket,
  barAxisTop,
  chartSeries,
  durationAxisTop,
  mainLifts,
  monthMarks,
  RANGE_WEEKS,
  type Range,
  recentRecords,
  type Series,
  seriesLead,
  trainingFrequency,
  weekTotals,
} from "../../src/model/progress.ts";
import { numeral, space, type } from "../../src/theme.ts";
import { BarChart } from "../../src/ui/bar-chart.tsx";
import { BodyweightEditor } from "../../src/ui/bodyweight-editor.tsx";
import { ChartTabs, Segmented } from "../../src/ui/chart-controls.tsx";
import { useRolling } from "../../src/ui/count-up.tsx";
import { metricLabel, metricParts, recordName } from "../../src/ui/exercise-metrics.ts";
import {
  axisMinutes,
  axisNumber,
  minutesLabel,
  minutesParts,
  readoutMinutes,
  readoutWeight,
  shortDay,
  shortMonth,
  weekLabel,
  weightValue,
  wholeWeight,
} from "../../src/ui/format.ts";
import { Group } from "../../src/ui/group.tsx";
import { ChevronIcon, PlusIcon } from "../../src/ui/icons.tsx";
import { MuscleCard } from "../../src/ui/muscle-map.tsx";
import { Readouts } from "../../src/ui/readout.tsx";
import { RecordMark } from "../../src/ui/record-mark.tsx";
import { TabScreen } from "../../src/ui/screen.tsx";
import { Sparkline } from "../../src/ui/sparkline.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { useToday } from "../../src/ui/use-now.ts";

type CountMeasure = "sets" | "reps";
type Measure = "duration" | "volume" | CountMeasure;

const MEASURES: { value: Measure; label: string }[] = [
  { value: "duration", label: "Duration" },
  { value: "volume", label: "Volume" },
  { value: "reps", label: "Reps" },
  { value: "sets", label: "Sets" },
];

const RANGE_CHOICES: { value: Range; label: string }[] = [
  { value: "3M", label: "3 months" },
  { value: "1Y", label: "1 year" },
  { value: "All", label: "All time" },
];

function measureValue(bucket: Bucket, measure: Measure, unit: WeightUnit) {
  if (measure === "duration") return bucket.minutes;
  if (measure === "volume") return weightFromKg(bucket.volumeKg, unit);
  return bucket[measure];
}

function countUnit(count: number, measure: CountMeasure) {
  if (count !== 1) return measure;
  return measure === "sets" ? "set" : "rep";
}

/** A bar's period by name: "This week", "9–15 Nov", "This month" or "October 2025". */
function bucketName(series: Series, index: number) {
  const bucket = series.buckets[index];
  if (!bucket) return "";
  const current = index === series.buckets.length - 1;
  if (series.unit === "week") return current ? "This week" : weekLabel(bucket.start);
  return current
    ? "This month"
    : new Date(bucket.start).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const RECORDS_SHOWN = 5;
const LIFTS_SHOWN = 5;

export default function ProgressScreen() {
  const { settings, index, muscleTargets, measurements } = useProgress();
  const styles = useStyles(sheet);
  const c = useColors();
  const unit = settings.weightUnit;
  const firstWeekday = settings.firstWeekday;
  // Weeks change with the day, not the minute: this renders again only when the day turns.
  const today = useToday();
  const [measure, setMeasure] = useState<Measure>("duration");
  const [range, setRange] = useState<Range>("3M");
  // The bar picked by scrubbing, by its start; the latest when none is (or it left the chart).
  const [picked, setPicked] = useState<number | null>(null);

  const week = useMemo(
    () => weekTotals(index.workouts, today, firstWeekday),
    [index, today, firstWeekday],
  );
  const frequency = useMemo(() => trainingFrequency(index.workouts, today), [index, today]);
  const series = useMemo(
    () => chartSeries(index.workouts, range, today, firstWeekday),
    [index, range, today, firstWeekday],
  );
  const records = useMemo(() => recentRecords(index, RECORDS_SHOWN), [index]);
  const lifts = useMemo(() => mainLifts(index, today, LIFTS_SHOWN), [index, today]);
  const chart = useMemo(() => {
    // Keyed by what each bar stands for, so a week that stays moves to its new place.
    const bars = series.buckets.map((b) => ({
      key: `${series.unit}-${b.start}`,
      value: measureValue(b, measure, unit),
    }));
    const most = bars.reduce((m, b) => Math.max(m, b.value), 0);
    const top = measure === "duration" ? durationAxisTop(most) : barAxisTop(most);
    const marks = monthMarks(series).map((m) => ({
      index: m.index,
      label: series.unit === "month" && m.month === 0 ? String(m.year) : shortMonth(m.month),
    }));
    // The average of the earlier bars that have something in them, for the dashed line.
    const earlier = bars.slice(0, -1).filter((b) => b.value > 0);
    const average = earlier.length
      ? earlier.reduce((sum, b) => sum + b.value, 0) / earlier.length
      : null;
    const describe = (b: Bucket | undefined) =>
      !b
        ? ""
        : measure === "duration"
          ? minutesLabel(b.minutes)
          : measure === "volume"
            ? `${wholeWeight(b.volumeKg, unit)} ${unit}`
            : `${b[measure]} ${countUnit(b[measure], measure)}`;
    return { bars, top, marks, average, describe };
  }, [series, measure, unit]);

  const found = picked === null ? -1 : series.buckets.findIndex((b) => b.start === picked);
  const selected = found < 0 ? series.buckets.length - 1 : found;
  const bucket = series.buckets[selected];
  const current = selected === series.buckets.length - 1;
  const periodName = series.unit === "week" ? "week" : "month";
  const spoken =
    range === "All"
      ? `${series.unit === "week" ? "weekly" : "monthly"} totals over all time`
      : `weekly totals over the last ${RANGE_WEEKS[range]} weeks`;
  const lead = useMemo(() => {
    const shown = seriesLead(series);
    return shown && { share: shown.share, label: `No workouts before ${shortDay(shown.start)}` };
  }, [series]);
  const value = bucket ? measureValue(bucket, measure, unit) : 0;
  const change = chart.average && bucket ? Math.round((value / chart.average - 1) * 100) : null;
  const name = bucketName(series, selected);
  const heroSpoken = bucket
    ? `${chart.describe(bucket)} ${current ? `this ${periodName}` : `in ${name}`}`
    : "";
  const weekTime = readoutMinutes(week.minutes);

  return (
    <TabScreen title="Progress" eyebrow="All exercises" hasTextInput>
      <Group label="This week" aside={weekLabel(week.start)} style={styles.group}>
        <Readouts
          size={34}
          cells={[
            { label: "Workouts", value: String(week.workouts) },
            {
              label: "Time",
              value: weekTime.value,
              unit: weekTime.unit,
              accessibilityLabel: `Time ${minutesLabel(week.minutes)}`,
            },
            {
              label: "Volume",
              value: readoutWeight(week.volumeKg, unit),
              unit,
              width: 1.2,
              accessibilityLabel: `Volume ${wholeWeight(week.volumeKg, unit)} ${unit}`,
            },
          ]}
        />
      </Group>

      <Group
        label="Training load"
        footnote="Drag across the bars and the readout follows your finger. The dashed line is your average."
        style={styles.group}
      >
        <View style={styles.tabs}>
          <ChartTabs options={MEASURES} value={measure} onChange={setMeasure} />
        </View>
        <View style={styles.gauge}>
          <Text style={styles.label}>
            {name}
            {current ? " · so far" : ""}
          </Text>
          <GaugeFigure
            value={value}
            measure={measure}
            unit={unit}
            spoken={heroSpoken}
            turn={`${measure}-${selected}-${range}`}
          />
          <Text style={styles.line} numberOfLines={1}>
            {change !== null
              ? `${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}% vs average ${periodName} · `
              : ""}
            {bucket?.workouts ?? 0} {bucket?.workouts === 1 ? "workout" : "workouts"}
          </Text>
        </View>
        <View style={styles.chart}>
          <BarChart
            bars={chart.bars}
            top={chart.top}
            tickLabel={(v) =>
              v === 0 ? "0" : measure === "duration" ? axisMinutes(v) : axisNumber(v)
            }
            marks={chart.marks}
            selected={selected}
            onSelect={(at) => setPicked(series.buckets[at]?.start ?? null)}
            describe={(at) => `${bucketName(series, at)}: ${chart.describe(series.buckets[at])}`}
            average={chart.average}
            lead={lead}
            accessibilityLabel={`${MEASURES.find((m) => m.value === measure)?.label}: ${spoken}. This ${periodName}: ${chart.describe(series.buckets.at(-1))}.`}
          />
        </View>
        <View style={styles.pad}>
          <Segmented
            kind="choice"
            soft
            label="Chart range"
            options={RANGE_CHOICES}
            value={range}
            onChange={(next) => {
              setRange(next);
              setPicked(null);
            }}
          />
        </View>
      </Group>

      <Group
        label="Muscles"
        aside="By primary and secondary"
        footnote="Each set counts in full toward its exercise's primary muscles and half toward its secondary ones. Tap a muscle or a row."
        style={styles.group}
      >
        <MuscleCard
          exercises={index.exercises}
          workouts={index.workouts}
          today={today}
          lookup={muscleTargets}
          unit={unit}
        />
      </Group>

      {records.length > 0 && (
        <Group label="Records" aside="Recent" style={styles.group}>
          {records.map((record, i) => {
            const history = index.byExercise.get(record.exerciseId);
            if (!history) return null;
            const [figure, figureUnit] = metricParts(record.metric, record.value, unit, settings);
            const what = recordName(record.metric, history.type);
            return (
              <Link
                key={`${record.workoutId}-${record.exerciseId}-${record.metric}`}
                href={{ pathname: "/exercise/[id]", params: { id: record.exerciseId } }}
                asChild
              >
                <Tap
                  accessibilityRole="link"
                  accessibilityLabel={`Record: ${history.name}, ${what} ${metricLabel(record.metric, record.value, unit, settings)}, ${shortDay(record.time)}`}
                  scaleTo={0.98}
                  style={StyleSheet.flatten([styles.row, i > 0 && styles.divider])}
                >
                  <RecordMark />
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {history.name}
                    </Text>
                    <Text style={styles.rowDetail} numberOfLines={1}>
                      {what} · {shortDay(record.time)}
                    </Text>
                  </View>
                  <Text style={styles.rowNumber}>
                    {figure}
                    {figureUnit ? <Text style={styles.unit}> {figureUnit}</Text> : null}
                  </Text>
                  <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
                </Tap>
              </Link>
            );
          })}
        </Group>
      )}

      {lifts.length > 0 && (
        <Group label="Main lifts" aside="Latest sessions" style={styles.group}>
          {lifts.map((lift, i) => {
            const { history, metric } = lift;
            const [figure] = metricParts(metric, lift.latest, unit, settings);
            const [step, stepUnit] = metricParts(metric, Math.abs(lift.change), unit, settings);
            const latest = history.sessions[0];
            return (
              <Link
                key={history.exerciseId}
                href={{ pathname: "/exercise/[id]", params: { id: history.exerciseId } }}
                asChild
              >
                <Tap
                  accessibilityRole="link"
                  accessibilityLabel={`${history.name}: latest ${metricLabel(metric, lift.latest, unit, settings)}, ${lift.change >= 0 ? "up" : "down"} ${metricLabel(metric, Math.abs(lift.change), unit, settings)}`}
                  scaleTo={0.98}
                  style={StyleSheet.flatten([styles.row, i > 0 && styles.divider])}
                >
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {history.name}
                    </Text>
                    <Text style={styles.rowDetail} numberOfLines={1}>
                      {latest ? shortDay(latest.time) : ""} · {history.sessions.length}{" "}
                      {history.sessions.length === 1 ? "session" : "sessions"}
                    </Text>
                  </View>
                  <Sparkline values={lift.values} />
                  <View style={styles.liftValue}>
                    <Text style={styles.rowNumber}>{figure}</Text>
                    <Text style={styles.rowDetail}>
                      {lift.change >= 0 ? "+" : "−"}
                      {step}
                      {stepUnit ? ` ${stepUnit}` : ""}
                    </Text>
                  </View>
                </Tap>
              </Link>
            );
          })}
        </Group>
      )}

      <Group label="More" style={styles.group}>
        <MoreCard
          key={unit}
          unit={unit}
          frequency={frequency}
          measurements={measurements}
          exercisesDone={index.exercises.length}
        />
      </Group>
    </TabScreen>
  );
}

/** How far a span of days reads: days under two weeks, weeks after. */
const spanLabel = (ms: number) => {
  const days = Math.max(1, Math.round(ms / 86_400_000));
  return days < 14 ? `${days} d` : `${Math.round(days / 7)} wk`;
};

/**
 * The bodyweight's move over the readings its chart shows (the latest thirty), newest less oldest,
 * and over how long: "▼ 1.2 · 12 wk".
 */
function bodyweightDrift(measurements: readonly { at: number; kg: number }[], unit: WeightUnit) {
  const recent = measurements.slice(-30);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last) return "None yet";
  if (first.at === last.at) return "1 reading";
  const drift =
    Math.round(weightFromKg(last.kg, unit) * 10) / 10 -
    Math.round(weightFromKg(first.kg, unit) * 10) / 10;
  const sign = drift > 0.04 ? "▲" : drift < -0.04 ? "▼" : "±";
  return `${sign} ${Math.abs(drift).toFixed(1)} · ${spanLabel(last.at - first.at)}`;
}

/**
 * Training days, bodyweight and the exercises done, as three readout cells built the same way: a
 * label, a number with its unit, and one mono line. Each opens its page. A quiet row at the foot
 * records bodyweight.
 */
function MoreCard({
  unit,
  frequency,
  measurements,
  exercisesDone,
}: {
  unit: WeightUnit;
  frequency: { recent: number; previous: number };
  measurements: readonly { at: number; kg: number }[];
  exercisesDone: number;
}) {
  const { change } = useAppData();
  const styles = useStyles(sheet);
  const c = useColors();
  const [entryUnit, setEntryUnit] = useState<WeightUnit | null>(null);
  const latest = measurements.at(-1);
  const drift = bodyweightDrift(measurements, unit);
  return (
    <View>
      <View style={styles.cells}>
        <Link href="/history" asChild>
          <Tap
            accessibilityRole="link"
            accessibilityLabel={`Workout history. Training days: ${frequency.recent} in the last 28 days, ${frequency.previous} in the previous 28 days.`}
            scaleTo={0.98}
            style={styles.cell}
          >
            <ReadoutCell
              label="Trained"
              number={String(frequency.recent)}
              unit="days"
              line={`${frequency.previous} before`}
            />
          </Tap>
        </Link>
        <Link href="/bodyweight" asChild>
          <Tap
            accessibilityRole="link"
            accessibilityLabel={
              latest
                ? `Bodyweight history. Latest ${weightValue(latest.kg, unit)} ${unit}, ${drift}.`
                : "Bodyweight history. No bodyweight recorded."
            }
            scaleTo={0.98}
            style={StyleSheet.flatten([styles.cell, styles.cellDivider])}
          >
            <ReadoutCell
              label="Bodyweight"
              number={latest ? weightValue(latest.kg, unit) : "—"}
              unit={unit}
              line={drift}
            />
          </Tap>
        </Link>
        <Link href="/exercises" asChild>
          <Tap
            accessibilityRole="link"
            accessibilityLabel={`All exercises. ${exercisesDone} done, with sets, records and history.`}
            scaleTo={0.98}
            style={StyleSheet.flatten([styles.cell, styles.cellDivider])}
          >
            <ReadoutCell
              label="Exercises"
              number={String(exercisesDone)}
              unit="done"
              line="All exercises ›"
            />
          </Tap>
        </Link>
      </View>
      <Tap
        accessibilityRole="button"
        onPress={() => setEntryUnit(unit)}
        disabled={entryUnit !== null}
        scaleTo={0.98}
        style={styles.record}
      >
        <PlusIcon color={c.fg2} size={15} strokeWidth={2} />
        <Text style={styles.recordText}>Record bodyweight</Text>
      </Tap>
      {entryUnit !== null && (
        <View style={styles.editor}>
          <BodyweightEditor
            label="Today's bodyweight"
            unit={entryUnit}
            onCancel={() => setEntryUnit(null)}
            onSave={(text, measuredAt) => {
              change((store) => recordBodyweight(store, text, entryUnit, measuredAt));
              setEntryUnit(null);
            }}
          />
        </View>
      )}
    </View>
  );
}

/** One cell of the More card: a label, a number with its unit, and one mono line. */
function ReadoutCell({
  label,
  number,
  unit,
  line,
}: {
  label: string;
  number: string;
  unit: string;
  line: string;
}) {
  const styles = useStyles(sheet);
  return (
    <>
      <Text style={styles.cellLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.cellReading} numberOfLines={1}>
        <Text style={styles.cellNumber}>{number}</Text>
        <Text style={styles.unit}> {unit}</Text>
      </Text>
      <Text style={styles.cellLine} numberOfLines={1}>
        {line}
      </Text>
    </>
  );
}

/**
 * The picked bar's figure, large. It rolls when the data under it changes and jumps at once to
 * another bar, measure or range, so scrubbing keeps up with the finger. A component of its own, so
 * only it renders on each frame of a roll.
 */
function GaugeFigure({
  value,
  measure,
  unit,
  spoken,
  turn,
}: {
  value: number;
  measure: Measure;
  unit: WeightUnit;
  spoken: string;
  turn: string;
}) {
  const styles = useStyles(sheet);
  const rolled = Math.round(useRolling(value, 300, turn));
  const parts: [string, string][] =
    measure === "duration"
      ? minutesParts(rolled)
      : [[rolled.toLocaleString(), measure === "volume" ? unit : countUnit(rolled, measure)]];
  return (
    <Text accessibilityLabel={spoken} numberOfLines={1} style={styles.gaugeLine}>
      {parts.map(([number, partUnit], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts are always in the same order.
        <Fragment key={i}>
          {i > 0 && <Text style={styles.gaugeUnit}> </Text>}
          <Text style={styles.gaugeFigure}>{number}</Text>
          <Text style={styles.gaugeUnit}> {partUnit}</Text>
        </Fragment>
      ))}
    </Text>
  );
}

const sheet = themedStyles((c) => ({
  // Groups sit 14 points from the screen's edge, like everywhere else.
  group: { marginHorizontal: -2, marginBottom: 0 },
  tabs: { paddingTop: 4, paddingHorizontal: 16 },
  gauge: { paddingTop: 16, paddingHorizontal: 16, paddingBottom: 2 },
  label: { ...type.label, color: c.fg3 },
  gaugeLine: { marginTop: 11 },
  gaugeFigure: { ...numeral(66), color: c.fg },
  gaugeUnit: { ...type.unit, fontSize: 13, color: c.fg3 },
  line: { ...type.value, fontSize: 11.5, color: c.fg2, marginTop: 11, minHeight: 15 },
  chart: { paddingTop: 8, paddingHorizontal: 16 },
  pad: { paddingTop: 12, paddingHorizontal: 16, paddingBottom: 14 },
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
  rowTitle: { ...type.rowTitle, color: c.fg },
  rowDetail: { ...type.meta, color: c.fg3, marginTop: 4 },
  rowNumber: { ...numeral(24), color: c.fg, textAlign: "right" },
  unit: { ...type.unit, color: c.fg3 },
  liftValue: { minWidth: 66, alignItems: "flex-end" },
  // Three cells built alike, so their labels, numbers and lines share one left edge and one row.
  cells: { flexDirection: "row" },
  cell: {
    flex: 1,
    minWidth: 0,
    gap: 9,
    paddingTop: 13,
    paddingRight: 10,
    paddingBottom: 13,
    paddingLeft: 14,
  },
  cellDivider: { borderLeftWidth: 1, borderLeftColor: c.line },
  cellLabel: { ...type.label, letterSpacing: 0.84, color: c.fg3, height: 14 },
  cellReading: { height: 40, paddingTop: 4 },
  cellNumber: { ...numeral(34, "200"), color: c.fg },
  cellLine: { ...type.meta, fontSize: 10.5, lineHeight: 14, color: c.fg3 },
  record: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 46,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  recordText: { ...type.action, letterSpacing: 1.47, color: c.fg2 },
  editor: { padding: space.lg, borderTopWidth: 1, borderTopColor: c.line },
}));
