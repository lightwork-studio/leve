import { type ReactNode, useEffect, useState } from "react";
import { Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  dayChange,
  dayMonograms,
  type WeekBar as Week,
  type WeekBarDay,
  type WeekBarMode,
  weekBarDayLabel,
} from "../model/week-bar.ts";
import { font, space, type } from "../theme.ts";
import { weekLabel } from "./format.ts";
import { haptic } from "./haptics.ts";
import { easeOut } from "./motion.ts";
import { RecordMark } from "./record-mark.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

export type { WeekBarMode };

/** The height of the marks under the dates, the same on every tab so the bar never moves. */
const MARK_HEIGHT = 14;
/** How long the week takes to fold away or come back. */
const FOLD_DURATION = 280;

/**
 * The week over the tabs: "This week" and its dates, the tab's action beside them (after `status`,
 * such as sync's tag, when there is one), and a day per column with a date and a small mark under
 * it. The frame stays put between tabs; only the marks change. Tapping a day that has workouts
 * names them in the line on top; tapping it again goes back.
 *
 * It floats over the tab, which scrolls under it. Once the tab scrolls (`folded`), the days fold
 * away and the line on top keeps a dot per day. Folding only moves and fades things, so the bar's
 * height, and where each tab's content starts, never changes.
 */
export function WeekBar({
  week,
  mode,
  action,
  status = null,
  folded = false,
  onHeight,
}: {
  week: Week;
  mode: WeekBarMode;
  action: ReactNode | null;
  /** A small tag before the action, in the same line, that doesn't change the bar's height. */
  status?: ReactNode;
  folded?: boolean;
  /**
   * The bar's full height, status bar included, and how much of that still covers the tab once
   * the days have folded away, whenever either changes.
   */
  onHeight?: (height: number, folded: number) => void;
}) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [picked, setPicked] = useState<{ week: number; start: number } | null>(null);
  // Folding lets go of a picked day: with the days hidden there would be no way to let go of it.
  if (folded && picked !== null) setPicked(null);
  const [daysHeight, setDaysHeight] = useState(0);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (height > 0) onHeight?.(height, height - daysHeight);
  }, [height, daysHeight, onHeight]);
  const fold = useSharedValue(folded ? 1 : 0);
  useEffect(() => {
    const to = folded ? 1 : 0;
    fold.value = reduced ? to : withTiming(to, { duration: FOLD_DURATION, easing: easeOut });
  }, [folded, reduced, fold]);
  // The ground slides up by the days' height, so what scrolls under them shows once they've gone.
  const ground = useAnimatedStyle(() => ({
    transform: [{ translateY: -fold.value * daysHeight }],
  }));
  const hairline = useAnimatedStyle(() => ({ opacity: fold.value }));
  const days = useAnimatedStyle(() => ({
    opacity: 1 - fold.value,
    transform: [{ translateY: -6 * fold.value }],
  }));
  const dots = useAnimatedStyle(() => ({ opacity: fold.value }));
  // A pick from another week (the day has moved on) is forgotten.
  const day =
    picked && picked.week === week.start
      ? week.days.find((d) => d.start === picked.start && d.workouts.length > 0)
      : undefined;
  return (
    <View
      pointerEvents="box-none"
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      style={[styles.bar, { paddingTop: insets.top + space.sm }]}
    >
      <Animated.View style={[styles.ground, ground]}>
        <Animated.View style={[styles.hairline, hairline]} />
      </Animated.View>
      <View style={styles.row}>
        <View style={styles.headLine}>
          <Text accessibilityRole="header" style={styles.head} numberOfLines={1}>
            {day ? (
              <>
                <Text style={styles.headStrong}>{`${day.name.slice(0, 3)} ${day.date}`}</Text>
                {` · ${day.workouts.map((w) => w.title).join(" + ")}`}
              </>
            ) : (
              <>
                <Text style={styles.headStrong}>This week</Text>
                {` · ${weekLabel(week.start)}`}
              </>
            )}
          </Text>
          {/* The folded week: a dot per day, filled where there was a workout. Only there while
              folded, so open the line has its whole width (for a picked day's names, say). */}
          {folded && (
            <Animated.View
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              style={[styles.dots, dots]}
            >
              {week.days.map((d) => (
                <View
                  key={d.start}
                  style={[
                    styles.dot,
                    d.workouts.length > 0 && styles.dotOn,
                    d.today && styles.dotToday,
                    d.future && styles.dotFuture,
                  ]}
                />
              ))}
            </Animated.View>
          )}
        </View>
        {status}
        {action ?? <View style={styles.noAction} />}
      </View>
      <Animated.View
        pointerEvents={folded ? "none" : "box-none"}
        accessibilityElementsHidden={folded}
        aria-hidden={folded}
        importantForAccessibility={folded ? "no-hide-descendants" : "auto"}
        onLayout={(event) => setDaysHeight(event.nativeEvent.layout.height)}
        style={[styles.days, days]}
      >
        {week.days.map((d) => {
          const label = weekBarDayLabel(d, mode);
          const on = day?.start === d.start;
          const content = (
            <>
              <Text style={[styles.letter, d.today && styles.letterToday]}>{d.letter}</Text>
              <Text
                style={[
                  styles.date,
                  d.workouts.length > 0 && styles.dateTrained,
                  d.today && styles.dateToday,
                  d.future && styles.dateFuture,
                ]}
              >
                {d.date}
              </Text>
              <View style={[styles.mark, d.future && styles.markFuture]}>
                <Mark day={d} mode={mode} picked={on} />
              </View>
            </>
          );
          if (d.workouts.length === 0) {
            return (
              <View key={d.start} accessible accessibilityLabel={label} style={styles.day}>
                {content}
              </View>
            );
          }
          return (
            <Tap
              key={d.start}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: on }}
              focusable={!folded}
              // The web ignores focusable on a pressable; this keeps hidden days out of Tab order.
              {...(folded ? { tabIndex: -1 as const } : {})}
              onPress={() => {
                haptic.select();
                setPicked(on ? null : { week: week.start, start: d.start });
              }}
              scaleTo={0.94}
              style={styles.day}
            >
              {content}
            </Tap>
          );
        })}
      </Animated.View>
    </View>
  );
}

