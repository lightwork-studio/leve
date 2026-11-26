import type { WeightUnit } from "@leve/core";
import { Link } from "expo-router";
import { useMemo, useState } from "react";
import { type ImageSourcePropType, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { choiceLabel } from "../data/custom-exercises.ts";
import {
  MUSCLE_PERIODS,
  type MuscleAmounts,
  type MuscleContribution,
  type MuscleMeasure,
  type MusclePeriod,
  type MuscleTargets,
  musclePeriodBounds,
  muscleStep,
  periodMuscleActivity,
  rankedMuscles,
  type TargetLookup,
  targetAmounts,
} from "../model/muscle-map.ts";
import type { ExerciseHistory, WorkoutPoint } from "../model/progress.ts";
import { numeral, radius, space, type } from "../theme.ts";
import { ChartTabs, Segmented } from "./chart-controls.tsx";
import { ExercisePlate, PLATE_PRIMARY, PLATE_SECONDARY } from "./exercise-image.tsx";
import { readoutWeight, wholeWeight } from "./format.ts";
import { ChevronIcon } from "./icons.tsx";
import { MuscleFigure } from "./muscle-figure.tsx";
import { FIGURE_MUSCLES } from "./muscle-geometry.ts";
import { amountLabel, spokenMuscles } from "./muscle-strip.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** How a muscle amount reads: sets, or weight in the lifter's unit. */
interface Format {
  /** Short, for a row's end. */
  short: (value: number) => string;
  /** In full, for the readout. */
  full: (value: number) => string;
  unit: string;
  /** Spoken, with its unit. */
  spoken: (value: number) => string;
}

const setsFormat: Format = {
  short: amountLabel,
  full: amountLabel,
  unit: "sets",
  spoken: (value) => `${amountLabel(value)} ${value === 1 ? "set" : "sets"}`,
};

function weightFormat(unit: WeightUnit): Format {
  return {
    short: (kg) => readoutWeight(kg, unit),
    full: (kg) => wholeWeight(kg, unit),
    unit,
    spoken: (kg) => `${wholeWeight(kg, unit)} ${unit}`,
  };
}

/**
 * The current workout's muscles as a row: a small figure, how many sets count so far and the three
 * muscles worked most. It opens the whole breakdown, where the figure and the list pick out a
 * muscle together.
 */
export function WorkoutMuscleSummary({ amounts, sets }: { amounts: MuscleAmounts; sets: number }) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const rows = useMemo(() => rankedMuscles(amounts), [amounts]);
  const toggle = (group: string) => setSelected((was) => (was === group ? null : group));
  return (
    <>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Muscles in this workout: ${rows.length ? spokenMuscles(rows) : "no sets logged yet"}`}
        accessibilityHint="Opens muscle activity"
        onPress={() => setOpen(true)}
        scaleTo={0.99}
        style={styles.mini}
      >
        <MuscleFigure amounts={amounts} height={38} gap={2} accessibilityLabel="" />
        <View style={styles.miniText}>
          <Text style={styles.miniLabel} numberOfLines={1}>
            {`Muscles · ${sets} ${sets === 1 ? "set" : "sets"}`}
          </Text>
          <Text style={[styles.miniNames, !rows.length && styles.miniNone]} numberOfLines={1}>
            {rows.length
              ? rows
                  .slice(0, 3)
                  .map(([group]) => choiceLabel(group))
                  .join(" · ")
              : "None logged yet"}
          </Text>
        </View>
        <ChevronIcon direction="right" color={c.fg3} size={14} />
      </Tap>
      {open && (
        <Modal
          aria-label="Muscle activity"
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setOpen(false)}
        >
          <View
            style={[
              styles.page,
              { paddingTop: insets.top + space.sm, paddingBottom: insets.bottom },
            ]}
          >
            <View style={styles.toolbar}>
              <Text accessibilityRole="header" style={styles.heading}>
                Muscle activity
              </Text>
              <Tap accessibilityRole="button" onPress={() => setOpen(false)} style={styles.close}>
                <Text style={styles.action}>Close</Text>
              </Tap>
            </View>
            <ScrollView>
              <View style={styles.card}>
                <View style={styles.figure}>
                  <MuscleFigure
                    amounts={amounts}
                    height={236}
                    gap={26}
                    labels
                    selected={selected}
                    onSelect={toggle}
                    accessibilityLabel={`This workout: ${rows.length ? spokenMuscles(rows) : "no sets yet"}`}
                  />
                </View>
                <MuscleRows
                  rows={rows}
                  zeros={[]}
                  selected={selected}
                  onSelect={toggle}
                  format={setsFormat}
                />
                {rows.length === 0 && <Text style={styles.empty}>No counted sets yet.</Text>}
              </View>
            </ScrollView>
          </View>
        </Modal>
      )}
    </>
  );
}

/**
 * Muscles in a list, most first, each with its shade, a bar and its amount. A row picks out its
 * muscle (on the figure too); untrained muscles, when shown, come last and greyed.
 */
function MuscleRows({
  rows,
  zeros,
  selected,
  onSelect,
  format,
}: {
  rows: readonly [string, number][];
  zeros: readonly string[];
  selected: string | null;
  onSelect: (group: string) => void;
  format: Format;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const max = rows[0]?.[1] ?? 0;
  const all: [string, number][] = [...rows, ...zeros.map((g): [string, number] => [g, 0])];
  if (!all.length) return null;
  return (
    <View accessibilityRole="list" style={styles.rows}>
      {all.map(([group, value], i) => {
        const on = selected === group;
        const zero = value === 0;
        return (
          <Tap
            key={group}
            accessibilityRole="button"
            accessibilityLabel={`${choiceLabel(group)}, ${zero ? "not trained" : format.spoken(value)}`}
            accessibilityState={{ selected: on }}
            accessibilityHint={on ? "Clears the highlight" : "Highlights it on the figure"}
            onPress={() => onSelect(group)}
            scaleTo={1}
            style={[styles.row, i > 0 && styles.rowDivider, on && styles.rowOn]}
          >
            {on && <View style={styles.rowMark} />}
            <View
              style={[styles.swatch, { backgroundColor: c.muscle.ramp[muscleStep(value, max)] }]}
            />
            <Text style={[styles.rowName, zero && styles.dim]} numberOfLines={1}>
              {choiceLabel(group)}
            </Text>
            <View style={styles.track}>
              {!zero && <View style={[styles.fill, { width: `${(value / max) * 100}%` }]} />}
            </View>
            <Text style={[styles.rowValue, on && styles.rowValueOn, zero && styles.dim]}>
              {zero ? "—" : format.short(value)}
            </Text>
          </Tap>
        );
      })}
    </View>
  );
}

/** What each shade stands for: none, then up to a quarter, half, three quarters and all of the most. */
function MuscleLegend({ max, format }: { max: number; format: Format }) {
  const styles = useStyles(sheet);
  const c = useColors();
  if (!(max > 0)) return null;
  const items: [number, string][] = [[0, "None"]];
  for (let step = 1; step <= 4; step++) {
    const bound = (max * step) / 4;
    // Sets come in halves (a secondary muscle's credit), so a bound is shown to the half below it.
    items.push([
      step,
      `≤${format.short(format === setsFormat ? Math.floor(bound * 2) / 2 : bound)}`,
    ]);
  }
  return (
    <View
      style={styles.legend}
      accessible
      accessibilityLabel={`Shades from none to ${format.spoken(max)}`}
    >
      {items.map(([step, label]) => (
        <View key={step} style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: c.muscle.ramp[step] }]} />
          <Text style={styles.legendText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

const MEASURES: { value: MuscleMeasure; label: string }[] = [
  { value: "sets", label: "Sets" },
  { value: "volume", label: "Volume" },
];

/**
 * Progress's muscle card: sets or volume per muscle over a period, as a figure and a list that pick
 * out a muscle together. A picked muscle's exercises open from the readout.
 */
export function MuscleCard({
  exercises,
  workouts,
  today,
  lookup,
  unit,
}: {
  exercises: ExerciseHistory[];
  workouts: WorkoutPoint[];
  today: number;
  lookup: TargetLookup;
  unit: WeightUnit;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [measure, setMeasure] = useState<MuscleMeasure>("sets");
  const [period, setPeriod] = useState<MusclePeriod>("30d");
  const [selected, setSelected] = useState<string | null>(null);
  const [showZeros, setShowZeros] = useState(false);
  const [sources, setSources] = useState(false);
  const bounds = useMemo(() => musclePeriodBounds(period, today), [period, today]);
  const activity = useMemo(
    () => periodMuscleActivity(exercises, bounds.start, bounds.end, lookup, measure),
    [exercises, bounds, lookup, measure],
  );
  // Whether a muscle without volume still had sets, to say why it is blank.
  const setsOnly = useMemo(
    () =>
      measure === "volume"
        ? periodMuscleActivity(exercises, bounds.start, bounds.end, lookup, "sets").amounts
        : null,
    [exercises, bounds, lookup, measure],
  );
  const sessions = useMemo(
    () => workouts.filter((w) => w.time >= bounds.start && w.time < bounds.end).length,
    [workouts, bounds],
  );
  const rows = useMemo(() => rankedMuscles(activity.amounts), [activity]);
  const format = measure === "sets" ? setsFormat : weightFormat(unit);
  const periodName = MUSCLE_PERIODS.find((p) => p.value === period)?.label ?? "";
  const max = rows[0]?.[1] ?? 0;
  const value = selected ? (activity.amounts[selected as keyof MuscleAmounts] ?? 0) : 0;
  const zeros = FIGURE_MUSCLES.filter((g) => !activity.amounts[g as keyof MuscleAmounts]);
  // A picked muscle that wasn't trained shows among the untrained, so its row is there too.
  const zerosShown = showZeros || (!!selected && value === 0);
  const contributions = selected ? activity.byGroup.get(selected) : undefined;
  const toggle = (group: string) => setSelected((was) => (was === group ? null : group));

  let readout: { label: string; value: string; line: string };
  if (selected) {
    const share = activity.total > 0 ? Math.round((value / activity.total) * 100) : 0;
    readout = {
      label: `${choiceLabel(selected)} · ${periodName}`,
      value: value ? format.full(value) : "0",
      line: value
        ? `${share}% of ${measure === "sets" ? "all sets" : `lifted ${unit}`} · step ${muscleStep(value, max)} of 4`
        : setsOnly?.[selected as keyof MuscleAmounts]
          ? "Sets logged, but no lifted weight"
          : "Not trained in this period",
    };
  } else {
    readout = {
      label: `${periodName} · ${sessions} ${sessions === 1 ? "workout" : "workouts"}`,
      value: format.full(activity.total),
      line: rows.length
        ? `Most · ${rows
            .slice(0, 3)
            .map(([g]) => choiceLabel(g))
            .join(" · ")}`
        : "No counted sets yet",
    };
  }

  return (
    <View>
      <View style={styles.tabs}>
        <ChartTabs options={MEASURES} value={measure} onChange={setMeasure} />
      </View>
      <View style={styles.readout} accessibilityLiveRegion="polite">
        <Text style={[styles.label, selected && styles.labelOn]}>{readout.label}</Text>
        <Text
          style={styles.number}
          accessibilityLabel={`${readout.value} ${format.unit}`}
          numberOfLines={1}
        >
          {readout.value}
          <Text style={styles.unit}> {format.unit}</Text>
        </Text>
        <Text style={styles.line} numberOfLines={1}>
          {readout.line}
        </Text>
        {contributions && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`${choiceLabel(selected ?? "")}: view ${contributions.length} ${contributions.length === 1 ? "exercise" : "exercises"}`}
            onPress={() => setSources(true)}
            style={styles.sourcesLink}
          >
            <Text style={styles.action}>
              {contributions.length} {contributions.length === 1 ? "exercise" : "exercises"}
            </Text>
            <ChevronIcon color={c.fg2} size={14} />
          </Tap>
        )}
      </View>
      <View style={styles.figure}>
        <MuscleFigure
          amounts={activity.amounts}
          height={236}
          gap={26}
          labels
          selected={selected}
          onSelect={toggle}
          accessibilityLabel={`Muscle map, ${measure} by muscle, ${periodName}${rows.length ? `: ${rows.map(([g, v]) => `${choiceLabel(g)} ${format.spoken(v)}`).join(", ")}` : ""}`}
        />
      </View>
      <MuscleLegend max={max} format={format} />
      <View style={styles.pad}>
        <Segmented
          kind="choice"
          soft
          label="Period"
          options={MUSCLE_PERIODS}
          value={period}
          onChange={(next) => setPeriod(next)}
        />
      </View>
      <View style={styles.list}>
        <MuscleRows
          rows={rows}
          zeros={zerosShown ? zeros : []}
          selected={selected}
          onSelect={toggle}
          format={format}
        />
        {zeros.length > 0 && !(selected && value === 0) && (
          <Tap
            accessibilityRole="button"
            accessibilityState={{ expanded: showZeros }}
            onPress={() => setShowZeros(!showZeros)}
            scaleTo={1}
            style={[styles.more, rows.length > 0 && styles.rowDivider]}
          >
            <Text style={styles.action}>
              {showZeros ? "Hide" : "Show"} {zeros.length} untrained
            </Text>
          </Tap>
        )}
      </View>
      {sources && selected && contributions && (
        <ContributionSheet
          group={selected}
          period={periodName}
          sources={contributions}
          format={format}
          onClose={() => setSources(false)}
        />
      )}
    </View>
  );
}

/**
 * An exercise's own muscles and their names. Most exercises show the figure with their primary
 * muscles darkest. One with an image shows it across the top of the card instead, and the names
 * below take the image's colours as their key.
 */
export function ExerciseMuscles({
  targets,
  image,
  name,
}: {
  targets: MuscleTargets | undefined;
  /** The exercise's image, when it has one. */
  image?: ImageSourcePropType | null;
  /** The exercise's name, for the image's description. */
  name?: string;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const amounts = useMemo(() => targetAmounts(targets), [targets]);
  if (!targets) return <Text style={styles.empty}>Muscle information unavailable.</Text>;
  const primary = targets.primaryMuscles.map(choiceLabel);
  const secondary = targets.secondaryMuscles.map(choiceLabel);
  return (
    <View style={image ? undefined : styles.exercise}>
      {image ? (
        <ExercisePlate
          source={image}
          height={290}
          radius={0}
          zoom={1.17}
          label={`${name ?? "The exercise"}, with the muscles it works highlighted`}
        />
      ) : (
        <MuscleFigure
          amounts={amounts}
          height={124}
          accessibilityLabel={`Primary ${primary.join(", ")}${secondary.length ? `, secondary ${secondary.join(", ")}` : ""}`}
        />
      )}
      <View style={image ? styles.exerciseKey : styles.exerciseText}>
        <View style={[styles.exerciseKind, !!image && styles.keyCell]}>
          <Text style={styles.label}>Primary</Text>
          <View style={styles.exerciseName}>
            <View
              style={[styles.dot, { backgroundColor: image ? PLATE_PRIMARY : c.muscle.ramp[4] }]}
            />
            <Text style={styles.primary}>{primary.join(" · ")}</Text>
          </View>
        </View>
        <View style={[styles.exerciseKind, !!image && styles.keyCell]}>
          <Text style={styles.label}>Secondary</Text>
          <View style={styles.exerciseName}>
            {secondary.length > 0 && (
              <View
                style={[
                  styles.dot,
                  { backgroundColor: image ? PLATE_SECONDARY : c.muscle.ramp[2] },
                ]}
              />
            )}
            <Text style={styles.secondary}>
              {secondary.length ? secondary.join(" · ") : "None"}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

/** The exercises behind a muscle's total, each opening its sessions. */
function ContributionSheet({
  group,
  period,
  sources,
  format,
  onClose,
}: {
  group: string;
  period: string;
  sources: MuscleContribution[];
  format: Format;
  onClose: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const total = sources.reduce((sum, row) => sum + row.credit, 0);
  const weight = format !== setsFormat;
  return (
    <Modal
      aria-label={`${weight ? "Volume" : "Sets"} for ${choiceLabel(group).toLowerCase()}`}
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        style={[styles.page, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom }]}
      >
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={[styles.heading, styles.flex]}>
            {choiceLabel(group)}
          </Text>
          <Tap accessibilityRole="button" onPress={onClose} style={styles.close}>
            <Text style={styles.action}>Close</Text>
          </Tap>
        </View>
        <Text style={styles.sourceMeta}>
          {format.spoken(total)} · {period}
        </Text>
        <ScrollView>
          <View style={styles.card}>
            {sources.map((row, i) => (
              <Link
                key={row.exerciseId}
                href={{
                  pathname: "/exercise/[id]",
                  params: { id: row.exerciseId, from: "muscleActivity" },
                }}
                asChild
              >
                <Tap
                  onPress={onClose}
                  accessibilityRole="link"
                  accessibilityHint="Open all sessions with this exercise"
                  style={StyleSheet.flatten([styles.source, i > 0 && styles.rowDivider])}
                >
                  <View style={styles.flex}>
                    <Text style={styles.sourceName}>{row.name}</Text>
                    <Text style={styles.sourceMeta}>
                      {weight
                        ? `${format.spoken(row.sets)} lifted`
                        : `${row.sets} counted ${row.sets === 1 ? "set" : "sets"}`}{" "}
                      · {row.credit === row.sets ? "Full credit" : "Half credit"}
                    </Text>
                  </View>
                  <Text style={styles.sourceValue}>{format.spoken(row.credit)}</Text>
                  <View aria-hidden importantForAccessibility="no-hide-descendants">
                    <ChevronIcon color={c.fg3} size={16} />
                  </View>
                </Tap>
              </Link>
            ))}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const sheet = themedStyles((c) => ({
  flex: { flex: 1 },
  mini: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 15,
    paddingVertical: 4,
    paddingLeft: 6,
    paddingRight: 10,
  },
  miniText: { flex: 1, minWidth: 0, gap: 5 },
  miniLabel: { ...type.label, color: c.fg3 },
  miniNames: { ...type.value, color: c.fg },
  miniNone: { color: c.fg3 },
  page: { flex: 1, backgroundColor: c.bg, paddingHorizontal: space.lg },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: space.md,
  },
  heading: { ...type.heading, color: c.fg },
  close: { minHeight: 44, paddingHorizontal: space.md, justifyContent: "center" },
  action: { ...type.action, color: c.fg2 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
    marginBottom: space.xl,
  },
  empty: { ...type.body, color: c.fg2, padding: space.lg },
  exercise: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 14,
    paddingHorizontal: 16,
  },
  exerciseText: { flex: 1, minWidth: 0, gap: 12 },
  // Under an image: the primary and secondary names side by side.
  exerciseKey: { flexDirection: "row", gap: 16, paddingVertical: 14, paddingHorizontal: 16 },
  exerciseKind: { gap: 6 },
  keyCell: { flex: 1, minWidth: 0 },
  exerciseName: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 3 },
  primary: { ...type.cardTitle, fontSize: 19, lineHeight: 22, color: c.fg, flexShrink: 1 },
  secondary: { ...type.body, fontSize: 14, lineHeight: 19, color: c.fg2, flexShrink: 1 },
  tabs: { paddingTop: 4, paddingHorizontal: 16 },
  readout: { paddingTop: 14, paddingHorizontal: 16 },
  label: { ...type.label, color: c.fg3 },
  // Room for the exercises link beside it.
  labelOn: { color: c.fg, paddingRight: 112 },
  number: { ...numeral(52), color: c.fg, marginTop: 10 },
  unit: { ...type.unit, fontSize: 12, color: c.fg3 },
  line: { ...type.value, fontSize: 11.5, color: c.fg2, marginTop: 10, minHeight: 15 },
  // At the readout's top right, so picking a muscle doesn't move the figure.
  sourcesLink: {
    position: "absolute",
    top: 0,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 44,
  },
  figure: { alignItems: "center", paddingTop: 18, paddingBottom: 6 },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    columnGap: 12,
    rowGap: 6,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 2,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch: { width: 14, height: 10, borderRadius: 3 },
  legendText: { ...type.meta, fontSize: 10, letterSpacing: 0.6, color: c.fg2 },
  pad: { paddingTop: 12, paddingHorizontal: 16, paddingBottom: 14 },
  list: { borderTopWidth: 1, borderTopColor: c.line },
  rows: {},
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: c.line },
  rowOn: { backgroundColor: c.s2 },
  rowMark: {
    position: "absolute",
    left: 0,
    top: 9,
    bottom: 9,
    width: 3,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: c.fg,
  },
  swatch: { width: 14, height: 10, borderRadius: 3 },
  rowName: { ...type.body, fontSize: 13.5, color: c.fg, width: 96 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: c.s3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3, backgroundColor: c.fg },
  rowValue: { ...type.value, color: c.fg2, minWidth: 46, textAlign: "right" },
  rowValueOn: { color: c.fg },
  dim: { color: c.fg3 },
  more: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  source: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  sourceName: { ...type.rowTitle, color: c.fg },
  sourceMeta: { ...type.meta, color: c.fg3, marginTop: 4 },
  sourceValue: { ...type.value, color: c.fg2 },
}));
