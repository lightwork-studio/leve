import { LIMITS, type WeightUnit } from "@leve/core";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import { useLive } from "../../src/data/queries.ts";
import { finishPreview } from "../../src/data/read.ts";
import { restTimer } from "../../src/data/rest-timer.ts";
import { finishWorkout } from "../../src/data/workout-actions.ts";
import {
  discardReviewedActiveWorkout,
  workoutDeletionSnapshot,
} from "../../src/data/workout-review.ts";
import { autoTitle, setLabel, setNumbers, setProgress } from "../../src/model/live.ts";
import { measurementName, missingMeasurements } from "../../src/model/log-values.ts";
import { radius, space, type } from "../../src/theme.ts";
import { DestructiveButton } from "../../src/ui/action-sheet.tsx";
import { ToggleRow } from "../../src/ui/choice-row.tsx";
import { CommitButton } from "../../src/ui/commit-button.tsx";
import { DurationSheet } from "../../src/ui/duration-editor.tsx";
import { Enter } from "../../src/ui/enter.tsx";
import { FieldError, TitleField } from "../../src/ui/field.tsx";
import {
  dayLabel,
  distanceUnitFor,
  readoutMinutes,
  readoutWeight,
  timeLabel,
  workoutEffort,
  workoutMinutesLabel,
} from "../../src/ui/format.ts";
import { Group } from "../../src/ui/group.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { CheckIcon, ChevronIcon } from "../../src/ui/icons.tsx";
import { MuscleStrip } from "../../src/ui/muscle-strip.tsx";
import { goHome } from "../../src/ui/navigation.ts";
import { showToast } from "../../src/ui/notice.tsx";
import { Readouts } from "../../src/ui/readout.tsx";
import { BackButton } from "../../src/ui/screen.tsx";
import { SetEditor } from "../../src/ui/set-editor.tsx";
import { SheetOutline, sheetBorderWidth, sheetRadius } from "../../src/ui/sheet-outline.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { useTicker } from "../../src/ui/use-ticker.ts";
import { ExercisesCompared, WorkoutResults } from "../../src/ui/workout-results.tsx";

type TextDraft = { original: string; value: string };

/**
 * Finishing a workout: one summary sheet over it. It leads with the records the workout would set
 * (or how it compares with last time), then its figures, the exercises against last time, whether
 * it counts for its routine, and notes. Save workout writes it; Discard asks first.
 */
