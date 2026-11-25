import type { WeightUnit } from "@leve/core";
import { Link, useLocalSearchParams } from "expo-router";
import { memo, useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import { builtInExercise } from "../../src/data/exercises.ts";
import { useProgress } from "../../src/data/queries.ts";
import {
  type ExerciseHistory,
  type ExerciseMetric,
  type ExerciseSession,
  emptyLead,
  exerciseMetrics,
  exerciseRecords,
  lineAxis,
  METRIC_AXIS,
  METRIC_KIND,
  metricPoints,
  metricValue,
  monthStarts,
  type Range,
  rangeStart,
  recordsByWorkout,
} from "../../src/model/progress.ts";
import { numeral, radius, space, type } from "../../src/theme.ts";
import { BackLink } from "../../src/ui/back-link.tsx";
import { Segmented } from "../../src/ui/chart-controls.tsx";
import { useRolling } from "../../src/ui/count-up.tsx";
import {
  chartName,
  chartValue,
  metricLabel,
  metricParts,
  metricTick,
  recordName,
  TYPE_NAMES,
} from "../../src/ui/exercise-metrics.ts";
import {
  type DistancePreferences,
  dayLabel,
  shortDay,
  shortMonth,
  timeLabel,
  weightValue,
} from "../../src/ui/format.ts";
import { Group, SectionLabel } from "../../src/ui/group.tsx";
import { ChevronIcon } from "../../src/ui/icons.tsx";
import { LineChart } from "../../src/ui/line-chart.tsx";
import { ExerciseMuscles } from "../../src/ui/muscle-map.tsx";
import { pairGridCell } from "../../src/ui/pair-grid.ts";
import { RecordMark } from "../../src/ui/record-mark.tsx";
import { sessionSetLabel } from "../../src/ui/set-values.ts";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { useToday } from "../../src/ui/use-now.ts";

/**
 * A rolling headline's value as it can be shown: counts, seconds and metres step in whole units
 * (weights keep their decimal), and it lands exactly on the final value.
 */
function rollingValue(metric: ExerciseMetric, rolled: number, final: number): number {
  if (Math.abs(rolled - final) < 1e-6) return final;
  return METRIC_KIND[metric] === "weight" ? rolled : Math.round(rolled);
}

const RANGE_CHOICES: { value: Range; label: string }[] = [
  { value: "3M", label: "3 months" },
  { value: "1Y", label: "1 year" },
  { value: "All", label: "All time" },
];

const RANGE_SPANS: Record<Range, string> = {
  "3M": "the last three months",
  "1Y": "the last year",
  All: "all time",
};

const RANGE_CHANGE: Record<Range, string> = {
  "3M": "over 3 months",
  "1Y": "over the year",
  All: "over all time",
};

/** The short name under a session's headline number, for measures without a unit. */
const METRIC_TAG: Record<ExerciseMetric, string> = {
  oneRepMax: "e1RM",
  heaviest: "top",
  bestSetVolume: "best set",
  sessionVolume: "volume",
  mostReps: "reps",
  sessionReps: "reps",
  longestDuration: "time",
  longestDistance: "distance",
};

/** Sessions shown before "Show all". */
const SESSIONS_SHOWN = 8;

const NO_SESSIONS: ExerciseSession[] = [];

/**
 * One exercise: its muscles, a chart of the chosen measure that follows the finger, its records,
 * and the sessions that did it. Opened from the current workout or a muscle's exercises, the
 * sessions come first and in full.
 */
export default function ExerciseScreen() {
  const { id, workoutId, activeEntryId, from } = useLocalSearchParams<{
    id: string;
    workoutId?: string;
    activeEntryId?: string;
    from?: string;
  }>();
  const { settings, index, muscleTargets } = useProgress();
  const { store } = useAppData();
  const styles = useStyles(sheet);
  const c = useColors();
  const exercise = builtInExercise(id);
  const history = index.byExercise.get(id) ?? null;
  const entry =
    activeEntryId && !history && !exercise
      ? store.get("workout_exercise", activeEntryId)?.content
      : undefined;
  const entryName =
    entry?.exerciseId === id && typeof entry.exerciseName === "string"
      ? entry.exerciseName
      : undefined;
  const unit = settings.weightUnit;
  const insets = useSafeAreaInsets();
  const fromMuscleActivity = from === "muscleActivity";
  const sessionsFirst = !!activeEntryId || fromMuscleActivity;
  const [metric, setMetric] = useState<ExerciseMetric | null>(null);
  const [range, setRange] = useState<Range>("3M");
  const [all, setAll] = useState(sessionsFirst);
  const today = useToday();
  // Workouts where this exercise reached a record, to mark their sessions.
  const recordWorkouts = useMemo(() => {
    const held = new Set<string>();
    for (const [workout, records] of recordsByWorkout(index)) {
      if (records.some((record) => record.exerciseId === id)) held.add(workout);
    }
    return held;
  }, [index, id]);

  const name = history?.name ?? exercise?.name ?? entryName ?? "Exercise";
  const sessions = history?.sessions ?? NO_SESSIONS;
  const shown = all ? sessions : sessions.slice(0, SESSIONS_SHOWN);
  const headlineMetric = history
    ? exerciseMetrics(history.type, history.usesBodyweight)[0]
    : undefined;

  const intro = (
    <View style={styles.header}>
      {activeEntryId ? (
        <BackLink label="Current workout" fallback="/workout/active" />
      ) : workoutId ? (
        <BackLink
          label="Workout"
          fallback={{ pathname: "/workout/[id]", params: { id: workoutId } }}
        />
      ) : fromMuscleActivity ? (
        <BackLink label="Progress" fallback="/progress" />
      ) : (
        <BackLink label="Exercises" fallback="/exercises" />
      )}
      <View style={styles.titles}>
        <Text style={styles.eyebrow}>
          {exercise
            ? `${exercise.equipment} · ${exercise.muscles.join(", ")}`
            : history
              ? (TYPE_NAMES[history.type] ?? history.type)
              : "Exercise"}
        </Text>
        <Text accessibilityRole="header" style={styles.title}>
          {name}
        </Text>
        {history ? (
          <Text style={styles.subtitle}>
            {TYPE_NAMES[history.type] ?? history.type} · {sessions.length}{" "}
            {sessions.length === 1 ? "session" : "sessions"}
          </Text>
        ) : (
          <Text style={styles.subtitle}>No workouts with this exercise.</Text>
        )}
      </View>
      <Group label="Muscles" aside="This exercise" style={styles.group}>
        <ExerciseMuscles targets={muscleTargets(id)} />
      </Group>
    </View>
  );

  const summary = history ? (
    <Summary
      history={history}
      today={today}
      unit={unit}
      prefs={settings}
      chosen={metric}
      onMetric={setMetric}
      range={range}
      onRange={setRange}
    />
  ) : null;

  const sessionsTitle = `Sessions · ${sessions.length}`;
  const sessionsHead = history ? (
    <View style={styles.sessionsHead}>
      <SectionLabel aside="Newest first" header>
        {sessionsTitle}
      </SectionLabel>
    </View>
  ) : null;

  const showAll =
    history && !all && sessions.length > SESSIONS_SHOWN ? (
      <Tap
        accessibilityRole="button"
        onPress={() => setAll(true)}
        scaleTo={0.98}
        style={[styles.sessionRow, styles.divider, styles.lastRow, styles.centred]}
      >
        <Text style={[styles.link, styles.flex]}>Show all {sessions.length} sessions</Text>
        <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
      </Tap>
    ) : null;

  return (
    <FlatList
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + space.md }]}
      data={shown}
      keyExtractor={(session) => session.workoutId}
      ListHeaderComponent={
        <>
          {intro}
          {!sessionsFirst && summary}
          {sessionsHead}
        </>
      }
      ListFooterComponent={
        <>
          {showAll}
          {sessionsFirst && summary && <View style={styles.after}>{summary}</View>}
        </>
      }
      initialNumToRender={6}
      renderItem={({ item, index: i }) =>
        history ? (
          <SessionRow
            session={item}
            unit={unit}
            prefs={settings}
            back={history.name}
            exerciseId={history.exerciseId}
            metric={headlineMetric}
            record={recordWorkouts.has(item.workoutId)}
            first={i === 0}
            last={i === shown.length - 1 && !showAll}
          />
        ) : null
      }
    />
  );
}

