import { jsonEqual } from "@leve/contract";
import type { EffortScale } from "@leve/core";
import { Link, router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import type { BuiltInExercise } from "../../src/data/exercises.ts";
import { newId } from "../../src/data/ids.ts";
import { useWorkoutDetail } from "../../src/data/queries.ts";
import { discardWorkout } from "../../src/data/workout-actions.ts";
import { deletedWorkoutReview, workoutDeletionSnapshot } from "../../src/data/workout-review.ts";
import { emptyWorkoutSet } from "../../src/model/live.ts";
import { supersetLabels } from "../../src/model/supersets.ts";
import type { WithId, WorkoutEntry, WorkoutSet } from "../../src/model/types.ts";
import { radius, space, touch, type } from "../../src/theme.ts";
import { ActionSheet, useConfirmation } from "../../src/ui/action-sheet.tsx";
import { ExerciseNotes } from "../../src/ui/exercise-notes.tsx";
import { ExercisePicker } from "../../src/ui/exercise-picker.tsx";
import { FieldError } from "../../src/ui/field.tsx";
import {
  type DistancePreferences,
  dayLabel,
  distanceUnitFor,
  readoutMinutes,
  readoutWeight,
  timeLabel,
  workoutEffort,
  workoutMinutesLabel,
} from "../../src/ui/format.ts";
import { Group, Row } from "../../src/ui/group.tsx";
import { MuscleStrip } from "../../src/ui/muscle-strip.tsx";
import { type MenuItem, MoreButton } from "../../src/ui/popover-menu.tsx";
import { Readouts } from "../../src/ui/readout.tsx";
import { BackButton } from "../../src/ui/screen.tsx";
import { SetEditor } from "../../src/ui/set-editor.tsx";
import { SetTable } from "../../src/ui/set-table.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useStyles } from "../../src/ui/themed.ts";
import { WorkoutDetailsEditor } from "../../src/ui/workout-details-editor.tsx";

type Unit = "kg" | "lbs";

export default function WorkoutDetailScreen() {
  // `back` names the screen it was opened from, for the back button.
  const {
    id,
    back: backTo,
    fromExercise,
  } = useLocalSearchParams<{
    id: string;
    back?: string;
    fromExercise?: string;
  }>();
  const data = useWorkoutDetail(id);
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState("");
  const { change, store } = useAppData();
  // What the workout held when deleting it was asked: it is deleted only if nothing changed since.
  const deletionReview = useRef<ReturnType<typeof workoutDeletionSnapshot>>(null);
  const styles = useStyles(sheet);

  const backLabel = fromExercise
    ? backTo || "Exercise"
    : (router.canGoBack() && backTo) || "History";
  const back = () => {
    if (router.canGoBack()) return router.back();
    if (fromExercise)
      return router.replace({ pathname: "/exercise/[id]", params: { id: fromExercise } });
    router.replace("/history");
  };
  const unit = data?.settings.weightUnit ?? "kg";
  const effort = data && workoutEffort(data.summary, unit);
  const ended = data?.tree.workout.content.endedAt;
  const unknownTargets = !!(
    data?.tree.workout.content.routineId && !data.tree.workout.content.initialPlan
  );
  const visibleEntries = data?.tree.entries.filter((item) => ended || item.sets.length > 0) ?? [];
  const groups = supersetLabels(visibleEntries.map(({ entry }) => entry.content.supersetId));
  const time = data && readoutMinutes(data.summary.durationMinutes);
  const started = data ? new Date(data.summary.startedAt) : null;
  const logged = !!data?.tree.entries.some(({ sets }) =>
    sets.some(({ content }) => content.completedAt !== null),
  );
  const setCount = data?.tree.entries.reduce((sum, { sets }) => sum + sets.length, 0) ?? 0;
  const removal = useConfirmation(
    () => {
      try {
        change((store) => {
          if (
            !deletionReview.current ||
            !jsonEqual(deletionReview.current, workoutDeletionSnapshot(store, id))
          )
            throw Error("The workout changed. Look it over and review it again before deleting.");
          discardWorkout(store, id);
        });
        back();
      } catch (error) {
        setProblem((error as Error).message);
      }
    },
    false,
    () => {
      deletionReview.current = workoutDeletionSnapshot(store, id);
    },
  );
  // A workout deleted on another device is reviewed instead (save a copy or accept the deletion).
  const deletedElsewhere = !!deletedWorkoutReview(store, id);
  const menu: MenuItem[] = [
    { label: "Edit name and duration", onPress: () => setEditing(true) },
    {
      label: "Workout notes",
      onPress: () => router.push({ pathname: "/workout/notes/[id]", params: { id } }),
    },
    ...(logged
      ? [
          {
            label: "Save as routine",
            onPress: () => router.push({ pathname: "/routine/new", params: { fromWorkout: id } }),
          },
        ]
      : []),
    { label: "Add exercise", onPress: () => setAdding(true) },
    ...(deletedElsewhere
      ? []
      : [{ label: "Delete workout", destructive: true, onPress: removal.ask }]),
  ];

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* A small bar: the way back, the workout's title and date, and its details. */}
      <View style={[styles.bar, { paddingTop: insets.top + space.sm }]}>
        <View style={styles.side}>
          <BackButton
            label={backLabel}
            accessibilityLabel={`Back to ${backLabel}`}
            onPress={back}
          />
        </View>
        <View style={styles.barTitle}>
          {data && (
            <>
              <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
                {data.summary.title || "Workout"}
              </Text>
              <Text style={styles.titleDate} numberOfLines={1}>
                {dayLabel(data.summary.startedAt)}
              </Text>
            </>
          )}
        </View>
        <View style={[styles.side, styles.sideEnd]}>
          {ended && data ? (
            <>
              {data.needsDetailReview && (
                // A sync problem with the details comes first: it is fixed in the editor. The
                // menu stays beside it for everything else.
                <Tap
                  accessibilityRole="button"
                  accessibilityLabel="Review sync issue"
                  onPress={() => setEditing(true)}
                  scaleTo={0.96}
                  style={[styles.tile, styles.tileAlert]}
                >
                  <Text style={[styles.tileLabel, styles.alert]}>Review</Text>
                </Tap>
              )}
              <MoreButton
                label="Workout options"
                title={data.summary.title || "Workout"}
                meta={`${dayLabel(data.summary.startedAt)} · ${setCount} ${setCount === 1 ? "set" : "sets"}`}
                items={menu}
              />
            </>
          ) : null}
        </View>
      </View>
      {editing && data && (
        <WorkoutDetailsEditor
          workout={data.tree.workout}
          onClose={() => setEditing(false)}
          onDeleted={() => {
            setEditing(false);
            back();
          }}
        />
      )}

      {!data || !time || !started ? (
        <Text style={[styles.muted, styles.missingText]}>This workout no longer exists.</Text>
      ) : (
        <>
          <View style={styles.group}>
            <View style={styles.groupHead}>
              <Text style={[styles.label, styles.strong, styles.shrink]}>
                {started.toLocaleDateString(undefined, { weekday: "long" })} ·{" "}
                {timeLabel(data.summary.startedAt)}
                {ended ? `–${timeLabel(ended)}` : ""}
                {/* The routine only when it isn't already the title. */}
                {data.routineTitle && data.routineTitle !== data.summary.title
                  ? ` · ${data.routineTitle}`
                  : ""}
              </Text>
              <Text style={styles.label}>
                {visibleEntries.length} {visibleEntries.length === 1 ? "exercise" : "exercises"}
              </Text>
            </View>
            <View style={styles.card}>
              <Readouts
                cells={[
                  {
                    label: "Time",
                    value: time.value,
                    unit: time.unit,
                    accessibilityLabel: `Time ${workoutMinutesLabel(data.summary.durationMinutes)}`,
                  },
                  ...(effort
                    ? [
                        {
                          label: effort.label,
                          value:
                            effort.label === "Volume"
                              ? readoutWeight(data.summary.volumeKg, unit)
                              : effort.amount,
                          unit: effort.unit,
                          width: 1.35,
                          accessibilityLabel: `${effort.label} ${[effort.amount, effort.unit].filter(Boolean).join(" ")}`,
                        },
                      ]
                    : []),
                  { label: "Sets", value: String(data.summary.sets), width: 0.8 },
                  { label: "Reps", value: String(data.summary.reps), width: 0.85 },
                ]}
              />
              <MuscleStrip amounts={data.muscleSets} height={56} />
            </View>
            {(data.excludedWarmups > 0 || unknownTargets) && (
              <Text style={styles.footnote}>
                {[
                  data.excludedWarmups > 0 &&
                    `${data.excludedWarmups} logged ${data.excludedWarmups === 1 ? "warm-up" : "warm-ups"} excluded from set and volume totals.`,
                  unknownTargets && "Original routine targets unknown.",
                ]
                  .filter(Boolean)
                  .join(" ")}
              </Text>
            )}
          </View>
          <FieldError message={problem} />

          <Group label="Notes">
            {data.tree.workout.content.description !== "" && (
              <Row
                title={data.tree.workout.content.description}
                chevron={!!ended}
                {...(ended
                  ? {
                      onPress: () => setEditing(true),
                      accessibilityLabel: `Description, ${data.tree.workout.content.description}`,
                      accessibilityHint: "Edit the name, duration and description",
                    }
                  : {})}
                style={styles.description}
              />
            )}
            <Row
              title="Workout notes"
              detail="Session and pinned notes, and coach replies"
              chevron
              divider={data.tree.workout.content.description !== ""}
              onPress={() => router.push({ pathname: "/workout/notes/[id]", params: { id } })}
              accessibilityLabel="Workout notes"
            />
          </Group>

          {visibleEntries.map(({ entry, sets }, index) => (
            <ExerciseCard
              key={entry.id}
              workoutId={id}
              effortScale={data.tree.workout.content.initialPlan?.effortScale}
              group={groups[index]}
              finished={!!ended}
              entry={entry}
              sets={sets}
              unit={unit}
              prefs={data.settings}
            />
          ))}
          {ended && adding && (
            <AddHistoricalExercise
              key={id}
              workoutId={id}
              included={data.tree.entries.map(({ entry }) => entry.content.exerciseId)}
              unit={unit}
              prefs={data.settings}
              onClose={() => setAdding(false)}
            />
          )}
          {removal.asking && (
            <ActionSheet
              message={`${data.summary.title || "This workout"} on ${dayLabel(data.summary.startedAt)} and its ${setCount} ${setCount === 1 ? "set" : "sets"} will be deleted. This can’t be undone.`}
              action="Delete workout"
              keep="Keep it"
              busy={removal.busy}
              busyLabel="Deleting…"
              onConfirm={removal.confirm}
              onClose={removal.cancel}
            />
          )}
        </>
      )}
    </ScrollView>
  );
}

