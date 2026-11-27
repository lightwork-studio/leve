import { MUSCLE_GROUPS } from "@leve/core";
import { Link } from "expo-router";
import { memo, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { choiceLabel } from "../src/data/custom-exercises.ts";
import { findLoggedExercises } from "../src/data/exercises.ts";
import { useProgress } from "../src/data/queries.ts";
import { type MuscleTargets, muscleSections } from "../src/model/muscle-map.ts";
import type { ExerciseHistory } from "../src/model/progress.ts";
import { calendarDaysBetween } from "../src/model/time.ts";
import { lastDoneLabel } from "../src/model/train.ts";
import { radius, space, type } from "../src/theme.ts";
import { BackLink } from "../src/ui/back-link.tsx";
import { EmptyState } from "../src/ui/empty-state.tsx";
import { ExerciseResults } from "../src/ui/exercise-results.tsx";
import {
  ExerciseFilters,
  ExerciseSearch,
  keepExerciseSearchFocused,
} from "../src/ui/exercise-search.tsx";
import { ChevronIcon } from "../src/ui/icons.tsx";
import { MuscleFilter, MusclePreview } from "../src/ui/muscle-filter.tsx";
import { Tap } from "../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../src/ui/themed.ts";
import { useToday } from "../src/ui/use-now.ts";

const exerciseKey = (exercise: ExerciseHistory) => exercise.exerciseId;

/**
 * The exercises the user has done, most recent first; each opens its records and history. A
 * chosen muscle splits them into the ones that target it and the ones that also work it.
 */
export default function ExercisesScreen() {
  const { index, muscleTargets, equipmentFor } = useProgress();
  const styles = useStyles(sheet);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const searching = focused || !!query.trim();
  const [muscle, setMuscle] = useState("");
  const [equipment, setEquipment] = useState("");
  const available = useMemo(
    () =>
      equipment
        ? index.exercises.filter(
            (item) => equipmentFor(item.exerciseId) === equipment.toLowerCase(),
          )
        : index.exercises,
    [equipment, equipmentFor, index.exercises],
  );
  const matching = useMemo(() => findLoggedExercises(query, available), [query, available]);
  const sections = useMemo(
    () =>
      muscleSections(
        matching,
        muscle,
        (exercise: ExerciseHistory) => muscleTargets(exercise.exerciseId),
        choiceLabel,
      ),
    [matching, muscle, muscleTargets],
  );
  const counts = muscle
    ? {
        primary: sections.find((s) => s.key === "primary")?.data.length ?? 0,
        also: sections.find((s) => s.key === "also")?.data.length ?? 0,
      }
    : { total: matching.length };
  const insets = useSafeAreaInsets();
  // Rows change with the day ("yesterday"), not the minute.
  const now = useToday();
  return (
    <ExerciseResults
      {...keepExerciseSearchFocused(focused, setFocused)}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + space.md }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      sections={sections}
      exerciseKey={exerciseKey}
      sectionGap={22}
      ListEmptyComponent={
        index.exercises.length ? (
          <EmptyState
            inset={false}
            label="Exercises"
            title="No matching exercises"
            text={
              equipment
                ? `No matches with ${equipment.toLowerCase()}. Clear the equipment filter or change your search.`
                : query.trim()
                  ? `Nothing matches “${query.trim()}”. Try another name, or clear the muscle filter.`
                  : "None of your exercises work this muscle yet."
            }
          />
        ) : undefined
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <BackLink label="Progress" fallback="/progress" />
          {!focused && (
            <View style={styles.titles}>
              <Text style={styles.eyebrow}>Your exercises</Text>
              <Text accessibilityRole="header" style={styles.title}>
                Exercises
              </Text>
              <Text style={styles.subtitle}>
                {index.exercises.length === 0
                  ? "Exercises you log show up here, with their records."
                  : `${index.exercises.length} done, most recent first`}
              </Text>
            </View>
          )}
          {index.exercises.length > 0 && (
            <>
              <ExerciseSearch value={query} onChange={setQuery} onFocusChange={setFocused} />
              <ExerciseFilters
                key={searching ? `search:${query.trim()}` : "browse"}
                searching={searching}
                muscle={muscle}
                value={equipment}
                onChange={setEquipment}
              >
                <View style={styles.card}>
                  <MuscleFilter
                    groups={MUSCLE_GROUPS}
                    muscle={muscle}
                    onSelect={setMuscle}
                    counts={counts}
                  />
                </View>
              </ExerciseFilters>
            </>
          )}
        </View>
      }
      renderExercise={({ exercise, first, last }) => (
        <ExerciseRow
          exercise={exercise}
          targets={muscleTargets(exercise.exerciseId)}
          first={first}
          last={last}
          now={now}
        />
      )}
      ListFooterComponent={
        index.exercises.length > 0 ? (
          <Text style={styles.credit}>
            Most equipment and muscle data from free-exercise-db, under the Unlicense.
          </Text>
        ) : undefined
      }
    />
  );
}

const ExerciseRow = memo(function ExerciseRow({
  exercise,
  targets,
  first,
  last,
  now,
}: {
  exercise: ExerciseHistory;
  targets: MuscleTargets | undefined;
  first: boolean;
  last: boolean;
  now: number;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const latest = exercise.sessions[0];
  const days = latest ? Math.max(0, calendarDaysBetween(latest.time, now)) : null;
  return (
    <Link href={{ pathname: "/exercise/[id]", params: { id: exercise.exerciseId } }} asChild>
      <Tap
        accessibilityRole="link"
        scaleTo={0.98}
        // A link's child takes one style object: on the web, Link rejects a list of styles.
        style={StyleSheet.flatten([
          styles.row,
          first && styles.rowFirst,
          last && styles.rowLast,
          !first && styles.divider,
        ])}
      >
        <MusclePreview exerciseId={exercise.exerciseId} targets={targets} />
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={1}>
            {exercise.name}
          </Text>
          <Text style={styles.line} numberOfLines={1}>
            {exercise.sets} {exercise.sets === 1 ? "set" : "sets"} ·{" "}
            {lastDoneLabel(days).toLowerCase()}
          </Text>
        </View>
        <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
      </Tap>
    </Link>
  );
});

const sheet = themedStyles((c) => ({
  flex: { flex: 1, minWidth: 0 },
  scroll: { flex: 1, backgroundColor: c.bg },
  content: { paddingHorizontal: 14, paddingBottom: space.xxl },
  header: { gap: space.md, marginBottom: 22 },
  titles: { paddingHorizontal: 6, gap: 9, marginTop: space.sm },
  eyebrow: { ...type.label, color: c.fg3 },
  title: { ...type.title, color: c.fg },
  subtitle: { ...type.meta, color: c.fg3 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    // The picture sits closer to the card's edge than the text would.
    paddingLeft: 10,
    paddingRight: space.lg,
    paddingVertical: 8,
    minHeight: 64,
    backgroundColor: c.s1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.line,
  },
  rowFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
  },
  rowLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  name: { ...type.rowTitle, color: c.fg },
  line: { ...type.meta, color: c.fg3, marginTop: 4 },
  credit: { ...type.caption, color: c.fg3, textAlign: "center", paddingHorizontal: 20 },
}));
