import { useCallback, useEffect, useState } from "react";
import {
  type LayoutChangeEvent,
  ScrollView,
  type StyleProp,
  StyleSheet,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { radius, space, type } from "../theme.ts";
import { haptic } from "./haptics.ts";
import { spring } from "./motion.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

type Option<T extends string> = { value: T; label: string };

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One selection mark that slides to the chosen option, like the tab bar's: the options are measured
 * as they are laid out, and the mark springs to the chosen one's place and width. Until they are
 * measured (and on the first placement) it simply sits where it belongs.
 */
function useSlider(index: number) {
  const [frames, setFrames] = useState<(Frame | undefined)[]>([]);
  const measure = useCallback(
    (at: number) => (event: LayoutChangeEvent) => {
      const { x, y, width, height } = event.nativeEvent.layout;
      setFrames((was) => {
        const old = was[at];
        if (old && old.x === x && old.y === y && old.width === width && old.height === height) {
          return was;
        }
        const next = [...was];
        next[at] = { x, y, width, height };
        return next;
      });
    },
    [],
  );
  const frame = frames[index];
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const [placed, setPlaced] = useState(false);
  const toX = frame?.x;
  const toWidth = frame?.width;
  useEffect(() => {
    if (toX === undefined || toWidth === undefined) return;
    if (!placed) {
      x.value = toX;
      width.value = toWidth;
      setPlaced(true);
    } else {
      x.value = withSpring(toX, spring);
      width.value = withSpring(toWidth, spring);
    }
  }, [toX, toWidth, placed, x, width]);
  const mark = useAnimatedStyle(() => ({
    width: width.value,
    transform: [{ translateX: x.value }],
  }));
  return { frames, frame, measure, placed, mark, x };
}

/**
 * An option's label, taking the chosen colour as the mark arrives under it and losing it as the mark
 * leaves, rather than switching at once.
 */
function SlidingLabel({
  label,
  frame,
  x,
  placed,
  active,
  style,
  colors,
}: {
  label: string;
  frame: Frame | undefined;
  x: SharedValue<number>;
  placed: boolean;
  active: boolean;
  style: StyleProp<TextStyle>;
  colors: [string, string];
}) {
  const at = frame?.x ?? 0;
  const span = Math.max(1, frame?.width ?? 1);
  const following = placed && frame !== undefined;
  const [from, to] = colors;
  // Made again when the colours change too, so a change of appearance reaches a label at rest.
  const tint = useAnimatedStyle(() => {
    if (!following) return {};
    const near = Math.max(0, 1 - Math.abs(x.value - at) / span);
    return { color: interpolateColor(near, [0, 1], [from, to]) };
  }, [following, at, span, from, to]);
  return (
    // Once it follows the mark, its colour is the mark's alone: a static colour that changed with
    // the choice would be applied again on rendering and flash for a frame.
    <Animated.Text style={[style, !following && { color: colors[active ? 1 : 0] }, tint]}>
      {label}
    </Animated.Text>
  );
}

/** Tabs with an underline, on a graphite card: what a chart shows. */
export function ChartTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const index = options.findIndex((option) => option.value === value);
  const slider = useSlider(index);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      style={styles.tabsScroll}
      contentContainerStyle={styles.tabs}
    >
      {slider.placed && (
        <Animated.View pointerEvents="none" style={[styles.underline, slider.mark]} />
      )}
      {options.map((option, i) => {
        const active = i === index;
        return (
          <Tap
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            aria-selected={active}
            onLayout={slider.measure(i)}
            onPress={() => {
              if (active) return;
              haptic.select();
              onChange(option.value);
            }}
            scaleTo={0.97}
            style={[styles.tab, active && !slider.placed && styles.tabActive]}
          >
            <SlidingLabel
              label={option.label}
              frame={slider.frames[i]}
              x={slider.x}
              placed={slider.placed}
              active={active}
              style={styles.tabLabel}
              colors={[c.fg3, c.fg]}
            />
          </Tap>
        );
      })}
    </ScrollView>
  );
}

