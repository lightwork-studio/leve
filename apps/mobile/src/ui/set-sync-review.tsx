import { type JsonObject, jsonEqual } from "@leve/contract";
import type { DeviceStore } from "@leve/storage";
import { useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { newId } from "../data/ids.ts";
import { unavailableReviewFields } from "../data/workout-review.ts";
import { radius, space, type } from "../theme.ts";
import { Button } from "./buttons.tsx";
import { FieldError } from "./field.tsx";
import { ChevronIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

const labels: Record<string, string> = {
  reps: "Reps",
  weightKg: "Weight (kg)",
  distanceMeters: "Distance (m)",
  durationSeconds: "Time (seconds)",
  count: "Count",
  rpe: "Perceived exertion",
  repsInReserve: "Reps in reserve",
  completedAt: "Logged at",
  type: "Set type",
  position: "Order",
  planSlot: "Routine target",
  workoutExerciseId: "Exercise entry",
};

function display(field: string, value: unknown) {
  if (value == null) return field === "planSlot" ? "No linked target" : "None";
  if (field === "planSlot" && typeof value === "object" && "exercise" in value && "set" in value) {
    return `Exercise ${Number(value.exercise) + 1}, set ${Number(value.set) + 1}`;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function ownsSet(store: DeviceStore, workoutId: string, entryId: string) {
  const workout = store.get("workout", workoutId);
  const entry = store.get("workout_exercise", entryId);
  return (
    !!workout?.content &&
    !workout.deleted &&
    workout.server?.state !== "deleted" &&
    entry?.content?.workoutId === workoutId &&
    !entry.deleted &&
    entry.server?.state !== "deleted" &&
    entry.problem?.reason !== "parent_deleted" &&
    (!entry.server?.content || entry.server.content.workoutId === workoutId)
  );
}

export function SetSyncReview({
  workoutId,
  id,
  entryId,
  label,
  onResolved,
}: {
  workoutId: string;
  id: string;
  entryId: string;
  label: string;
  onResolved?: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { store, change } = useAppData();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const record = store.get("workout_set", id);
  if (
    record?.status !== "conflict" ||
    (!record.content && !record.deleted) ||
    !record.server ||
    record.server.state === "unavailable" ||
    (record.content ?? record.server.content)?.workoutExerciseId !== entryId ||
    (record.deleted && record.server.state !== "live")
  )
    return null;
  if (record.problem?.reason === "parent_deleted") {
    return (
      <Text style={styles.body}>
        Set {label} is saved on this device. Its exercise or workout was deleted on another device.
      </Text>
    );
  }
  if (!ownsSet(store, workoutId, entryId)) return null;
  const localDeleted = record.deleted;
  const local = record.content;
  const remote = record.server.content;
  const revision = record.server.revision;
  const deleted = record.server.state === "deleted";
  const unavailable = deleted ? [] : unavailableReviewFields(store, record);
  const differences = [
    ...new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {}), ...unavailable]),
  ].filter(
    (field) =>
      unavailable.includes(field) || !jsonEqual(local?.[field] ?? null, remote?.[field] ?? null),
  );
  const waiting = record.inFlight || store.syncState().restoring;
  function choose(choice: "keep_mine" | "keep_theirs" | "save_as_new") {
    try {
      change((db) => {
        const latest = db.get("workout_set", id);
        if (
          !ownsSet(db, workoutId, entryId) ||
          latest?.status !== "conflict" ||
          latest.problem?.reason === "parent_deleted" ||
          latest.inFlight ||
          latest.deleted !== localDeleted ||
          (!deleted && unavailableReviewFields(db, latest).length > 0) ||
          db.syncState().restoring ||
          latest.server?.revision !== revision ||
          (latest.server.state === "deleted") !== deleted ||
          !jsonEqual(latest.content, local) ||
          !jsonEqual(latest.server.content, remote)
        ) {
          throw Error("This set changed. Review its current values before choosing.");
        }
        db.resolve(
          "workout_set",
          id,
          choice === "save_as_new" ? { choice, newId: newId() } : { choice },
        );
      });
      setError("");
      setOpen(false);
      onResolved?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  /** One side of the comparison: each differing field with its value. */
  function version(heading: string, values: JsonObject, hidden: string[] = []) {
    return (
      <View style={styles.side}>
        <Text style={styles.heading}>{heading}</Text>
        {differences.map((field) => (
          <Text key={field} style={styles.field}>
            {labels[field] ?? field} ·{" "}
            <Text style={styles.changed}>
              {hidden.includes(field) ? "Unavailable" : display(field, values[field])}
            </Text>
          </Text>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.panel}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Review changes to set ${label}`}
        accessibilityHint="This set changed on this device and elsewhere"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        scaleTo={0.98}
        style={styles.toggle}
      >
        <View style={styles.toggleText}>
          <Text style={styles.eyebrow}>Sync · changed in two places</Text>
          <Text style={styles.title}>Review changes to set {label}</Text>
        </View>
        <ChevronIcon direction={open ? "down" : "right"} color={c.fg3} size={16} strokeWidth={2} />
      </Tap>
      {open && (
        <>
          {localDeleted && remote ? (
            <>
              <Text style={styles.oneSide}>
                Deleted on this device ·{" "}
                {String(
                  store.get("workout_exercise", entryId)?.content?.exerciseName ?? "Exercise",
                )}
              </Text>
              <View style={styles.compare}>{version("Synced version", remote, unavailable)}</View>
            </>
          ) : deleted && local ? (
            <>
              <Text style={styles.oneSide}>This set was deleted on another device.</Text>
              <View style={styles.compare}>{version("On this device", local)}</View>
            </>
          ) : remote && local && differences.length ? (
            <View style={styles.compare}>
              {version("On this device", local)}
              <View style={styles.rule} />
              {version("Synced version", remote, unavailable)}
            </View>
          ) : (
            <Text style={styles.note}>Both versions have the same set values.</Text>
          )}
          {unavailable.length ? (
            <Text style={styles.note}>
              Sync with a server that supports these fields to compare both versions. Your set is
              saved on this device.
            </Text>
          ) : waiting ? (
            <Text style={styles.note}>Finish syncing to choose a version.</Text>
          ) : (
            <View style={styles.actions}>
              <Button
                label={
                  deleted
                    ? "Save as a new set"
                    : localDeleted
                      ? "Keep set deletion"
                      : "Use this device’s set"
                }
                onPress={() => choose(deleted ? "save_as_new" : "keep_mine")}
                style={styles.action}
              />
              <Button
                rank="primary"
                label={deleted ? "Accept set deletion" : "Use synced set"}
                onPress={() => choose("keep_theirs")}
                style={styles.action}
              />
            </View>
          )}
          <View style={styles.error}>
            <FieldError message={error} />
          </View>
        </>
      )}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  panel: {
    marginVertical: space.xs,
    backgroundColor: c.s2,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: c.line2,
    borderLeftWidth: 3,
    borderLeftColor: c.alert,
    overflow: "hidden",
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 12,
  },
  toggleText: { flex: 1, minWidth: 0, gap: 4 },
  eyebrow: { ...type.label, color: c.alert },
  title: { ...type.rowTitle, fontSize: 14.5, color: c.fg },
  body: { ...type.body, fontSize: 14, color: c.fg },
  oneSide: { ...type.body, fontSize: 14, color: c.fg, paddingHorizontal: 12, paddingBottom: 10 },
  compare: { flexDirection: "row", borderTopWidth: 1, borderTopColor: c.line },
  side: { flex: 1, minWidth: 0, gap: 4, paddingVertical: 12, paddingHorizontal: 12 },
  rule: { width: 1, backgroundColor: c.line },
  heading: { ...type.label, color: c.fg3, marginBottom: 4 },
  field: { ...type.value, fontSize: 12, lineHeight: 20, color: c.fg2 },
  changed: { color: c.fg, backgroundColor: `${c.fg}24` },
  note: { ...type.meta, lineHeight: 17, color: c.fg2, paddingHorizontal: 12, paddingBottom: 10 },
  actions: { flexDirection: "row", gap: space.sm, paddingHorizontal: 10, paddingBottom: 10 },
  action: { flex: 1, paddingHorizontal: 8 },
  error: { paddingHorizontal: 12, paddingBottom: 6 },
}));
