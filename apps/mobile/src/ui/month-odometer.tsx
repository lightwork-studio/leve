import type { WeightUnit } from "@leve/core";
import { Text, View } from "react-native";
import type { MonthDay, MonthOdometer } from "../model/past-workouts.ts";
import { numeral, radius, space, type } from "../theme.ts";
import { minutesLabel, monthLabel, totalWeight } from "./format.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

const LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * A month at a glance: how many sessions in large numerals beside its volume, time and records,
 * then its dates, filled where trained and marked in brass where a record was set. Trained dates
 * are buttons that pick the date (`selected`), so the screen can list its sessions.
 */
export function MonthCard({
  odometer,
  unit,
  firstWeekday,
  selected,
  onSelect,
}: {
  odometer: MonthOdometer;
  unit: WeightUnit;
  firstWeekday: number;
  /** The picked date's day of the month. */
  selected: number | null;
  onSelect: (date: number) => void;
}) {
  const styles = useStyles(sheet);
  const { sessions, trainingDays, volumeKg, minutes, records } = odometer;
  const weeks = Array.from({ length: odometer.cells.length / 7 }, (_, i) =>
    odometer.cells.slice(i * 7, i * 7 + 7),
  );
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={[styles.label, styles.strong]}>
          {monthLabel(odometer.year, odometer.month)}
        </Text>
      </View>
      <View style={styles.figures}>
        <View
          accessible
          accessibilityLabel={`${sessions} ${sessions === 1 ? "session" : "sessions"} on ${trainingDays} ${trainingDays === 1 ? "training day" : "training days"}`}
        >
          <Text style={styles.count}>{String(sessions).padStart(2, "0")}</Text>
          <Text style={[styles.label, styles.countKey]}>
            {sessions === 1 ? "session" : "sessions"}
          </Text>
        </View>
        <View style={styles.readings}>
          <Reading label="Volume" value={totalWeight(volumeKg, unit)} />
          <Reading label="Time" value={minutesLabel(minutes)} />
          <Reading label="Records" value={String(records)} record last />
        </View>
      </View>
      <View style={styles.grid}>
        <View style={styles.week}>
          {Array.from({ length: 7 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the seven weekday columns never move.
            <Text key={i} aria-hidden style={[styles.label, styles.weekday]}>
              {LETTERS[(firstWeekday + i) % 7]}
            </Text>
          ))}
        </View>
        {weeks.map((week, w) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a month's weeks keep their order.
          <View key={w} style={styles.week}>
            {week.map((day, i) =>
              day ? (
                <DateCell
                  key={day.date}
                  day={day}
                  // A date stays picked only while it has sessions to show.
                  selected={selected === day.date && day.sessions.length > 0}
                  onSelect={onSelect}
                />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: blank cells hold their place.
                <View key={`blank-${i}`} style={styles.blank} />
              ),
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

function Reading({
  label,
  value,
  record = false,
  last = false,
}: {
  label: string;
  value: string;
  record?: boolean;
  last?: boolean;
}) {
  const styles = useStyles(sheet);
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${value}`}
      style={[styles.reading, !last && styles.readingLine]}
    >
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.readingValue, record && styles.record]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function DateCell({
  day,
  selected,
  onSelect,
}: {
  day: MonthDay;
  selected: boolean;
  onSelect: (date: number) => void;
}) {
  const styles = useStyles(sheet);
  const count = day.sessions.length;
  const written = new Date(day.start).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const label = day.today ? `${written}, today` : written;
  const style = [
    styles.date,
    count > 0 ? styles.trained : day.today ? styles.today : day.ahead ? styles.ahead : null,
    selected && styles.selected,
  ];
  const text = (
    <Text
      accessibilityLabel={count ? undefined : label}
      style={[
        styles.dateText,
        day.ahead && styles.aheadText,
        count > 0 && styles.trainedText,
        selected && styles.selectedText,
      ]}
    >
      {day.date}
    </Text>
  );
  if (!count) return <View style={style}>{text}</View>;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} ${count === 1 ? "workout" : "workouts"}${day.record ? ", with a record" : ""}`}
      accessibilityState={{ expanded: selected }}
      onPress={() => onSelect(day.date)}
      style={style}
    >
      {text}
      {day.record && <View style={styles.recordMark} />}
    </Tap>
  );
}

const sheet = themedStyles((c) => ({
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
    paddingTop: space.md,
    paddingBottom: 14,
    paddingHorizontal: space.lg,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
  },
  label: { ...type.label, color: c.fg3 },
  strong: { color: c.fg },
  record: { color: c.record },
  figures: { flexDirection: "row", alignItems: "flex-end", gap: space.xl, marginTop: 6 },
  count: { ...numeral(84), color: c.fg },
  countKey: { marginTop: space.sm },
  readings: { flex: 1, minWidth: 0, gap: 7, paddingBottom: 4 },
  reading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: space.sm,
  },
  readingLine: { paddingBottom: 7, borderBottomWidth: 1, borderBottomColor: c.line },
  readingValue: { ...type.meta, fontSize: 13, lineHeight: 17, color: c.fg },
  grid: {
    gap: 5,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  week: { flexDirection: "row", gap: 5 },
  weekday: { flex: 1, textAlign: "center", paddingBottom: 2 },
  blank: { flex: 1, height: 44 },
  date: {
    flex: 1,
    height: 44,
    borderRadius: radius.chip,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.s2,
  },
  trained: { backgroundColor: c.fg },
  today: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: c.fg2 },
  ahead: { backgroundColor: "transparent" },
  selected: { backgroundColor: c.s3, borderWidth: 1.5, borderColor: c.fg },
  dateText: { ...type.value, color: c.fg2 },
  aheadText: { color: c.fg3 },
  trainedText: { ...type.value, fontWeight: "700", color: c.bg },
  selectedText: { color: c.fg },
  recordMark: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 5,
    height: 5,
    borderRadius: 1,
    backgroundColor: c.record,
    transform: [{ rotate: "45deg" }],
  },
}));
