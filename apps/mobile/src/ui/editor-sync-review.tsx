import { type JsonObject, jsonEqual } from "@leve/contract";
import type { DeviceRecord, DeviceStore } from "@leve/storage";
import { useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { unavailableReviewFields } from "../data/workout-review.ts";
import { radius, space, type } from "../theme.ts";
import { Button } from "./buttons.tsx";
import { FieldError } from "./field.tsx";
import { themedStyles, useStyles } from "./themed.ts";

export function hasEditorConflict(row: DeviceRecord | null): row is DeviceRecord & {
  content: JsonObject;
  server: { state: "live"; content: JsonObject; revision: number };
} {
  return (
    !!row &&
    (row.kind === "routine" || row.kind === "body_measurement") &&
    row.status === "conflict" &&
    !row.deleted &&
    !!row.content &&
    row.server?.state === "live" &&
    !!row.server.content
  );
}

function blocked(store: DeviceStore, record: DeviceRecord) {
  const sync = store.syncState();
  if (record.inFlight || sync.refreshFrom || sync.restoring)
    return "Finish syncing before choosing a version.";
  if (unavailableReviewFields(store, record).length)
    return "Sync with a server that supports all saved fields before choosing a version.";
  return null;
}

const labels: Record<string, string> = {
  title: "Name",
  folderId: "Folder ID",
  notes: "Notes",
  position: "Order",
  takenAt: "Recorded at",
  bodyweightKg: "Bodyweight (kg)",
  fatPercent: "Body fat (%)",
  exercises: "Exercise",
  sets: "Set",
  weightKg: "Load (kg)",
  durationSeconds: "Duration (s)",
  distanceMeters: "Distance (m)",
  restSeconds: "Rest (s)",
  rpe: "RPE",
  repRangeMin: "Minimum reps",
  repRangeMax: "Maximum reps",
  useRepRange: "Use rep range",
  supersetId: "Superset",
  exerciseType: "Exercise type",
  exerciseName: "Movement",
  exerciseId: "Movement ID",
  createdAt: "Created",
  id: "ID",
};

type Difference = { path: string; local: string; remote: string };
function differences(local: unknown, remote: unknown, path = ""): Difference[] {
  if (jsonEqual(local ?? null, remote ?? null)) return [];
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if ((local && typeof local === "object") || (remote && typeof remote === "object")) {
    const left = object(local);
    const right = object(remote);
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => {
      const nested =
        Array.isArray(local) || Array.isArray(remote)
          ? `${path} ${Number(key) + 1}`
          : [path, labels[key] ?? key.charAt(0).toUpperCase() + key.slice(1)]
              .filter(Boolean)
              .join(" · ");
      return differences(left[key], right[key], nested);
    });
  }
  const value = (v: unknown) =>
    v == null ? "None" : typeof v === "string" ? JSON.stringify(v) : String(v);
  return [{ path, local: value(local), remote: value(remote) }];
}

/**
 * A routine or measurement changed on this device and elsewhere: each differing field with both
 * values side by side, then the choice of which version to keep.
 */
export function EditorSyncReview({
  record,
  onResolved,
}: {
  record: DeviceRecord;
  onResolved?: () => void;
}) {
  const styles = useStyles(sheet);
  const { store, change } = useAppData();
  const [error, setError] = useState("");
  if (!hasEditorConflict(record)) return null;
  const sync = store.syncState();
  const reason = blocked(store, record);
  const choose = (choice: "keep_mine" | "keep_theirs") => {
    try {
      change((db) => {
        const current = db.get(record.kind, record.id);
        const now = db.syncState();
        if (
          db !== store ||
          now.account !== sync.account ||
          now.server !== sync.server ||
          now.lineage !== sync.lineage ||
          !hasEditorConflict(current) ||
          !jsonEqual(current, record)
        )
          throw Error("This record changed. Review the latest versions before choosing.");
        const problem = blocked(db, current);
        if (problem) throw Error(problem);
        db.resolve(record.kind, record.id, { choice });
      });
      setError("");
      onResolved?.();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const routine = record.kind === "routine";
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>Sync</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {routine ? "Review routine changes" : "Review measurement changes"}
        </Text>
        <Text style={styles.text}>
          {String(routine ? record.content.title : record.content.takenAt)}
        </Text>
      </View>
      {differences(record.content, record.server.content).map(({ path, local, remote }) => (
        <View key={path} style={styles.field}>
          <Text style={styles.path}>{path}</Text>
          <View style={styles.compare}>
            <Text style={[styles.text, styles.side]}>This device · {local}</Text>
            <Text style={[styles.text, styles.side, styles.divided]}>Server · {remote}</Text>
          </View>
        </View>
      ))}
      <View style={styles.choices}>
        {reason ? (
          <Text style={styles.text}>{reason}</Text>
        ) : (
          <>
            <Button label="Keep my version" onPress={() => choose("keep_mine")} />
            <Button
              rank="primary"
              label="Use server version"
              onPress={() => choose("keep_theirs")}
            />
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
  field: { borderTopWidth: 1, borderTopColor: c.line },
  path: { ...type.label, color: c.fg3, paddingTop: 12, paddingHorizontal: 14 },
  compare: { flexDirection: "row" },
  side: { flex: 1, minWidth: 0, paddingVertical: 10, paddingHorizontal: 14 },
  divided: { borderLeftWidth: 1, borderLeftColor: c.line },
  text: { ...type.meta, fontSize: 12, lineHeight: 19, color: c.fg2 },
  choices: {
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
}));