function Summary({
  today,
  history,
  unit,
  prefs,
  chosen,
  onMetric,
  range,
  onRange,
}: {
  today: number;
  history: ExerciseHistory;
  unit: WeightUnit;
  prefs: DistancePreferences;
  chosen: ExerciseMetric | null;
  onMetric: (metric: ExerciseMetric) => void;
  range: Range;
  onRange: (range: Range) => void;
}) {
  const styles = useStyles(sheet);
  const metrics = useMemo(
    () => exerciseMetrics(history.type, history.usesBodyweight),
    [history.type, history.usesBodyweight],
  );
  const metric = chosen !== null && metrics.includes(chosen) ? chosen : (metrics[0] ?? "mostReps");
  // The point picked by scrubbing, by its time; the latest when none is (or it left the chart).
  const [picked, setPicked] = useState<number | null>(null);

  const chart = useMemo(() => {
    const d = new Date(today);
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const points = metricPoints(history.sessions, metric, rangeStart(range, today));
    const from = range === "All" ? (points[0]?.time ?? today) : rangeStart(range, today);
    const span = end - from || 1;
    const shown = points.map((p) => ({
      time: p.time,
      x: (p.time - from) / span,
      value: chartValue(metric, p.value, unit),
    }));
    const lead = emptyLead(shown[0]?.x);
    const marks = monthStarts(from, end).map((m) => ({
      x: (m.time - from) / span,
      label: m.yearly ? String(m.year) : shortMonth(m.month),
    }));
    return {
      raw: points,
      points: shown,
      axis: lineAxis(
        shown.map((p) => p.value),
        METRIC_AXIS[metric],
      ),
      marks,
      lead:
        lead === null
          ? null
          : { share: lead, label: `No sessions before ${shortDay(points[0]?.time ?? from)}` },
      best: points.reduce((most, p) => Math.max(most, p.value), 0),
    };
  }, [history, metric, range, unit, today]);

  const records = useMemo(() => exerciseRecords(history), [history]);
  const kind = chartName(metric, history.type);
  const found = picked === null ? -1 : chart.raw.findIndex((p) => p.time === picked);
  const at = found < 0 ? chart.raw.length - 1 : found;
  const point = chart.raw[at] ?? null;
  const latest = chart.raw.at(-1) ?? null;
  const session = point ? history.sessions.find((s) => s.workoutId === point.workoutId) : null;
  const rise = chart.raw.length > 1 && latest ? latest.value - (chart.raw[0]?.value ?? 0) : 0;
  const day = (time: number) => dayLabel(new Date(time).toISOString());
  const description = latest
    ? `${kind} over ${RANGE_SPANS[range]}, ${chart.raw.length} ${chart.raw.length === 1 ? "day" : "days"} trained (each day's best): best ${metricLabel(metric, chart.best, unit, prefs)}, latest ${metricLabel(metric, latest.value, unit, prefs)} on ${day(latest.time)}.`
    : `${kind}: no sessions in ${RANGE_SPANS[range]}.`;

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="radiogroup"
        accessibilityLabel="Chart"
        contentContainerStyle={styles.pills}
      >
        {metrics.map((m) => {
          const on = m === metric;
          return (
            <Tap
              key={m}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => {
                onMetric(m);
                setPicked(null);
              }}
              scaleTo={0.95}
              hitSlop={{ top: 4, bottom: 4 }}
              style={[styles.pill, on && styles.pillOn]}
            >
              <Text style={[styles.pillText, on && styles.pillTextOn]}>
                {chartName(m, history.type)}
              </Text>
            </Tap>
          );
        })}
      </ScrollView>

      <View style={styles.card}>
        <View style={styles.gauge}>
          <Text style={styles.label} numberOfLines={1}>
            {point
              ? `${shortDay(point.time)} · ${session?.workoutTitle || "Workout"}`
              : "No sessions"}
          </Text>
          <Headline
            metric={metric}
            value={point?.value ?? null}
            unit={unit}
            prefs={prefs}
            turn={`${metric}-${at}-${range}`}
          />
          <Text style={styles.line} numberOfLines={1}>
            {point
              ? `${rise > 0 ? `▲ ${metricLabel(metric, rise, unit, prefs)} ${RANGE_CHANGE[range]} · ` : ""}${session?.counted ?? 0} ${session?.counted === 1 ? "set" : "sets"}`
              : `No sessions in ${RANGE_SPANS[range]}`}
          </Text>
        </View>
        <View style={styles.chart}>
          <LineChart
            points={chart.points}
            axis={chart.axis}
            tickLabel={(value) => metricTick(metric, value, chart.axis, prefs)}
            marks={chart.marks}
            lead={chart.lead}
            selected={at}
            onSelect={(i) => setPicked(chart.raw[i]?.time ?? null)}
            describe={(i) => {
              const p = chart.raw[i];
              return p ? `${day(p.time)}: ${metricLabel(metric, p.value, unit, prefs)}` : "";
            }}
            accessibilityLabel={description}
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
              onRange(next);
              setPicked(null);
            }}
          />
        </View>
      </View>

      {records.length > 0 && (
        <Group label="Personal records" aside="All time" style={styles.group}>
          <View style={styles.grid}>
            {records.map((record, i) => {
              const [figure, figureUnit] = metricParts(record.metric, record.value, unit, prefs);
              const place = pairGridCell(i, records.length);
              return (
                <Link
                  key={record.metric}
                  href={{
                    pathname: "/workout/[id]",
                    params: {
                      id: record.workoutId,
                      back: history.name,
                      fromExercise: history.exerciseId,
                    },
                  }}
                  asChild
                >
                  <Tap
                    accessibilityRole="link"
                    accessibilityLabel={`${recordName(record.metric, history.type)}, ${metricLabel(record.metric, record.value, unit, prefs)}, ${dayLabel(record.startedAt)}`}
                    accessibilityHint="Opens the workout where it was set"
                    scaleTo={0.98}
                    // One style object: on the web, Link rejects a list of styles.
                    style={StyleSheet.flatten([
                      styles.cell,
                      place.wide && styles.cellWide,
                      place.left && styles.cellLeft,
                      place.top && styles.cellTop,
                    ])}
                  >
                    <View style={styles.cellLabel}>
                      <RecordMark small />
                      <Text style={[styles.label, styles.flex]} numberOfLines={1}>
                        {recordName(record.metric, history.type)}
                      </Text>
                    </View>
                    <Text style={styles.cellNumber} numberOfLines={1}>
                      {figure}
                      {figureUnit ? <Text style={styles.unit}> {figureUnit}</Text> : null}
                    </Text>
                    <Text style={styles.cellDate} numberOfLines={1}>
                      {shortDay(Date.parse(record.startedAt))}
                    </Text>
                  </Tap>
                </Link>
              );
            })}
          </View>
        </Group>
      )}
    </View>
  );
}