/** Adding an exercise to a finished workout: pick it, then enter its first set. */
function AddHistoricalExercise({
  workoutId,
  included,
  unit,
  prefs,
  onClose,
}: {
  workoutId: string;
  included: string[];
  unit: Unit;
  prefs: DistancePreferences;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<{ exercise: BuiltInExercise; set: WithId<WorkoutSet> } | null>(
    null,
  );
  return (
    <ExercisePicker
      included={included}
      onClose={onClose}
      onPick={(exercise) =>
        setDraft({ exercise, set: { id: newId(), content: emptyWorkoutSet(newId()) } })
      }
      nextPage={
        draft && {
          title: "First set",
          content: (
            <SetEditor
              set={draft.set}
              exercise={draft.exercise.name}
              exerciseType={draft.exercise.type}
              newExercise={draft.exercise}
              rowLabel="1"
              addToWorkout={workoutId}
              unit={unit}
              distanceUnit={distanceUnitFor(0, prefs)}
              onClose={onClose}
            />
          ),
        }
      }
    />
  );
}

/**
 * One exercise: its name and a Trend pill (opening its history), its notes, and its sets as
 * logged, each tappable to correct it.
 */
function ExerciseCard({
  group,
  workoutId,
  effortScale,
  entry,
  finished,
  sets,
  unit,
  prefs,
}: {
  group: string | undefined;
  entry: WithId<WorkoutEntry>;
  workoutId: string;
  effortScale?: EffortScale | null | undefined;
  finished: boolean;
  sets: WithId<WorkoutSet>[];
  unit: Unit;
  prefs: DistancePreferences;
}) {
  const styles = useStyles(sheet);
  const { exerciseId, exerciseName, exerciseType } = entry.content;
  return (
    <View style={styles.group}>
      <View style={[styles.card, styles.exerciseCard]}>
        {group && <Text style={styles.label}>{group}</Text>}
        <Link href={{ pathname: "/exercise/[id]", params: { id: exerciseId, workoutId } }} asChild>
          <Tap
            accessibilityRole="link"
            accessibilityLabel={`${exerciseName}, trend and history`}
            scaleTo={0.98}
            // A link passes its style on as one object.
            style={StyleSheet.flatten([styles.exerciseHead])}
          >
            <Text style={styles.exercise} numberOfLines={1}>
              {exerciseName}
            </Text>
            <View style={styles.pill}>
              <Text style={styles.pillLabel}>Trend ›</Text>
            </View>
          </Tap>
        </Link>
        {finished && !!entry.content.notes?.length && <ExerciseNotes entry={entry} expanded />}
        <SetTable
          workoutId={workoutId}
          effortScale={effortScale}
          {...(finished ? { addTo: { workoutId, entryId: entry.id } } : {})}
          editableExercise={exerciseName}
          type={exerciseType}
          sets={sets}
          unit={unit}
          prefs={prefs}
        />
      </View>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  scroll: { flex: 1, backgroundColor: c.bg },
  content: { paddingBottom: space.xxl },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  side: { flexDirection: "row", alignItems: "center", minWidth: 96, minHeight: touch },
  sideEnd: { justifyContent: "flex-end", gap: space.sm },
  barTitle: { flex: 1, minWidth: 0, alignItems: "center" },
  title: { ...type.rowTitle, fontSize: 15, color: c.fg, textAlign: "center" },
  titleDate: { ...type.meta, fontSize: 10, letterSpacing: 0.8, color: c.fg3, marginTop: 3 },
  tile: {
    minWidth: touch,
    height: touch,
    paddingHorizontal: 13,
    borderRadius: radius.input,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  tileAlert: { borderColor: c.alert },
  tileLabel: { ...type.action, color: c.fg2 },
  alert: { color: c.alert },
  group: { marginHorizontal: 14, marginBottom: 22 },
  groupHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    paddingHorizontal: 6,
    paddingBottom: 9,
  },
  label: { ...type.label, color: c.fg3 },
  strong: { color: c.fg },
  shrink: { flexShrink: 1 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  exerciseCard: { paddingTop: 14, paddingHorizontal: space.lg, paddingBottom: space.xs },
  footnote: { ...type.caption, fontSize: 12, color: c.fg3, paddingTop: 9, paddingHorizontal: 6 },
  muted: { ...type.body, color: c.fg2 },
  missingText: { paddingHorizontal: space.xl },
  description: { paddingVertical: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    minHeight: 52,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  rowTitle: { ...type.rowTitle, color: c.fg },
  exerciseHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: touch,
    marginBottom: space.xs,
  },
  exercise: { ...type.rowTitle, fontSize: 16, color: c.fg, flex: 1, minWidth: 0 },
  pill: {
    height: 32,
    paddingHorizontal: 11,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  pillLabel: { ...type.action, fontSize: 10, letterSpacing: 1, color: c.fg2 },
}));
