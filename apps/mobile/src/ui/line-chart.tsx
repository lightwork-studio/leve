import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type GestureResponderEvent, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import { space, type } from "../theme.ts";
import { CrossFade } from "./cross-fade.tsx";
import { haptic } from "./haptics.ts";
import { alignLines, areaPath, lerpLine, linePath, NO_LINE, type Polyline } from "./line-tween.ts";
import { emphasised } from "./motion.ts";
import { themedStyles, useColors, useStyles } from "./themed.ts";

const PLOT_HEIGHT = 140;
const AXIS_WIDTH = 52;
const PAD = 6;
const LABEL_GAP = 48;
/** A note in an empty stretch needs this much room. */
const NOTE_WIDTH = 120;
/** Moving from one line to the next. */
const TWEEN = 300;
/** Drawing in from the left, the first time. */
const REVEAL = 520;

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedLine = Animated.createAnimatedComponent(Line);

export interface LineChartProps {
  /**
   * Points with x from 0 (left) to 1 (right), oldest first. `time` matches points up when the chart
   * changes, so each moves from where it was to where it goes.
   */
  points: { time: number; x: number; value: number }[];
  axis: { low: number; step: number; high: number };
  tickLabel: (value: number) => string;
  /** Names under the chart at x from 0 to 1, thinned out when they would crowd. */
  marks: { x: number; label: string }[];
  /** A note over an empty start of the chart, e.g. "No sessions before 3 Aug", and its share. */
  lead?: { share: number; label: string } | null;
  accessibilityLabel: string;
  /** The point picked out (the latest by default). */
  selected?: number;
  /**
   * Makes the chart scrubbable: touching or dragging across it picks the nearest point, and screen
   * readers step through the points with the adjust gestures.
   */
  onSelect?: (index: number) => void;
  /** What a point holds, spoken as a screen reader steps onto it. */
  describe?: (index: number) => string;
}

/**
 * A line over time, drawn with SVG, with a soft fill under it and a dot on the latest value. The
 * line draws in from the left when it first appears; after that, showing something else moves the
 * line it had into the new one (and the axis names cross-fade), instant with reduced motion.
 */
