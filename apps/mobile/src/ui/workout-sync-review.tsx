import { type JsonObject, jsonEqual, type RecordContent } from "@leve/contract";
import type { DeviceRecord, Resolution } from "@leve/storage";
import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { readSettings, rejectedWorkoutDeletion } from "../data/read.ts";
import {
  deletedWorkoutReview,
  exerciseDeletionSets,
  needsExerciseRestore,
  recoverDeletedWorkout,
  resolveWorkoutRecord,
  unavailableReviewFields,
  workoutRestoreBlocked,
} from "../data/workout-review.ts";
import type { WorkoutSet } from "../model/types.ts";
import { radius, space, type } from "../theme.ts";
import { DestructiveButton } from "./action-sheet.tsx";
import { Button } from "./buttons.tsx";
import { FieldError } from "./field.tsx";
import { sessionSetLabel } from "./set-values.ts";
import { themedStyles, useStyles } from "./themed.ts";

function Version({
  kind,
  label,
  content,
  fallback,
  showCreatedAt,
  headerDifferences = [],
  owner,
  divided = false,
}: {
  divided?: boolean;
  kind: string;
  label: string;
  content: JsonObject | null;
  fallback: string;
  showCreatedAt: boolean;
  headerDifferences?: string[];
  owner?: string;
}) {
  const styles = useStyles(sheet);
  const note = kind === "workout_note" ? (content as RecordContent<"workout_note"> | null) : null;
  const entry =
    kind === "workout_exercise" ? (content as RecordContent<"workout_exercise"> | null) : null;
  return (
    <View style={[styles.version, divided && styles.divided]}>
      <Text style={styles.eyebrow}>{label}</Text>
      <Text style={styles.text}>
        {!content
          ? fallback
          : kind === "workout"
            ? String(content.title || "Untitled workout")
            : note
              ? note.text
              : entry
                ? entry.exerciseName
                : content.seconds == null
                  ? "Use Settings"
                  : `${content.seconds} seconds`}
      </Text>
      {kind === "workout" &&
        content &&
        headerDifferences.map((field) => (
          <Text key={field} style={styles.text}>
            {field} ·{" "}
            {typeof content[field] === "string"
              ? String(content[field])
              : JSON.stringify(content[field] ?? null)}
          </Text>
        ))}
      {owner && <Text style={styles.text}>Workout · {owner}</Text>}
      {note && showCreatedAt && <Text style={styles.text}>Note recorded {note.createdAt}</Text>}
      {note && (
        <Text style={styles.text}>
          {note.pinned ? "Pinned note" : "Note"}
          {note.agent ? ` · by ${note.agent}` : ""}
        </Text>
      )}
      {entry && (
        <>
          <Text style={styles.text}>Rest: {entry.restSeconds} seconds</Text>
          <Text style={styles.text}>
            Order: {entry.position} · Superset: {entry.supersetId ?? "None"}
          </Text>
          <Text style={styles.text}>
            {entry.exerciseType} · {entry.exerciseId}
          </Text>
          <Text style={styles.text}>
            Count both dumbbells: {entry.doubleDumbbellVolume ? "Yes" : "No"}
          </Text>
        </>
      )}
    </View>
  );
}

