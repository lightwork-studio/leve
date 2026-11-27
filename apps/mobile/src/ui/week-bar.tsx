import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  dayChange,
  type WeekBar as Week,
  type WeekBarDay,
  type WeekBarMode,
  weekBarDayLabel,
} from "../model/week-bar.ts";
import { font, space, type } from "../theme.ts";
import { weekLabel } from "./format.ts";
import { haptic } from "./haptics.ts";
import { RecordMark } from "./record-mark.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

export type { WeekBarMode };

/** The height of the marks under the dates, the same on every tab so the bar never moves. */
const MARK_HEIGHT = 32;

/**
 * The week over the tabs: "This week" and its dates, the tab's action beside them, and a day per
 * column with a date and a mark under it. The frame stays put between tabs; only the marks change.
 * Tapping a day that has workouts names them in the line on top; tapping it again goes back.
 */
export function WeekBar({
  week,
  mode,
  action,
}: {
  week: Week;
  mode: WeekBarMode;
  action: ReactNode | null;
}) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  const [picked, setPicked] = useState<{ week: number; start: number } | null>(null);
  // A pick from another week (the day has moved on) is forgotten.
  const day =
    picked && picked.week === week.start
      ? week.days.find((d) => d.start === picked.start && d.workouts.length > 0)
      : undefined;
  return (
    <View style={[styles.bar, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.row}>
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
        {action ?? <View style={styles.noAction} />}
      </View>
      <View style={styles.days}>
        {week.days.map((d) => {
          const label = weekBarDayLabel(d, mode);
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
                <Mark day={d} mode={mode} />
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
          const on = day?.start === d.start;
          return (
            <Tap
              key={d.start}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected: on }}
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
      </View>
    </View>
  );
}

function Mark({ day, mode }: { day: WeekBarDay; mode: WeekBarMode }) {
  const styles = useStyles(sheet);
  if (mode === "history") {
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
  const [first, second] = day.workouts;
  const records = day.workouts.some((w) => w.records > 0);
  if (!second) {
    return (
      <View style={styles.chip}>
        <Text style={styles.chipText}>{first?.monogram || "·"}</Text>
        {records && (
          <View style={styles.gem}>
            <RecordMark small />
          </View>
        )}
      </View>
    );
  }
  // Two workouts on one day share the room; more than two show how many more.
  const more = day.workouts.length - 1;
  return (
    <View style={styles.pair}>
      <View style={[styles.chip, styles.chipSmall]}>
        <Text style={[styles.chipText, styles.chipTextSmall]}>{first?.monogram || "·"}</Text>
        {records && (
          <View style={styles.gem}>
            <RecordMark small />
          </View>
        )}
      </View>
      <View style={[styles.chip, styles.chipSmall]}>
        <Text style={[styles.chipText, styles.chipTextSmall]}>
          {more > 1 ? `+${more}` : second.monogram || "·"}
        </Text>
      </View>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  bar: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.md,
    backgroundColor: c.bg,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingLeft: 6,
  },
  head: { ...type.label, color: c.fg3, flexShrink: 1 },
  headStrong: { color: c.fg, fontWeight: "600" },
  // Keeps the row as tall as one with an action, so the days don't move between tabs.
  noAction: { width: 44, height: 44 },
  days: { flexDirection: "row", gap: 6 },
  day: { flex: 1, minWidth: 0, alignItems: "center", gap: 3 },
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
  stub: { width: 14, height: 2, borderRadius: 1, backgroundColor: c.s3 },
  chip: {
    minWidth: 34,
    height: 22,
    paddingHorizontal: 3,
    borderRadius: 7,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: { ...font.monoBold, fontSize: 10.5, letterSpacing: 0.8, color: c.bg },
  pair: { gap: 2, alignItems: "center" },
  chipSmall: { height: 14, minWidth: 28, borderRadius: 5 },
  chipTextSmall: { fontSize: 8.5, lineHeight: 10, letterSpacing: 0.4 },
  gem: { position: "absolute", top: -2, right: -2 },
  habit: { gap: 2, alignItems: "center" },
  habitMark: { width: 5, height: 4, borderRadius: 1, backgroundColor: c.s3 },
  habitOn: { backgroundColor: c.fg3 },
  habitNow: { width: 14, height: 5, marginTop: 2 },
  habitNowOn: { backgroundColor: c.fg },
  change: { ...font.monoSemi, fontSize: 10.5, letterSpacing: -0.2, color: c.fg },
  changeDown: { color: c.fg2 },
  newLabel: { ...type.labelSmall, color: c.fg3 },
}));
