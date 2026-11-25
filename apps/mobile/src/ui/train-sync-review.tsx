import type { JsonObject } from "@leve/contract";
import type { DeviceRecord } from "@leve/storage";
import { useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import {
  resolveTrainReview,
  type TrainReviewChoice,
  trainReviewBlocked,
  trainReviewCase,
  trainReviewChoices,
} from "../data/train-review.ts";
import { radius, space, type } from "../theme.ts";
import { DestructiveButton } from "./action-sheet.tsx";
import { Button } from "./buttons.tsx";
import { FieldError } from "./field.tsx";
import { themedStyles, useStyles } from "./themed.ts";

function describe(content: JsonObject | null | undefined, fallback: string) {
  if (!content) return fallback;
  return String(content.title ?? "") || "Untitled";
}

/**
 * A routine or folder the server didn't accept as this device had it: both versions, then the
 * choices its case offers (see trainReviewCase).
 */
export function TrainSyncReview({ record }: { record: DeviceRecord }) {
  const styles = useStyles(sheet);
  const { store, change } = useAppData();
  const [error, setError] = useState("");
  const kase = trainReviewCase(record);
  if (!kase) return null;
  const routine = record.kind === "routine";
  const noun = routine ? "routine" : "folder";
  const remote = record.server?.content ?? record.keptContent;
  const choices = trainReviewChoices(record);
  const blocked = trainReviewBlocked(store, record);
  const decide = (choice: TrainReviewChoice) => {
    try {
      change((db) => resolveTrainReview(db, record, choice));
      setError("");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const title = describe(record.content ?? remote, routine ? "Routine" : "Folder");
  const moved =
    kase === "both_changed" &&
    record.content?.position !== remote?.position &&
    record.content?.title === remote?.title;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>Sync</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {kase === "restore"
            ? `Review deleted ${noun}`
            : kase === "deleted_elsewhere"
              ? `Review ${noun} deleted elsewhere`
              : "Review folder changes"}
        </Text>
        <Text style={styles.text}>
          {kase === "restore"
            ? `You deleted “${title}” here, but it changed on another device first. Restore it to see the changes, then delete it again if you still want to.`
            : kase === "deleted_elsewhere"
              ? routine
                ? `“${title}” was deleted on another device while it had changes here. Save your version as a new routine, or let it go.`
                : `“${title}” was deleted on another device while it had changes here. Its routines stay, under Not in a folder.`
              : "This folder changed here and on another device."}
        </Text>
      </View>
      <View style={styles.compare}>
        <View style={styles.version}>
          <Text style={styles.eyebrow}>This device</Text>
          <Text style={styles.text}>
            {record.deleted ? "Deleted on this device" : describe(record.content, "Unavailable")}
          </Text>
          {moved && <Text style={styles.text}>Order · {String(record.content?.position)}</Text>}
        </View>
        <View style={[styles.version, styles.divided]}>
          <Text style={styles.eyebrow}>{record.server ? "Server" : "Previous server copy"}</Text>
          <Text style={styles.text}>
            {record.server?.state === "deleted"
              ? "Deleted on the server"
              : describe(remote, "No server copy")}
          </Text>
          {moved && <Text style={styles.text}>Order · {String(remote?.position)}</Text>}
        </View>
      </View>
      <View style={styles.choices}>
        {blocked ? (
          <Text style={styles.text}>{blocked}</Text>
        ) : kase === "restore" ? (
          <Button rank="primary" label={`Restore ${noun}`} onPress={() => decide("keep_theirs")} />
        ) : kase === "both_changed" ? (
          <>
            <Button label="Keep my version" onPress={() => decide("keep_mine")} />
            <Button
              rank="primary"
              label="Use server version"
              onPress={() => decide("keep_theirs")}
            />
          </>
        ) : (
          <>
            {choices.includes("save_as_new") && (
              <Button label="Save as new routine" onPress={() => decide("save_as_new")} />
            )}
            {routine ? (
              <DestructiveButton
                capture
                label="Accept deletion"
                message={`“${title}” will be deleted here too, with the changes made on this device. Workouts you logged from it stay in History.`}
                action="Delete routine"
                keep="Keep it for now"
                onConfirm={() => decide("keep_theirs")}
              />
            ) : (
              <Button
                rank="primary"
                label="Accept deletion"
                onPress={() => decide("keep_theirs")}
              />
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