/** One workout's sets of the exercise, as a row of a log; it opens the workout. */
const SessionRow = memo(function SessionRow({
  session,
  unit,
  prefs,
  back,
  exerciseId,
  metric,
  record,
  first,
  last,
}: {
  session: ExerciseSession;
  unit: WeightUnit;
  prefs: DistancePreferences;
  back: string;
  exerciseId: string;
  metric: ExerciseMetric | undefined;
  record: boolean;
  first: boolean;
  last: boolean;
}) {
  const styles = useStyles(sheet);
  const date = new Date(session.time);
  const value = metric ? metricValue(session, metric) : null;
  const [figure, figureUnit] =
    metric && value !== null ? metricParts(metric, value, unit, prefs) : ["", ""];
  const mark = { warmup: "W ", drop: "D ", failure: "F ", normal: "" } as const;
  return (
    <Link
      href={{
        pathname: "/workout/[id]",
        params: { id: session.workoutId, back, fromExercise: exerciseId },
      }}
      asChild
    >
      <Tap
        accessibilityRole="link"
        accessibilityHint="Opens the workout"
        scaleTo={0.98}
        style={StyleSheet.flatten([
          styles.sessionRow,
          first && styles.firstRow,
          !first && styles.divider,
          last && styles.lastRow,
        ])}
      >
        <View style={styles.date}>
          <Text style={styles.dateNumber}>{String(date.getDate()).padStart(2, "0")}</Text>
          <Text style={styles.label}>{shortMonth(date.getMonth())}</Text>
        </View>
        <View style={styles.flex}>
          <View style={styles.sessionTitleRow}>
            <Text style={styles.sessionTitle} numberOfLines={1}>
              {session.workoutTitle || "Workout"}
            </Text>
            {record && <RecordMark small />}
          </View>
          <Text style={styles.sessionMeta}>
            {dayLabel(session.startedAt)} · {timeLabel(session.startedAt)}
            {record ? " · record" : ""}
          </Text>
          <Text style={styles.sets}>
            {session.sets.map(({ id, content }, i) => (
              <Text
                key={id}
                style={
                  content.type === "warmup" || content.completedAt === null
                    ? styles.setQuiet
                    : styles.set
                }
              >
                {i > 0 ? <Text style={styles.setQuiet}> · </Text> : null}
                {mark[content.type]}
                {session.exerciseType === "weight_reps" &&
                content.weightKg !== null &&
                content.reps !== null
                  ? // Weight and reps alone read compactly, the unit shown beside the session.
                    `${weightValue(content.weightKg, unit)}×${content.reps}`
                  : sessionSetLabel(session.exerciseType, content, unit, prefs)}
                {content.completedAt === null ? " skipped" : ""}
              </Text>
            ))}
          </Text>
        </View>
        {figure !== "" && metric && (
          <View style={styles.sessionValue}>
            <Text style={styles.sessionNumber}>{figure}</Text>
            <Text style={styles.label}>
              {METRIC_TAG[metric]}
              {figureUnit && METRIC_KIND[metric] === "weight" ? ` · ${figureUnit}` : ""}
            </Text>
          </View>
        )}
      </Tap>
    </Link>
  );
});