export default function FinishScreen() {
  const data = useLive();
  const { change, store, version } = useAppData();
  const discardReview = useRef<ReturnType<typeof workoutDeletionSnapshot>>(null);
  const insets = useSafeAreaInsets();
  const styles = useStyles(sheet);
  const c = useColors();

  const [draft, setDraft] = useState<{
    id: string;
    title?: TextDraft;
    description?: TextDraft;
    /**
     * How long the workout lasted, when the lifter set it (otherwise it ends on saving), and the
     * start it was counted from: saving is refused if the start changed since.
     */
    duration?: { seconds: number; from: string };
  }>();
  const [editingTime, setEditingTime] = useState(false);
  const [countForRoutine, setCountForRoutine] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [refusals, setRefusals] = useState(0);
  const counting = countForRoutine && !!data?.tree.workout.content.routineId;
  // What saving would show, worked out from the workout as it stands, before anything is written.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks every data change.
  const preview = useMemo(
    () => (data ? finishPreview(store, counting) : null),
    [store, version, counting, data],
  );

  const back = () => (router.canGoBack() ? router.back() : router.replace("/workout/active"));

  if (!data) {
    return (
      <View style={[styles.screen, styles.emptyState, { paddingTop: insets.top + space.xl }]}>
        <Text style={styles.muted}>No workout is in progress.</Text>
        <CommitButton label="Back to Train" onPress={goHome} />
      </View>
    );
  }
  const { tree, summary, settings, initialPlan } = data;
  const edits = draft?.id === tree.workout.id ? draft : undefined;
  const title = edits?.title?.value ?? tree.workout.content.title;
  const notes = edits?.description?.value ?? tree.workout.content.description;
  const edit = (field: "title" | "description", value: string) =>
    setDraft((current) => {
      const same = current?.id === tree.workout.id ? current : { id: tree.workout.id };
      return {
        ...same,
        [field]: { original: same[field]?.original ?? tree.workout.content[field], value },
      };
    });
  const effort = workoutEffort(summary, settings.weightUnit);
  const progress = setProgress(tree);
  const remaining = progress.total - progress.done;
  const rows = tree.entries.flatMap(({ entry, sets }) => {
    const numbers = setNumbers(sets);
    return sets.map((set, index) => ({
      entry: entry.content,
      set,
      label: setLabel(set.content.type, numbers[index] ?? 0),
      missing: missingMeasurements(entry.content.exerciseType, set.content),
    }));
  });
  const incomplete = rows.filter(({ missing }) => missing.length);
  const first = incomplete[0];
  const reviewing = rows.find(({ set }) => set.id === reviewingId);
  const startedAt = tree.workout.content.startedAt;

  const save = () => {
    try {
      change((store) =>
        finishWorkout(
          store,
          tree.workout.id,
          {
            ...(edits?.title && { title: edits.title.value }),
            ...(edits?.description && { description: edits.description.value }),
            ...(edits?.duration && { durationSeconds: edits.duration.seconds }),
            countForRoutine,
          },
          {
            ...(edits?.title && { title: edits.title.original }),
            ...(edits?.description && { description: edits.description.original }),
            ...(edits?.duration && { startedAt: edits.duration.from, endedAt: null }),
          },
        ),
      );
    } catch (error) {
      haptic.warning();
      setProblem((error as Error).message);
      setRefusals((n) => n + 1);
      return;
    }
    haptic.success();
    restTimer.skip(store, tree.workout.id);
    // Saved: back to the tabs, on History with the new session picked out.
    goHome();
    router.navigate({ pathname: "/history", params: { saved: tree.workout.id } });
    showToast("Workout saved");
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.bar}>
          <View style={styles.side}>
            <BackButton label="Log more" accessibilityLabel="Back to the workout" onPress={back} />
          </View>
          <Text accessibilityRole="header" style={styles.barTitle}>
            Summary
          </Text>
          <View style={styles.side} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <Text style={styles.label}>
              Workout complete · {dayLabel(startedAt)} · {timeLabel(startedAt)}
            </Text>
            <TitleField
              accessibilityLabel="Workout name"
              maxLength={LIMITS.titleLength}
              value={title}
              onChangeText={(value) => edit("title", value)}
              placeholder={autoTitle(startedAt)}
            />
          </View>

          {preview && (
            <WorkoutResults
              records={preview.records}
              versus={preview.versus}
              last={preview.last}
              best={preview.best}
              settings={settings}
            />
          )}

          <View style={styles.group}>
            <View style={styles.card}>
              <FinishReadouts
                startedAt={startedAt}
                durationSeconds={edits?.duration?.seconds}
                onTime={() => setEditingTime(true)}
                effort={effort}
                volumeKg={summary.volumeKg}
                unit={settings.weightUnit}
                sets={summary.sets}
                setsLabel={summary.sets === progress.done ? "Sets" : "Counted sets"}
                reps={summary.reps}
              />
              <MuscleStrip
                amounts={data.muscleSets}
                label="Muscles worked · sets"
                height={64}
                expandable
              />
            </View>
          </View>

          {preview && preview.exercises.length > 0 && (
            <ExercisesCompared
              exercises={preview.exercises}
              bars={preview.bars}
              best={preview.best}
              unit={settings.weightUnit}
            />
          )}

          {editingTime && (
            <DurationSheet
              startedAt={startedAt}
              seconds={
                edits?.duration?.seconds ??
                Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
              }
              onClose={() => setEditingTime(false)}
              onSet={(seconds) => {
                setDraft((current) => ({
                  ...(current?.id === tree.workout.id ? current : { id: tree.workout.id }),
                  duration: { seconds, from: startedAt },
                }));
                setEditingTime(false);
              }}
            />
          )}

          {tree.workout.content.routineId && (
            <Group>
              <ToggleRow
                label={`Count as ${initialPlan?.title ?? "routine session"}`}
                hint="Show this session in the routine's history"
                on={countForRoutine}
                onChange={setCountForRoutine}
              />
            </Group>
          )}

          <Group label="Notes">
            <TextInput
              accessibilityLabel="Workout description"
              maxLength={LIMITS.descriptionLength}
              value={notes}
              onChangeText={(value) => edit("description", value)}
              multiline
              placeholder="How did it go?"
              placeholderTextColor={c.fg3}
              style={styles.notes}
            />
          </Group>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
          {remaining > 0 && (
            <Text style={styles.footnote}>
              {progress.done} of {progress.total} sets logged · {remaining} unfinished. Only logged
              sets will be saved.
            </Text>
          )}
          {first && (
            <Tap
              accessibilityRole="button"
              onPress={() => setReviewingId(first.set.id)}
              scaleTo={0.98}
              style={styles.review}
            >
              <View style={styles.reviewText}>
                <Text style={styles.reviewTitle}>
                  {incomplete.length} {incomplete.length === 1 ? "set has" : "sets have"} missing
                  values
                </Text>
                <Text style={styles.reviewDetail}>
                  {first.entry.exerciseName} · Set {first.label} · Add{" "}
                  {first.missing
                    .map((m) => measurementName(m, first.entry.exerciseType))
                    .join(" and ")}
                </Text>
              </View>
              <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
            </Tap>
          )}
          {reviewing && (
            <SetEditor
              key={reviewing.set.id}
              scope="active-workout"
              set={reviewing.set}
              focusMetric={reviewing.missing[0]}
              rowLabel={reviewing.label}
              exercise={reviewing.entry.exerciseName}
              exerciseType={reviewing.entry.exerciseType}
              unit={settings.weightUnit}
              distanceUnit={distanceUnitFor(reviewing.set.content.distanceMeters ?? 0, settings)}
              onClose={() => setReviewingId(null)}
            />
          )}
          {problem && (
            // Keyed by the refusal, so each one is shown (and announced) again, even with the same message.
            <Enter key={refusals}>
              <FieldError message={problem} />
            </Enter>
          )}
          <CommitButton
            label="Save workout"
            detail={[
              [effort.amount, effort.unit].filter(Boolean).join(" "),
              `${summary.sets} ${summary.sets === 1 ? "set" : "sets"}`,
            ].join(" · ")}
            accessibilityLabel="Save workout"
            icon={<CheckIcon color={c.commitInk} size={24} strokeWidth={2.4} />}
            onPress={save}
          />
          <DestructiveButton
            key={tree.workout.id}
            label="Discard workout"
            message={`This workout and its ${progress.done} logged ${progress.done === 1 ? "set" : "sets"} will be deleted. This can’t be undone.`}
            keep="Keep training"
            busyLabel="Discarding…"
            onAsk={() => {
              discardReview.current = workoutDeletionSnapshot(store, tree.workout.id);
            }}
            capture
            onConfirm={() => {
              try {
                change(
                  (store) =>
                    discardReviewedActiveWorkout(store, tree.workout.id, discardReview.current),
                  "active-workout",
                );
              } catch (error) {
                haptic.warning();
                setProblem((error as Error).message);
                setRefusals((n) => n + 1);
                return;
              }
              restTimer.skip(store, tree.workout.id);
              goHome();
            }}
          />
        </View>
        <SheetOutline />
      </View>
    </View>
  );
}