export function LineChart({
  points,
  axis,
  tickLabel,
  marks,
  lead,
  accessibilityLabel,
  selected,
  onSelect,
  describe,
}: LineChartProps) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [width, setWidth] = useState(0);
  const chosen = selected ?? points.length - 1;
  // The picked point by its time, so the dot stays on it while the line moves to new values.
  const pickedTime = useSharedValue(points[chosen]?.time ?? -1);
  const last = useRef(chosen);
  last.current = chosen;
  const chosenTime = points[chosen]?.time ?? -1;
  useEffect(() => {
    pickedTime.value = chosenTime;
  }, [chosenTime, pickedTime]);
  // Its own gradient id: SVG ids are shared by the whole page on the web, and another chart may
  // still be mounted underneath (a pushed screen). Only letters and digits, to be safe in url().
  const fill = `fill-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const span = axis.high - axis.low || 1;
  const x = (at: number) => PAD + at * Math.max(0, width - PAD * 2);
  const y = (value: number) => PAD + (1 - (value - axis.low) / span) * (PLOT_HEIGHT - PAD * 2);

  const target = useMemo<Polyline>(() => {
    const inner = Math.max(0, width - PAD * 2);
    const high = axis.high - axis.low || 1;
    return {
      t: points.map((p) => p.time),
      x: points.map((p) => PAD + p.x * inner),
      y: points.map((p) => PAD + (1 - (p.value - axis.low) / high) * (PLOT_HEIGHT - PAD * 2)),
    };
  }, [points, width, axis.low, axis.high]);

  // The line goes from `from` to `to` as progress runs from 0 to 1. Copies are kept here too, so a
  // change in the middle of a move starts from where the line is.
  const from = useSharedValue<Polyline>(NO_LINE);
  const to = useSharedValue<Polyline>(NO_LINE);
  const progress = useSharedValue(1);
  const ends = useRef<{ from: Polyline; to: Polyline }>({ from: NO_LINE, to: NO_LINE });
  // The line last asked for, as it is: a finished move starts from this, not from the merged
  // vertices of both lines, which would otherwise pile up move after move.
  const lastLine = useRef<Polyline>(NO_LINE);
  const drawnWidth = useRef(0);
  // A cover over the plot slides away to the right, revealing the line.
  const cover = useSharedValue(0);

  useLayoutEffect(() => {
    if (width === 0) return;
    const now =
      progress.value >= 1
        ? lastLine.current
        : lerpLine(ends.current.from, ends.current.to, progress.value);
    lastLine.current = target;
    const resized = drawnWidth.current !== width;
    drawnWidth.current = width;
    const pair = resized ? null : alignLines(now, target);
    if (pair) {
      ends.current = { from: pair[0], to: pair[1] };
      from.value = pair[0];
      to.value = pair[1];
      progress.value = 0;
      progress.value = withTiming(1, { duration: TWEEN, easing: emphasised });
      return;
    }
    // Nothing to move from (or the plot changed size): the line is simply drawn.
    ends.current = { from: target, to: target };
    from.value = target;
    to.value = target;
    progress.value = 1;
    if (now.t.length === 0 && target.t.length > 0) {
      cover.value = 0;
      cover.value = withTiming(1, { duration: REVEAL, easing: Easing.out(Easing.cubic) });
    }
  }, [target, width, from, to, progress, cover]);

  const drawn = useDerivedValue(() => lerpLine(from.value, to.value, progress.value));
  const lineProps = useAnimatedProps(() => ({ d: linePath(drawn.value) }));
  const areaProps = useAnimatedProps(() => ({ d: areaPath(drawn.value, PLOT_HEIGHT - PAD) }));
  const at = useDerivedValue(() => {
    const line = drawn.value;
    const found = line.t.indexOf(pickedTime.value);
    return found < 0 ? line.t.length - 1 : found;
  });
  const dotProps = useAnimatedProps(() => {
    const line = drawn.value;
    const i = at.value;
    return i < 0
      ? { cx: 0, cy: 0, r: 0 }
      : { cx: line.x[i] as number, cy: line.y[i] as number, r: 5 };
  });
  const ruleProps = useAnimatedProps(() => {
    const i = at.value;
    const x = i < 0 ? -10 : (drawn.value.x[i] as number);
    return { x1: x, x2: x };
  });
  const pick = (index: number) => {
    const next = Math.max(0, Math.min(points.length - 1, index));
    if (!onSelect || next === last.current || points.length === 0) return;
    last.current = next;
    pickedTime.value = points[next]?.time ?? -1;
    haptic.select();
    onSelect(next);
  };
  const scrub = (event: GestureResponderEvent) => {
    const finger = event.nativeEvent.locationX;
    let nearest = -1;
    let distance = Number.POSITIVE_INFINITY;
    target.x.forEach((px, i) => {
      const d = Math.abs(px - finger);
      if (d < distance) {
        distance = d;
        nearest = i;
      }
    });
    if (nearest >= 0) pick(nearest);
  };
  const coverStyle = useAnimatedStyle(() => ({ transform: [{ translateX: cover.value * width }] }));

  const shown: { x: number; label: string }[] = [];
  for (const mark of marks) {
    const previous = shown.at(-1);
    if (!previous || (mark.x - previous.x) * width >= LABEL_GAP) shown.push(mark);
  }
  // Without points the lines have nothing to measure, so they go unnamed.
  const ticks =
    points.length > 0
      ? [2, 1, 0].map((line) => ({ line, label: tickLabel(axis.low + line * axis.step) }))
      : [];
  const note = lead && x(lead.share) >= NOTE_WIDTH ? lead : null;

  return (
    <View
      accessible
      accessibilityRole={onSelect ? "adjustable" : "image"}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={
        onSelect && describe && points.length ? { text: describe(chosen) } : undefined
      }
      accessibilityActions={onSelect ? [{ name: "increment" }, { name: "decrement" }] : undefined}
      onAccessibilityAction={
        onSelect
          ? (event) => pick(chosen + (event.nativeEvent.actionName === "increment" ? 1 : -1))
          : undefined
      }
    >
      <View style={styles.row}>
        <View style={styles.plot} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {width > 0 && (
            <Svg width={width} height={PLOT_HEIGHT}>
              <Defs>
                <LinearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={c.fg} stopOpacity={0.16} />
                  <Stop offset="1" stopColor={c.fg} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <AnimatedPath animatedProps={areaProps} fill={`url(#${fill})`} />
              <AnimatedPath
                animatedProps={lineProps}
                stroke={c.fg}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                fill="none"
              />
              {onSelect && (
                <AnimatedLine
                  animatedProps={ruleProps}
                  y1={PAD}
                  y2={PLOT_HEIGHT - PAD}
                  stroke={c.fg}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  strokeOpacity={0.55}
                />
              )}
              <AnimatedCircle animatedProps={dotProps} fill={c.s1} stroke={c.fg} strokeWidth={2} />
            </Svg>
          )}
          <Animated.View pointerEvents="none" style={[styles.cover, coverStyle]} />
          {width > 0 && (
            <Svg width={width} height={PLOT_HEIGHT} style={StyleSheet.absoluteFill}>
              {[0, 1, 2].map((i) => {
                const at = y(axis.low + i * axis.step);
                return (
                  <Line key={i} x1={0} x2={width} y1={at} y2={at} stroke={c.line} strokeWidth={1} />
                );
              })}
            </Svg>
          )}
          <CrossFade id={note?.label ?? ""} style={StyleSheet.absoluteFill}>
            {note && (
              <Text numberOfLines={2} style={[styles.note, { width: x(note.share) - space.md }]}>
                {note.label}
              </Text>
            )}
          </CrossFade>
          {onSelect && (
            // A plain layer over the line takes the touch, so its place is measured across the plot.
            <View
              testID="line-chart-scrub"
              style={StyleSheet.absoluteFill}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={scrub}
              onResponderMove={scrub}
            />
          )}
        </View>
        <CrossFade id={ticks.map((tick) => tick.label).join("|")} style={styles.axis}>
          {ticks.map((tick) => (
            <Text
              key={tick.line}
              style={[styles.tick, { top: y(axis.low + tick.line * axis.step) - 9 }]}
              numberOfLines={1}
            >
              {tick.label}
            </Text>
          ))}
        </CrossFade>
      </View>
      <CrossFade
        id={shown.map((m) => `${m.x}${m.label}`).join()}
        style={[styles.marks, { marginRight: AXIS_WIDTH }]}
      >
        {width > 0 &&
          shown.map((mark) => (
            <Text
              key={`${mark.x}-${mark.label}`}
              numberOfLines={1}
              style={[styles.mark, { left: Math.min(x(mark.x), width - 36) }]}
            >
              {mark.label}
            </Text>
          ))}
      </CrossFade>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  row: { flexDirection: "row" },
  plot: { flex: 1, height: PLOT_HEIGHT, overflow: "hidden" },
  cover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.s1 },
  note: {
    position: "absolute",
    left: PAD,
    bottom: PAD + space.sm,
    ...type.caption,
    color: c.fg2,
  },
  axis: { width: AXIS_WIDTH, height: PLOT_HEIGHT },
  tick: { position: "absolute", left: space.sm, ...type.meta, fontSize: 9.5, color: c.fg3 },
  marks: { height: 22, marginTop: space.xs },
  mark: { position: "absolute", ...type.meta, fontSize: 9.5, color: c.fg3 },
}));