export function WorkoutSyncReview({
  workoutId,
  record,
  readOnlyReason,
  onResolved,
}: {
  workoutId: string;
  record: DeviceRecord;
  readOnlyReason: string | null;
  onResolved?: () => void;
}) {
  const styles = useStyles(sheet);
  const { change, store } = useAppData();
  const [error, setError] = useState("");
  const rest = record.kind === "workout_rest";
  const withheld =
    record.kind === "workout" && !record.deleted && record.server?.state === "live"
      ? unavailableReviewFields(store, record)
      : [];
  const restoreWorkout = rejectedWorkoutDeletion(record);
  const sync = store.syncState();
  const blocked =
    readOnlyReason ??
    (restoreWorkout ? workoutRestoreBlocked(store, record) : null) ??
    (sync.restoring || (restoreWorkout && sync.refreshFrom)
      ? "Finish syncing before choosing a version."
      : null) ??
    (withheld.length
      ? "Sync with a server that supports the saved workout fields before choosing a version."
      : null) ??
    (record.inFlight ? "Finish the current sync before choosing a version." : null);
  const recovery = deletedWorkoutReview(store, workoutId);
  const parentDeleted = !!recovery || record.problem?.reason === "parent_deleted";
  const sets = exerciseDeletionSets(store, record);
  const restoreExercise = needsExerciseRestore(record);
  const settings = readSettings(store);
  const decide = (choice: Resolution["choice"]) => {
    try {
      const resolved = change((db) => resolveWorkoutRecord(db, workoutId, record, choice, sets));
      setError("");
      if (restoreWorkout && resolved?.content) {
        router.replace(
          resolved.content.endedAt
            ? { pathname: "/workout/[id]", params: { id: workoutId } }
            : "/workout/active",
        );
      }
      onResolved?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const restoreBlocked = workoutRestoreBlocked(store, record);
  /**
   * A choice: the safe one bone, the one keeping this device's copy a tile, others quiet. Taking
   * the synced version says why instead while the workout can't be restored yet.
   */
  const action = (
    label: string,
    choice: Resolution["choice"],
    rank: "primary" | "secondary" | "link" = "secondary",
  ) =>
    choice === "keep_theirs" && restoreBlocked ? (
      <Text style={styles.text}>{restoreBlocked}</Text>
    ) : (
      <Button rank={rank} label={label} onPress={() => decide(choice)} />
    );
  const recover = (choice: "save_as_new" | "keep_theirs") => {
    if (!recovery) return;
    try {
      const saved = change((db) => recoverDeletedWorkout(db, workoutId, record, recovery, choice));
      if (choice === "save_as_new" && saved?.content) {
        router.replace(
          saved.content.endedAt
            ? { pathname: "/workout/[id]", params: { id: saved.id } }
            : "/workout/active",
        );
      } else router.replace("/(tabs)/history");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const headerDifferences =
    record.kind === "workout" && (!record.content || record.server?.state === "deleted")
      ? ["startedAt"]
      : record.kind === "workout"
        ? [
            ...new Set([
              ...Object.keys(record.content ?? {}),
              ...Object.keys(record.server?.content ?? {}),
            ]),
          ].filter(
            (field) =>
              field !== "title" &&
              !withheld.includes(field) &&
              !jsonEqual(record.content?.[field] ?? null, record.server?.content?.[field] ?? null),
          )
        : [];
  const localOwner = record.content?.workoutId;
  const remoteContent = record.server?.content ?? record.keptContent;
  const remoteOwner = remoteContent?.workoutId;
  const moved =
    typeof localOwner === "string" && typeof remoteOwner === "string" && localOwner !== remoteOwner;
  const ownerLabel = (id: unknown) => {
    if ((!moved && !restoreExercise) || typeof id !== "string") return undefined;
    const title = store.get("workout", id)?.content?.title;
    return title ? `${title} (${id})` : id;
  };
  const showCreatedAt =
    !!record.content && !!remoteContent && record.content.createdAt !== remoteContent.createdAt;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>Sync</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {record.kind === "workout"
            ? "Review workout details"
            : rest
              ? "Review workout rest"
              : record.kind === "workout_exercise"
                ? "Review exercise"
                : "Review note"}
        </Text>
        <Text style={styles.text}>
          {record.status === "invalid"
            ? "The server could not accept this change."
            : "This device and the server have different versions."}
        </Text>
      </View>
      <View style={styles.compare}>
        <Version
          headerDifferences={headerDifferences}
          kind={record.kind}
          owner={ownerLabel(localOwner)}
          showCreatedAt={showCreatedAt}
          label="This device"
          content={record.content}
          fallback={record.deleted ? "Deleted on this device" : "Unavailable"}
        />
        <Version
          headerDifferences={headerDifferences}
          kind={record.kind}
          owner={ownerLabel(remoteOwner)}
          showCreatedAt={showCreatedAt}
          label={restoreWorkout && !record.server ? "Previous server copy" : "Server"}
          divided
          content={record.server?.content ?? record.keptContent}
          fallback={
            record.server?.state === "deleted"
              ? "Deleted on the server"
              : record.server?.state === "unavailable"
                ? "Requires a newer app"
                : "No server copy"
          }
        />
      </View>
      <View style={styles.choices}>
        {blocked ? (
          <Text style={styles.text}>{blocked}</Text>
        ) : parentDeleted ? (
          <>
            <Text style={styles.text}>The source workout was deleted on the server.</Text>
            {recovery && (
              <>
                <Text style={styles.title}>
                  {String(recovery.owner.content?.title ?? "Workout")}
                </Text>
                <Text style={styles.text}>
                  Saving a copy keeps this workout with its local exercises, sets, notes and rest
                  setting.
                </Text>
                <Button label="Save workout as new" onPress={() => recover("save_as_new")} />
                <DestructiveButton
                  capture
                  label="Accept workout deletion"
                  message="This workout was deleted elsewhere. Accepting deletes it here too, with the changes made on this device."
                  action="Delete workout and its local changes"
                  keep="Keep it for now"
                  busyLabel="Deleting…"
                  onConfirm={() => recover("keep_theirs")}
                />
              </>
            )}
          </>
        ) : restoreWorkout ? (
          <>
            <Text style={styles.text}>
              {record.status === "invalid"
                ? "This workout is too large to delete in one sync. Restore it to review its exercises and sets."
                : !record.server
                  ? "The sync server has no copy of this workout. Restore the previous copy and its exercises to review them."
                  : "This workout changed after you deleted it. Restore it to review its exercises and sets before deleting it again."}
            </Text>
            {action("Restore workout to review", "keep_theirs", "primary")}
          </>
        ) : restoreExercise ? (
          <>
            <Text style={styles.text}>
              The server still has this exercise. Restore it to see its current sets before deciding
              whether to remove it.
            </Text>
            {action("Restore exercise to review its sets", "keep_theirs", "primary")}
          </>
        ) : (
          <>
            {record.server?.state !== "deleted" &&
              record.server?.state !== "unavailable" &&
              action("Keep my version", "keep_mine")}
            {moved && (
              <Text style={styles.text}>
                Choosing a version also chooses its workout
                {record.kind === "workout_exercise"
                  ? " for this exercise and its sets."
                  : " for this note."}
              </Text>
            )}
            {sets && sets.length > 0 && (
              <>
                <Text style={styles.eyebrow}>Retained sets</Text>
                {sets.map(
                  (row, index) =>
                    row.content && (
                      <Text key={row.id} style={styles.text}>
                        Set {index + 1} ·{" "}
                        {sessionSetLabel(
                          String(record.content?.exerciseType),
                          row.content as unknown as WorkoutSet,
                          settings.weightUnit,
                          settings,
                        )}
                      </Text>
                    ),
                )}
              </>
            )}
            {sets?.length ? (
              <DestructiveButton
                capture
                label="Discard exercise and retained sets"
                message="This exercise and the sets kept on this device will be deleted."
                action={`Delete exercise and ${sets.length} ${sets.length === 1 ? "set" : "sets"}`}
                keep="Keep them for now"
                busyLabel="Deleting…"
                onConfirm={() => decide("keep_theirs")}
              />
            ) : (
              action(
                record.server || record.keptContent ? "Use server version" : "Discard local change",
                "keep_theirs",
                "primary",
              )
            )}
            {!rest &&
              record.content &&
              (!record.server || record.server.state === "deleted") &&
              action(
                record.kind === "workout_exercise"
                  ? "Save as a new exercise entry"
                  : "Save as a new note",
                "save_as_new",
                "link",
              )}
          </>
        )}
        <FieldError message={error} />
      </View>
    </View>
  );
}
const sheet = themedStyles((c) => ({
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  head: { gap: 6, paddingTop: 14, paddingHorizontal: space.lg, paddingBottom: 12 },
  eyebrow: { ...type.label, color: c.fg3 },
  title: { ...type.rowTitle, color: c.fg },
  compare: { flexDirection: "row", borderTopWidth: 1, borderTopColor: c.line },
  version: {
    flex: 1,
    minWidth: 0,
    gap: space.xs,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  divided: { borderLeftWidth: 1, borderLeftColor: c.line },
  text: { ...type.meta, fontSize: 12, lineHeight: 19, color: c.fg2 },
  choices: {
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
}));