/**
 * The picked point's value, large. It rolls when the value under it changes and jumps at once to
 * another point, metric or range, so scrubbing keeps up with the finger. Only it renders on each
 * frame of a roll.
 */
function Headline({
  metric,
  value,
  unit,
  prefs,
  turn,
}: {
  metric: ExerciseMetric;
  value: number | null;
  unit: WeightUnit;
  prefs: DistancePreferences;
  turn: string;
}) {
  const styles = useStyles(sheet);
  const rolled = useRolling(value ?? 0, 300, value === null ? null : turn);
  const [figure, figureUnit] =
    value === null
      ? ["—", ""]
      : metricParts(metric, rollingValue(metric, rolled, value), unit, prefs);
  return (
    <Text
      style={styles.headline}
      numberOfLines={1}
      accessibilityLabel={value === null ? "" : metricLabel(metric, value, unit, prefs)}
    >
      <Text style={styles.figure}>{figure}</Text>
      {figureUnit !== "" && <Text style={styles.figureUnit}> {figureUnit}</Text>}
    </Text>
  );
}

const sheet = themedStyles((c) => ({
  flex: { flex: 1, minWidth: 0 },
  scroll: { flex: 1, backgroundColor: c.bg },
  content: { paddingHorizontal: 14, paddingBottom: space.xxl },
  header: { gap: space.md },
  titles: { paddingHorizontal: 6, gap: 9, marginTop: space.sm, marginBottom: space.sm },
  eyebrow: { ...type.label, color: c.fg3 },
  title: { ...type.title, color: c.fg },
  subtitle: { ...type.meta, color: c.fg3 },
  group: { marginHorizontal: 0, marginBottom: 22 },
  pills: { gap: 6, paddingBottom: 14 },
  pill: {
    height: 36,
    paddingHorizontal: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.line2,
    justifyContent: "center",
  },
  pillOn: { backgroundColor: c.fg, borderColor: c.fg },
  pillText: { ...type.action, letterSpacing: 1.05, color: c.fg2 },
  pillTextOn: { color: c.bg },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
    marginBottom: 22,
  },
  gauge: { paddingTop: 16, paddingHorizontal: 16, paddingBottom: 2 },
  label: { ...type.label, color: c.fg3 },
  headline: { marginTop: 11 },
  figure: { ...numeral(66), color: c.fg },
  figureUnit: { ...type.unit, fontSize: 13, color: c.fg3 },
  line: { ...type.value, fontSize: 11.5, color: c.fg2, marginTop: 11, minHeight: 15 },
  chart: { paddingTop: 8, paddingHorizontal: 16 },
  pad: { paddingTop: 12, paddingHorizontal: 16, paddingBottom: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "50%", paddingTop: 14, paddingBottom: 13, paddingLeft: 16, paddingRight: 14 },
  cellWide: { width: "100%" },
  cellLeft: { borderLeftWidth: 1, borderLeftColor: c.line },
  cellTop: { borderTopWidth: 1, borderTopColor: c.line },
  cellLabel: { flexDirection: "row", alignItems: "center", gap: 7 },
  cellNumber: { ...numeral(28, "300"), color: c.fg, marginTop: 9 },
  unit: { ...type.unit, color: c.fg3 },
  cellDate: { ...type.meta, fontSize: 10.5, color: c.fg3, marginTop: 6 },
  sessionsHead: { paddingHorizontal: 6, paddingBottom: 9 },
  sessionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    minHeight: 64,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: c.s1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.line,
  },
  centred: { alignItems: "center", minHeight: 52 },
  firstRow: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
  },
  lastRow: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  date: { width: 40, gap: 4 },
  dateNumber: { ...numeral(30), color: c.fg },
  sessionTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  sessionTitle: { ...type.rowTitle, fontSize: 14, color: c.fg, flexShrink: 1 },
  sessionMeta: { ...type.meta, color: c.fg3, marginTop: 2 },
  sets: { ...type.value, lineHeight: 20, color: c.fg2, marginTop: 3 },
  set: { color: c.fg },
  setQuiet: { color: c.fg3 },
  note: { ...type.caption, color: c.fg2, marginTop: 6 },
  sessionValue: { alignItems: "flex-end", gap: 6 },
  sessionNumber: { ...numeral(22, "300"), color: c.fg },
  link: { ...type.rowTitle, color: c.fg },
  after: { marginTop: 22 },
}));
