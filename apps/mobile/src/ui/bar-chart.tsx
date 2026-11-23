import { useNavigation } from "expo-router";
import { memo, useEffect, useRef, useState } from "react";
import { type GestureResponderEvent, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Line } from "react-native-svg";
import { space, type } from "../theme.ts";
import { CrossFade } from "./cross-fade.tsx";
import { haptic } from "./haptics.ts";
import { easeOut, emphasised } from "./motion.ts";
import { themedStyles, useColors, useStyles } from "./themed.ts";

const PLOT_HEIGHT = 150;
const AXIS_WIDTH = 44;
const LABEL_GAP = 40;
const ease = Easing.out(Easing.cubic);
/** Bars moving to new places and widths, when the chart covers another span. */
const MOVE = 300;
/** A note in an empty stretch needs this much room. */
const NOTE_WIDTH = 120;

export interface BarChartProps {
  /**
   * One value per bar, oldest first; the last bar is highlighted. Keys name what a bar stands for (a
   * week, say): a bar that stays when the chart changes moves to its new place.
   */
  bars: { key: string; value: number }[];
  /** The value at the top line; the middle line is half of it. */
  top: number;
  /** Labels for the top, middle and bottom lines. */
  tickLabel: (value: number) => string;
  /** Names under the bars, at their index (thinned out when they would crowd). */
  marks: { index: number; label: string }[];
  /** Above the chart, e.g. the highlighted bar's week; left out when a readout says it. */
  highlightLabel?: string;
  /** The highlighted bar (the latest by default). */
  selected?: number;
  /**
   * Makes the chart scrubbable: touching or dragging across it picks the bar under the finger, and
   * screen readers step through the bars with the adjust gestures.
   */
  onSelect?: (index: number) => void;
  /** What a bar holds, spoken as a screen reader steps onto it. */
  describe?: (index: number) => string;
  /** A dashed line across the chart, e.g. the average. */
  average?: number | null;
  /** A note over an empty start of the chart, e.g. "No workouts before 3 Aug", and its share. */
  lead?: { share: number; label: string } | null;
  /** What the chart says, for screen readers. */
  accessibilityLabel: string;
}

/** A bar as drawn: where it sits, in slots of the plot's width, and whether it is on its way out. */
interface Drawn {
  key: string;
  value: number;
  slot: number;
  slots: number;
  highlighted: boolean;
  leaving: boolean;
}

/**
 * Bars drawn with plain views. Each bar grows to its height when the chart is first seen and moves
 * smoothly when its value or the scale changes (instant with reduced motion). When the chart covers
 * another span, bars that stay slide and narrow (or widen) to their new places, new ones fade in,
 * and ones no longer covered slide on with them as they fade. A chart built out of sight (a tab
 * prepared ahead of time) waits flat until its screen is shown, then grows.
 */
