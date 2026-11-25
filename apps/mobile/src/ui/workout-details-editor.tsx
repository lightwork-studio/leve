import { jsonEqual } from "@leve/contract";
import { LIMITS } from "@leve/core";
import { useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { readSettings, workoutDetailProblems } from "../data/read.ts";
import { parseRestSeconds } from "../data/settings-actions.ts";
import {
  discardWorkout,
  updateRunningWorkoutDetails,
  updateWorkoutDetails,
  workoutRest,
  workoutRestReadOnlyReason,
} from "../data/workout-actions.ts";
import { workoutDeletionSnapshot } from "../data/workout-review.ts";
import type { WithId, Workout } from "../model/types.ts";
import { space, type } from "../theme.ts";
import { DestructiveButton } from "./action-sheet.tsx";
import { BottomSheet } from "./bottom-sheet.tsx";
import { Button } from "./buttons.tsx";
import { DurationField, parseWorkoutDuration } from "./duration-editor.tsx";
import { FieldError, TextField } from "./field.tsx";
import { durationLabel } from "./format.ts";
import { CheckIcon } from "./icons.tsx";
import { SetSyncReview } from "./set-sync-review.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";
import { WorkoutSyncReview } from "./workout-sync-review.tsx";

type EditorProps = {
  workout: WithId<Workout>;
  onClose: () => void;
} & ({ mode: "active" } | { mode?: "history"; onDeleted: () => void });

export function WorkoutDetailsEditor(props: EditorProps) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { workout, onClose } = props;
  const [original] = useState(workout.content);
  const { change, store } = useAppData();
  const active = props.mode === "active";
  const [deletionReview] = useState(() =>
    active ? null : workoutDeletionSnapshot(store, workout.id),
  );
  const problems = workoutDetailProblems(store, workout.id);
  const deletedOwner = problems.find(
    (row) => row.kind === "workout" && row.server?.state === "deleted",
  );
  const [initialRests] = useState(
    () =>
      new Map(
        active
          ? store
              .list("workout_exercise", { parentId: workout.id })
              .map((entry) => [entry.id, Number(entry.content?.restSeconds)] as const)
          : [],
      ),
  );
  const [restDraft, setRestDraft] = useState<string>();
  const [applyRest, setApplyRest] = useState(false);
  const [originalSeconds, setOriginalSeconds] = useState(() =>
    active ? workoutRest(store, workout.id) : null,
  );
  const restText = restDraft ?? String(originalSeconds ?? "");
  const restReadOnly = active ? workoutRestReadOnlyReason(store) : null;
  const restRecord = store.get("workout_rest", workout.id);
  const canEditRest = active && !restReadOnly && restRecord?.status !== "conflict";
  const [draft, setDraft] = useState<Partial<Pick<Workout, "title">>>({});
  const [duration, setDuration] = useState<string>();
  const elapsed = original.endedAt
    ? (Date.parse(original.endedAt) - Date.parse(original.startedAt)) / 1000
    : 0;
  const [error, setError] = useState("");
  const save = () => {
    try {
      if (props.mode === "active") {
        const seconds = restText.trim() ? parseRestSeconds(restText) : null;
        if ((restDraft !== undefined || applyRest) && seconds === null && restText.trim())
          throw new Error("Enter 0–3600 seconds of rest.");
        const rest =
          restDraft !== undefined || applyRest
            ? { originalSeconds, seconds, ...(applyRest ? { applyTo: initialRests } : {}) }
            : undefined;
        if (Object.keys(draft).length || rest)
          change(
            (store) => updateRunningWorkoutDetails(store, workout.id, original, draft, rest),
            "active-workout",
          );
      } else {
        const seconds = duration === undefined ? undefined : parseWorkoutDuration(duration);
        if (Object.keys(draft).length || seconds !== undefined)
          change((store) =>
            updateWorkoutDetails(
              store,
              workout.id,
              {
                ...draft,
                ...(seconds === undefined ? {} : { durationSeconds: seconds }),
              },
              original,
            ),
          );
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <BottomSheet
      title="Edit workout"
      onClose={onClose}
      footer={
        <>
          <FieldError message={error} />
          <Button
            rank="primary"
            label="Save changes"
            icon={<CheckIcon color={c.bg} size={16} strokeWidth={2.4} />}
            onPress={save}
          />
          {props.mode !== "active" && !deletedOwner && (
            <DestructiveButton
              label="Delete workout"
              message="This workout and all its sets will be deleted. This can’t be undone."
              keep="Keep it"
              busyLabel="Deleting…"
              onConfirm={() => {
                try {
                  change((store) => {
                    if (
                      !deletionReview ||
                      !jsonEqual(deletionReview, workoutDeletionSnapshot(store, workout.id))
                    )
                      throw Error(
                        "The workout changed. Close this editor and review it again before deleting.",
                      );
                    discardWorkout(store, workout.id);
                  });
                  props.onDeleted();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          )}
        </>
      }
    >
      <View style={styles.content}>
        <TextField
          label="Name"
          spokenLabel="Workout name"
          maxLength={LIMITS.titleLength}
          value={draft.title ?? original.title}
          onChangeText={(title) => setDraft((d) => ({ ...d, title }))}
        />
        {props.mode !== "active" && (
          <DurationField value={duration ?? durationLabel(elapsed)} onChangeText={setDuration} />
        )}
        {(deletedOwner ? [deletedOwner] : problems)
          .filter((item) => item.kind !== "workout_rest")
          .map((item) =>
            item.kind === "workout_set" ? (
              <SetSyncReview
                key={item.kind + item.id}
                id={item.id}
                workoutId={workout.id}
                entryId={String(item.server?.content?.workoutExerciseId)}
                label={String(item.server?.content?.position ?? "")}
              />
            ) : (
              <WorkoutSyncReview
                key={item.kind + item.id}
                onResolved={item.kind === "workout" ? onClose : undefined}
                workoutId={workout.id}
                record={item}
                readOnlyReason={null}
              />
            ),
          )}
        {!deletedOwner && restRecord?.problem && (
          <WorkoutSyncReview
            workoutId={workout.id}
            record={restRecord}
            onResolved={() => {
              setOriginalSeconds(workoutRest(store, workout.id));
              setRestDraft(undefined);
              setApplyRest(false);
            }}
            readOnlyReason={workoutRestReadOnlyReason(store)}
          />
        )}
        {active && (
          <View style={styles.rest}>
            <TextField
              label="Rest for added exercises · seconds"
              spokenLabel="Workout rest in seconds"
              mono
              editable={canEditRest}
              keyboardType="number-pad"
              value={restText}
              placeholder={`Use Settings (${readSettings(store).defaultRestSeconds} s)`}
              hint={
                canEditRest
                  ? "Leave blank to use Settings. Enter 0 for no timer."
                  : (restReadOnly ?? undefined)
              }
              onChangeText={(value) => {
                setRestDraft(value);
                if (!value.trim()) setApplyRest(false);
              }}
            />
            {canEditRest && initialRests.size > 0 && restText.trim() !== "" && (
              <Tap
                accessibilityRole="checkbox"
                accessibilityState={{ checked: applyRest }}
                onPress={() => setApplyRest(!applyRest)}
                style={styles.applyRow}
              >
                <View style={[styles.checkbox, applyRest && styles.checked]}>
                  {applyRest && <CheckIcon color={c.bg} size={14} strokeWidth={2.4} />}
                </View>
                <Text style={styles.applyText}>Also apply to the exercises already here</Text>
              </Tap>
            )}
          </View>
        )}
      </View>
    </BottomSheet>
  );
}
const sheet = themedStyles((c) => ({
  content: { paddingHorizontal: space.lg, paddingTop: space.xs, gap: space.lg },
  rest: { gap: space.sm },
  applyRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 },
  applyText: { flex: 1, ...type.body, fontSize: 14.5, color: c.fg },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 1.5,
    borderColor: c.line2,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  checked: { backgroundColor: c.fg, borderColor: c.fg },
}));