/** Small pills, on a graphite card: how far back a chart goes. */
export function RangePills<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const index = options.indexOf(value);
  const slider = useSlider(index);
  return (
    <View accessibilityRole="radiogroup" style={[styles.pills, style]}>
      {slider.placed && slider.frame && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pillMark,
            { top: slider.frame.y, height: slider.frame.height },
            slider.mark,
          ]}
        />
      )}
      {options.map((option, i) => {
        const active = i === index;
        return (
          <Tap
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            aria-checked={active}
            accessibilityLabel={RANGE_NAMES[option] ?? option}
            onLayout={slider.measure(i)}
            onPress={() => {
              if (active) return;
              haptic.select();
              onChange(option);
            }}
            scaleTo={0.9}
            style={[styles.pill, active && !slider.placed && styles.pillActive]}
          >
            <SlidingLabel
              label={option}
              frame={slider.frames[i]}
              x={slider.x}
              placed={slider.placed}
              active={active}
              style={styles.pillLabel}
              colors={[c.fg2, c.bg]}
            />
          </Tap>
        );
      })}
    </View>
  );
}

const RANGE_NAMES: Record<string, string> = {
  "3M": "Three months",
  "1Y": "One year",
  All: "All time",
};

/**
 * A segmented control: the chosen option is bone with dark text. As `tabs` it switches what a screen
 * shows (Summary · History); as `choice` it is a group of radio buttons for a setting, named by
 * `label`.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  kind = "tabs",
  label,
  soft = false,
  compact = false,
}: {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  kind?: "tabs" | "choice";
  label?: string;
  /** A quieter choice: the chosen option is raised graphite, not bone. */
  soft?: boolean;
  /** A small control at the end of a settings row (it still takes a 44 pt tap). */
  compact?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const choice = kind === "choice";
  const index = options.findIndex((option) => option.value === value);
  const slider = useSlider(index);
  return (
    <View
      accessibilityRole={choice ? "radiogroup" : "tablist"}
      accessibilityLabel={label}
      style={[styles.segmented, compact && styles.segmentedCompact]}
    >
      {slider.placed && slider.frame && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.segmentMark,
            soft && styles.segmentMarkSoft,
            { top: slider.frame.y, height: slider.frame.height },
            slider.mark,
          ]}
        />
      )}
      {options.map((option, i) => {
        const active = i === index;
        return (
          <Tap
            key={option.value}
            accessibilityRole={choice ? "radio" : "tab"}
            accessibilityState={choice ? { checked: active } : { selected: active }}
            {...(choice ? { "aria-checked": active } : { "aria-selected": active })}
            onLayout={slider.measure(i)}
            onPress={() => {
              if (active) return;
              haptic.select();
              onChange(option.value);
            }}
            scaleTo={0.98}
            hitSlop={compact ? 5 : 0}
            style={[
              styles.segment,
              compact && styles.segmentCompact,
              active && !slider.placed && (soft ? styles.segmentMarkSoft : styles.segmentActive),
            ]}
          >
            <SlidingLabel
              label={option.label}
              frame={slider.frames[i]}
              x={slider.x}
              placed={slider.placed}
              active={active}
              style={styles.segmentLabel}
              colors={soft ? [c.fg3, c.fg] : [c.fg3, c.bg]}
            />
          </Tap>
        );
      })}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  tabsScroll: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.s2,
  },
  tabs: { gap: space.xl },
  tab: {
    minHeight: 44,
    justifyContent: "center",
    borderBottomWidth: 3,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: c.fg },
  underline: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: 3,
    backgroundColor: c.fg,
  },
  tabLabel: { ...type.action },
  pills: { flexDirection: "row", gap: space.xs },
  pill: {
    minWidth: 48,
    height: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.input,
    alignItems: "center",
    justifyContent: "center",
  },
  pillActive: { backgroundColor: c.fg },
  pillMark: {
    position: "absolute",
    left: 0,
    borderRadius: radius.input,
    backgroundColor: c.fg,
  },
  pillLabel: { ...type.action },
  segmented: {
    flexDirection: "row",
    backgroundColor: c.s2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.line,
    borderRadius: radius.input,
    padding: 3,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    paddingHorizontal: 11,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentedCompact: { borderRadius: 11, padding: 2 },
  segmentCompact: { minHeight: 28, minWidth: 40, paddingHorizontal: 9, borderRadius: 9 },
  segmentActive: { backgroundColor: c.fg },
  segmentMark: {
    position: "absolute",
    left: 0,
    borderRadius: 10,
    backgroundColor: c.fg,
  },
  segmentMarkSoft: { backgroundColor: c.s3 },
  segmentLabel: { ...type.action, letterSpacing: 1.05 },
}));