export function BarChart({
  bars,
  top,
  tickLabel,
  marks,
  highlightLabel,
  selected,
  onSelect,
  describe,
  average,
  lead,
  accessibilityLabel,
}: BarChartProps) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [width, setWidth] = useState(0);
  const seen = useSeen();
  const chosen = selected ?? bars.length - 1;
  const drawn = useDrawnBars(bars, chosen);
  const last = useRef(chosen);
  last.current = chosen;
  const slot = bars.length > 0 ? width / bars.length : 0;
  // A name is shown only if it has room after the one before it.
  // A month that only just starts the chart gives way to the next when they would crowd.
  const [first, second] = marks;
  const skipFirst = first?.index === 0 && second !== undefined && second.index * slot < LABEL_GAP;
  const shown: { index: number; label: string }[] = [];
  for (const mark of skipFirst ? marks.slice(1) : marks) {
    const last = shown.at(-1);
    if (!last || (mark.index - last.index) * slot >= LABEL_GAP) shown.push(mark);
  }
  const gap = Math.max(1, Math.min(6, slot * 0.25));
  const ticks = [1, 0.5, 0].map((at) => ({ at, label: tickLabel(top * at) }));
  const note = lead && lead.share * width >= NOTE_WIDTH ? lead : null;
  const pick = (index: number) => {
    const at = Math.max(0, Math.min(bars.length - 1, index));
    if (!onSelect || at === last.current || bars.length === 0) return;
    last.current = at;
    haptic.select();
    onSelect(at);
  };
  const scrub = (event: GestureResponderEvent) => {
    if (slot > 0) pick(Math.floor(event.nativeEvent.locationX / slot));
  };
  const averageY = average && top > 0 && average <= top ? PLOT_HEIGHT * (1 - average / top) : null;
  return (
    <View
      accessible
      accessibilityRole={onSelect ? "adjustable" : "image"}
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={onSelect && describe ? { text: describe(chosen) } : undefined}
      accessibilityActions={onSelect ? [{ name: "increment" }, { name: "decrement" }] : undefined}
      onAccessibilityAction={
        onSelect
          ? (event) => pick(chosen + (event.nativeEvent.actionName === "increment" ? 1 : -1))
          : undefined
      }
    >
      {highlightLabel !== undefined && (
        <Text style={[styles.highlightLabel, { marginRight: AXIS_WIDTH }]} numberOfLines={1}>
          {highlightLabel}
        </Text>
      )}
      <View style={styles.row}>
        <View style={styles.plot} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {[0, 0.5, 1].map((at) => (
            <View
              key={at}
              style={[styles.grid, { top: PLOT_HEIGHT * (1 - at) }, at === 0 && styles.baseline]}
            />
          ))}
          {width > 0 &&
            drawn.bars.map((bar) => (
              <Bar
                key={bar.key}
                x={(bar.slot * width) / bar.slots}
                width={width / bar.slots}
                height={seen && top > 0 ? (Math.min(bar.value, top) / top) * PLOT_HEIGHT : 0}
                highlighted={bar.highlighted}
                leaving={bar.leaving}
                arriving={drawn.changed}
              />
            ))}
          {averageY !== null && width > 0 && (
            <Svg
              width={width}
              height={PLOT_HEIGHT}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            >
              <Line
                x1={0}
                x2={width}
                y1={averageY}
                y2={averageY}
                stroke={c.fg3}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            </Svg>
          )}
          <CrossFade id={note?.label ?? ""} style={StyleSheet.absoluteFill}>
            {note && (
              <Text
                numberOfLines={2}
                style={[styles.note, { width: note.share * width - space.sm }]}
              >
                {note.label}
              </Text>
            )}
          </CrossFade>
          {onSelect && (
            // A plain layer over the bars takes the touch, so its place is measured across the plot.
            <View
              testID="bar-chart-scrub"
              style={StyleSheet.absoluteFill}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={scrub}
              onResponderMove={scrub}
            />
          )}
        </View>
        {/* The scale's names cross-fade with the bars moving to it, rather than switching at once. */}
        <CrossFade id={ticks.map((tick) => tick.label).join("|")} style={styles.axis}>
          {ticks.map((tick) => (
            <Text key={tick.at} style={[styles.tick, { top: PLOT_HEIGHT * (1 - tick.at) - 9 }]}>
              {tick.label}
            </Text>
          ))}
        </CrossFade>
      </View>
      <CrossFade
        id={`${bars.length}:${shown.map((m) => `${m.index}${m.label}`).join()}`}
        style={[styles.marks, { marginRight: AXIS_WIDTH }]}
      >
        {width > 0 &&
          shown.map((mark) => (
            <Text
              key={`${mark.index}-${mark.label}`}
              numberOfLines={1}
              style={[styles.mark, { left: mark.index * slot + gap / 2 }]}
            >
              {mark.label}
            </Text>
          ))}
      </CrossFade>
    </View>
  );
}

/**
 * The bars to draw: the current ones, plus for a moment the ones that just left. A bar that left
 * slides on with the others to where it would now be (off the plot, mostly), so a chart covering
 * fewer weeks looks like it zooms in. When nothing stays (weeks became months) the old bars simply
 * fade where they were.
 */
