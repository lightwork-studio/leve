import type { WeightUnit } from "@leve/core";
import { Link, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHistory, useProgress } from "../../src/data/queries.ts";
import {
  displayedWorkoutTitle,
  monthOdometer,
  monthPages,
  type WorkoutSummary,
} from "../../src/model/past-workouts.ts";
import { recordsByWorkout } from "../../src/model/progress.ts";
import { space, type } from "../../src/theme.ts";
import { BackLink } from "../../src/ui/back-link.tsx";
import { timeLabel, workoutMinutesLabel } from "../../src/ui/format.ts";
import { ChevronIcon } from "../../src/ui/icons.tsx";
import { MonthCard } from "../../src/ui/month-odometer.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { useToday } from "../../src/ui/use-now.ts";

type Month = { key: string; year: number; month: number; workouts: WorkoutSummary[] };

export default function WorkoutCalendar() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const fromProgress = from === "progress";
  const today = useToday();
  const { months, settings } = useHistory();
  const { index } = useProgress();
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  const pages = useMemo(() => monthPages(months, today), [today, months]);
  const recordsIn = useMemo(() => {
    const records = recordsByWorkout(index);
    return (id: string) => records.get(id)?.length ?? 0;
  }, [index]);
  return (
    <View style={[styles.page, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.header}>
        <BackLink
          label={fromProgress ? "Progress" : "History"}
          fallback={fromProgress ? "/progress" : "/history"}
        />
        <Text accessibilityRole="header" style={styles.title}>
          Workout calendar
        </Text>
      </View>
      <FlatList
        data={pages}
        keyExtractor={(page) => page.key}
        initialNumToRender={3}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.lg }]}
        renderItem={({ item }) => (
          <CalendarMonth
            month={item}
            today={today}
            firstWeekday={settings.firstWeekday}
            unit={settings.weightUnit}
            recordsIn={recordsIn}
            fromProgress={fromProgress}
          />
        )}
      />
    </View>
  );
}

/** One month of the calendar: its figures and dates, and the sessions of the date picked. */
export function CalendarMonth({
  month,
  today,
  firstWeekday,
  unit = "kg",
  recordsIn = noRecords,
  fromProgress = false,
}: {
  month: Month;
  today: number;
  firstWeekday: number;
  unit?: WeightUnit;
  recordsIn?: (workoutId: string) => number;
  fromProgress?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [selected, setSelected] = useState<number | null>(null);
  const odometer = useMemo(
    () => monthOdometer(month, today, firstWeekday, recordsIn),
    [month, today, firstWeekday, recordsIn],
  );
  const chosen =
    selected === null
      ? undefined
      : (odometer.cells.find((day) => day?.date === selected)?.sessions ?? []);
  // The picked date closes once its last session is gone.
  if (selected !== null && !chosen?.length) setSelected(null);
  return (
    <MonthCard
      odometer={odometer}
      unit={unit}
      firstWeekday={firstWeekday}
      selected={selected}
      onSelect={(date) => setSelected(selected === date ? null : date)}
    >
      {chosen?.map((workout) => (
        <Link
          key={workout.id}
          href={{
            pathname: "/workout/[id]",
            params: {
              id: workout.id,
              back: "Calendar",
              ...(fromProgress ? { from: "progress" } : {}),
            },
          }}
          asChild
        >
          <Tap accessibilityRole="link" style={StyleSheet.flatten(styles.session)}>
            <View style={styles.sessionMain}>
              <Text style={styles.name}>{displayedWorkoutTitle(workout)}</Text>
              <Text style={styles.meta}>
                {timeLabel(workout.startedAt)} · {workoutMinutesLabel(workout.durationMinutes)}
              </Text>
            </View>
            <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
          </Tap>
        </Link>
      ))}
    </MonthCard>
  );
}

const noRecords = () => 0;

const sheet = themedStyles((c) => ({
  page: { flex: 1, backgroundColor: c.bg },
  header: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  title: { ...type.title, color: c.fg },
  list: { paddingHorizontal: 14, gap: space.lg },
  session: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  sessionMain: { flex: 1, minWidth: 0 },
  name: { ...type.rowTitle, color: c.fg },
  meta: { ...type.meta, color: c.fg3, marginTop: 4 },
}));