/**
 * The workout's figures: its time so far (or the duration set for it), its volume (or logged
 * time), sets and reps. Tapping the time sets the duration. The time ticks here on its own, so the
 * form doesn't render again every second.
 */
function FinishReadouts({
  startedAt,
  durationSeconds,
  onTime,
  effort,
  volumeKg,
  unit,
  sets,
  setsLabel,
  reps,
}: {
  startedAt: string;
  durationSeconds: number | undefined;
  onTime: () => void;
  effort: ReturnType<typeof workoutEffort>;
  volumeKg: number;
  unit: WeightUnit;
  sets: number;
  setsLabel: string;
  reps: number;
}) {
  const now = useTicker(durationSeconds === undefined);
  const minutes = Math.max(
    0,
    Math.round(
      durationSeconds === undefined ? (now - Date.parse(startedAt)) / 60_000 : durationSeconds / 60,
    ),
  );
  const time = readoutMinutes(minutes);
  const volume = effort.label === "Volume";
  return (
    <Readouts
      cells={[
        {
          label: "Time",
          value: time.value,
          unit: time.unit,
          accessibilityLabel: `Time ${workoutMinutesLabel(minutes)}. Change the duration`,
          onPress: onTime,
        },
        {
          label: effort.label,
          value: volume ? readoutWeight(volumeKg, unit) : effort.amount,
          unit: effort.unit,
          width: 1.35,
          accessibilityLabel: `${effort.label} ${[effort.amount, effort.unit].filter(Boolean).join(" ")}`,
        },
        { label: setsLabel, value: String(sets), width: 0.8 },
        { label: "Reps", value: String(reps), width: 0.85 },
      ]}
    />
  );
}

const sheet = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.bg },
  emptyState: { padding: space.xl, gap: space.lg },
  sheet: {
    flex: 1,
    backgroundColor: c.bg,
    borderTopLeftRadius: sheetRadius,
    borderTopRightRadius: sheetRadius,
    paddingTop: sheetBorderWidth,
    overflow: "hidden",
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    marginTop: 8,
    backgroundColor: c.line2,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 56,
    paddingTop: 6,
    paddingBottom: 4,
    paddingHorizontal: 12,
  },
  side: { minWidth: 96, flexDirection: "row" },
  barTitle: { flex: 1, textAlign: "center", ...type.rowTitle, fontSize: 15, color: c.fg },
  muted: { ...type.caption, color: c.fg2 },
  content: { paddingBottom: space.lg },
  hero: { paddingTop: 2, paddingBottom: 16, paddingHorizontal: space.xl },
  label: { ...type.label, color: c.fg3 },
  group: { marginHorizontal: 14, marginBottom: 22 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  notes: {
    minHeight: 84,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    textAlignVertical: "top",
    ...type.body,
    color: c.fg,
  },
  footnote: { ...type.caption, fontSize: 12, color: c.fg3, paddingHorizontal: 6 },
  review: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 12,
    borderRadius: radius.button,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    borderLeftWidth: 3,
    borderLeftColor: c.alert,
  },
  reviewText: { flex: 1, minWidth: 0, gap: 3 },
  reviewTitle: { ...type.rowTitle, fontSize: 14.5, color: c.fg },
  reviewDetail: { ...type.meta, color: c.fg2 },
  footer: {
    paddingHorizontal: 14,
    paddingTop: 10,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: c.line,
    backgroundColor: c.bg,
  },
}));