function Mark({ day, mode, picked }: { day: WeekBarDay; mode: WeekBarMode; picked: boolean }) {
  const styles = useStyles(sheet);
  if (mode === "history") {
    // The weeks before, oldest first, then this week a little wider.
    return (
      <View style={styles.habit}>
        {day.habit.map((on, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one mark per week before, in order.
          <View key={i} style={[styles.habitMark, on && styles.habitOn]} />
        ))}
        <View
          style={[styles.habitMark, styles.habitNow, day.workouts.length > 0 && styles.habitNowOn]}
        />
      </View>
    );
  }
  if (day.workouts.length === 0) return <View style={styles.stub} />;
  if (mode === "progress") {
    const change = dayChange(day);
    if (change === null) return <Text style={styles.newLabel}>New</Text>;
    if (change === "up") return <Text style={styles.change}>▲</Text>;
    return (
      <Text style={[styles.change, change < 0 && styles.changeDown]}>
        {change > 0 ? `▲${change}%` : change < 0 ? `▼${-change}%` : "±0%"}
      </Text>
    );
  }
  // Just the letters, with a small brass diamond on a day that set records.
  const records = day.workouts.some((w) => w.records > 0);
  return (
    <View style={styles.monogram}>
      <Text style={[styles.monogramText, picked && styles.monogramPicked]}>
        {dayMonograms(day)}
      </Text>
      {records && (
        <View style={styles.gem}>
          <RecordMark tiny />
        </View>
      )}
      {picked && <View style={styles.underline} />}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  bar: { paddingHorizontal: space.lg, paddingBottom: 10, gap: 4 },
  ground: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Solid: without a blur behind it, a see-through ground shows ghosts of what scrolls under.
    backgroundColor: c.bg,
  },
  hairline: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: c.line,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    minHeight: 32,
    paddingLeft: 6,
  },
  headLine: { flexDirection: "row", alignItems: "center", flexShrink: 1, minWidth: 0 },
  head: { ...type.label, color: c.fg3, flexShrink: 1 },
  headStrong: { color: c.fg, fontWeight: "600" },
  dots: { flexDirection: "row", gap: 4, marginLeft: 10 },
  dot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: c.s3 },
  dotOn: { backgroundColor: c.fg },
  dotToday: { borderWidth: 1, borderColor: c.fg3 },
  dotFuture: { opacity: 0.4 },
  // Keeps the row as tall as one with an action, so the days don't move between tabs.
  noAction: { width: 36, height: 32 },
  days: { flexDirection: "row", gap: 6 },
  day: { flex: 1, minWidth: 0, alignItems: "center", gap: 2 },
  letter: { ...type.label, fontSize: 9.5, color: c.fg3 },
  letterToday: { color: c.fg },
  date: { ...font.mono, fontSize: 14, lineHeight: 16, color: c.fg3 },
  dateTrained: { color: c.fg },
  dateToday: { ...font.monoBold },
  dateFuture: { color: c.line2 },
  mark: {
    height: MARK_HEIGHT,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
  },
  markFuture: { opacity: 0.4 },
  stub: { width: 10, height: 1.5, borderRadius: 1, backgroundColor: c.s3 },
  monogram: { alignItems: "center", justifyContent: "center" },
  monogramText: {
    ...font.monoSemi,
    fontSize: 9.5,
    lineHeight: 12,
    letterSpacing: 0.8,
    color: c.fg2,
  },
  monogramPicked: { color: c.fg },
  gem: { position: "absolute", top: 2, right: -7 },
  underline: {
    position: "absolute",
    left: -2,
    right: -2,
    bottom: -3,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: c.fg,
  },
  habit: { flexDirection: "row", alignItems: "center", gap: 2 },
  habitMark: { width: 4, height: 4, borderRadius: 1, backgroundColor: c.s3 },
  habitOn: { backgroundColor: c.fg3 },
  habitNow: { width: 7, marginLeft: 1 },
  habitNowOn: { backgroundColor: c.fg },
  change: { ...font.monoSemi, fontSize: 9.5, letterSpacing: -0.2, color: c.fg2 },
  changeDown: { color: c.fg3 },
  newLabel: { ...type.labelSmall, fontSize: 8, color: c.fg3 },
}));