function useDrawnBars(
  bars: BarChartProps["bars"],
  chosen: number,
): { bars: Drawn[]; changed: boolean } {
  const [state, setState] = useState(() => ({
    bars,
    leaving: [] as Drawn[],
    changed: false,
    turn: 0,
  }));
  if (state.bars !== bars) {
    const keys = state.bars.map((b) => b.key).join("\n");
    const same = keys === bars.map((b) => b.key).join("\n");
    if (same) setState({ ...state, bars });
    else {
      const next = new Map(bars.map((b, i) => [b.key, i]));
      // How far the bars that stay moved, in slots: the chart ends at the current week either way.
      const kept = state.bars.findIndex((b) => next.has(b.key));
      const shift = kept < 0 ? null : (next.get(state.bars[kept]?.key ?? "") ?? 0) - kept;
      const leaving: Drawn[] = [];
      state.bars.forEach((b, i) => {
        if (next.has(b.key)) return;
        leaving.push({
          key: b.key,
          value: b.value,
          slot: shift === null ? i : i + shift,
          slots: shift === null ? state.bars.length : bars.length,
          highlighted: shift === null && i === state.bars.length - 1,
          leaving: true,
        });
      });
      // Bars still leaving from an earlier change keep going, unless they came back.
      for (const b of state.leaving) {
        if (!next.has(b.key) && !leaving.some((l) => l.key === b.key)) leaving.push(b);
      }
      setState({ bars, leaving, changed: state.bars.length > 0, turn: state.turn + 1 });
    }
  }
  const turn = state.turn;
  useEffect(() => {
    if (turn === 0) return;
    const timer = setTimeout(
      () => setState((now) => (now.turn === turn ? { ...now, leaving: [] } : now)),
      MOVE + 60,
    );
    return () => clearTimeout(timer);
  }, [turn]);
  const current: Drawn[] = bars.map((b, i) => ({
    key: b.key,
    value: b.value,
    slot: i,
    slots: bars.length,
    highlighted: i === chosen,
    leaving: false,
  }));
  return { bars: [...state.leaving, ...current], changed: state.changed };
}

/**
 * Whether the screen around has been shown yet. It renders once more on that first showing, and
 * never again for focus changes.
 */
function useSeen(): boolean {
  const navigation = useNavigation();
  const [seen, setSeen] = useState(() => navigation.isFocused());
  useEffect(() => {
    if (seen) return;
    if (navigation.isFocused()) {
      setSeen(true);
      return;
    }
    return navigation.addListener("focus", () => setSeen(true));
  }, [navigation, seen]);
  return seen;
}

const Bar = memo(function Bar({
  x,
  width,
  height,
  highlighted,
  leaving,
  arriving,
}: {
  x: number;
  width: number;
  height: number;
  highlighted: boolean;
  leaving: boolean;
  /** Whether it is new to a chart already shown, so it fades in (decided when it first appears). */
  arriving: boolean;
}) {
  const shownHeight = useSharedValue(0);
  const left = useSharedValue(x);
  const slot = useSharedValue(width);
  const [fadesIn] = useState(arriving);
  const opacity = useSharedValue(fadesIn ? 0 : 1);
  const placed = useRef(false);
  useEffect(() => {
    shownHeight.value = withTiming(height, { duration: 360, easing: ease });
  }, [height, shownHeight]);
  useEffect(() => {
    // Its first place is set, not animated; afterwards it moves there.
    if (!placed.current) {
      placed.current = true;
      left.value = x;
      slot.value = width;
      return;
    }
    left.value = withTiming(x, { duration: MOVE, easing: emphasised });
    slot.value = withTiming(width, { duration: MOVE, easing: emphasised });
  }, [x, width, left, slot]);
  useEffect(() => {
    opacity.value = leaving
      ? withTiming(0, { duration: 180, easing: easeOut })
      : withDelay(fadesIn ? 80 : 0, withTiming(1, { duration: 220, easing: easeOut }));
  }, [leaving, fadesIn, opacity]);
  const style = useAnimatedStyle(() => {
    // The space between bars follows their width: up to 6 points, a quarter of a narrow slot.
    const gap = Math.max(1, Math.min(6, slot.value * 0.25));
    return {
      left: left.value + gap / 2,
      width: Math.max(0, slot.value - gap),
      height: shownHeight.value,
      opacity: opacity.value,
    };
  });
  const styles = useStyles(sheet);
  return <Animated.View style={[styles.bar, highlighted && styles.barHighlighted, style]} />;
});

const sheet = themedStyles((c) => ({
  highlightLabel: {
    ...type.label,
    color: c.fg,
    textAlign: "right",
    marginBottom: space.xs,
  },
  row: { flexDirection: "row" },
  plot: { flex: 1, height: PLOT_HEIGHT, overflow: "hidden" },
  grid: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: c.line,
  },
  baseline: { backgroundColor: c.line2 },
  bar: {
    position: "absolute",
    bottom: 0,
    backgroundColor: c.bar,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  barHighlighted: { backgroundColor: c.fg },
  note: {
    position: "absolute",
    left: 0,
    bottom: space.md,
    ...type.caption,
    color: c.fg2,
  },
  axis: { width: AXIS_WIDTH, height: PLOT_HEIGHT },
  tick: { position: "absolute", left: space.sm, ...type.meta, fontSize: 9.5, color: c.fg3 },
  marks: { height: 22, marginTop: space.xs },
  mark: { position: "absolute", ...type.meta, fontSize: 9.5, color: c.fg3 },
}));
