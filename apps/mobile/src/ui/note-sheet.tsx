import { LIMITS } from "@leve/core";
import type { DeviceRecord, DeviceStore } from "@leve/storage";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import {
  addNoteComment,
  commentsByNote,
  deleteExerciseNote,
  deleteNoteComment,
  editExerciseNote,
  type NoteKind,
  resolveNoteProblem,
  setExerciseNotePinned,
} from "../data/exercise-notes.ts";
import { isUnread, markSeen, useSeenComments } from "../data/note-seen.ts";
import { checkedNoteText, writeWorkoutNote } from "../data/workout-notes.ts";
import type { WorkoutNote } from "../model/types.ts";
import { radius, space, type } from "../theme.ts";
import { DestructiveButton } from "./action-sheet.tsx";
import { BottomSheet } from "./bottom-sheet.tsx";
import { Button } from "./buttons.tsx";
import { ToggleRow } from "./choice-row.tsx";
import { FieldError, TextArea } from "./field.tsx";
import { dayLabel } from "./format.ts";
import { Group } from "./group.tsx";
import { CheckIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

interface StoredNote {
  workoutId?: string | null;
  pinned: boolean;
  text: string;
  createdAt: string;
  agent?: string | null;
}

/** This device's version can be kept only while it and its parent are still live on the server. */
function canKeepMine(row: DeviceRecord) {
  return (
    !!row.content && row.server?.state !== "deleted" && row.problem?.reason !== "parent_deleted"
  );
}

function readNote(store: DeviceStore, kind: NoteKind, id: string) {
  const row = store.get(kind, id);
  if (!row?.content || row.deleted) return null;
  return { row, note: row.content as unknown as StoredNote };
}

/**
 * One workout or exercise note, opened from a list of notes: its text (editable when the lifter
 * wrote it), whether it is pinned, its comments with a field to add one, and Delete.
 */
export function NoteSheet({
  kind,
  noteId,
  eyebrow,
  pinTo,
  pinnedHint,
  unpinnedHint,
  onClose,
}: {
  kind: NoteKind;
  noteId: string;
  eyebrow: string;
  /** What a pin attaches the note to, or null when it can't be pinned. */
  pinTo: string | null;
  pinnedHint: string;
  unpinnedHint: string;
  onClose: () => void;
}) {
  const styles = useStyles(sheet);
  const { store, change, version } = useAppData();
  const c = useColors();
  const seen = useSeenComments();
  const [opened] = useState(() => readNote(store, kind, noteId));
  // Read on every render: `version` changes with each write, so this is the latest copy.
  const current = version >= 0 ? readNote(store, kind, noteId) : null;
  const comments = commentsByNote(store, kind).get(noteId) ?? [];
  const [text, setText] = useState(opened?.note.text ?? "");
  const [pinned, setPinned] = useState(opened?.note.pinned ?? false);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  // The comments shown as new when the sheet opened stay marked for as long as it is open.
  const [unreadIds] = useState(
    () => new Set(comments.filter((item) => isUnread(item, seen)).map((item) => item.id)),
  );
  useEffect(() => {
    markSeen(noteId, comments);
  }, [noteId, comments]);
  if (!opened || !current) {
    return (
      <BottomSheet eyebrow={eyebrow} title="Note" close="x" onClose={onClose}>
        <Text style={styles.gone}>This note was deleted.</Text>
      </BottomSheet>
    );
  }
  const own = (current.note.agent ?? null) === null;
  const run = (action: (db: DeviceStore) => unknown, close = false) => {
    try {
      change((db) => action(db));
      setError("");
      if (close) onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't save the note.");
    }
  };
  // Saved against the note as it was when the sheet opened, so an edit that arrived meanwhile is
  // never overwritten unseen.
  const save = () =>
    run((db) => {
      const latest = readNote(db, kind, noteId);
      if (!latest) throw Error("This note was deleted.");
      const was = opened.note;
      const textChanged = own && text !== was.text;
      if (!textChanged && pinned === was.pinned) return;
      if (textChanged) checkedNoteText(text);
      if (kind === "workout_note") {
        const original: WorkoutNote = {
          id: noteId,
          pinned: was.pinned,
          text: was.text,
          createdAt: was.createdAt,
          agent: was.agent ?? null,
        };
        writeWorkoutNote(db, String(was.workoutId), original, {
          text: textChanged ? text : was.text,
          pinned,
        });
      } else {
        if (latest.note.text !== was.text || latest.note.pinned !== was.pinned)
          throw Error("This note changed. Reopen it to see the latest version.");
        if (pinned !== was.pinned) setExerciseNotePinned(db, noteId, pinned);
        if (textChanged) editExerciseNote(db, noteId, text);
      }
    }, true);
  const remove = () =>
    run((db) => {
      if (kind === "exercise_note") deleteExerciseNote(db, noteId);
      else {
        const latest = readNote(db, kind, noteId);
        if (!latest) return;
        writeWorkoutNote(
          db,
          String(latest.note.workoutId),
          {
            id: noteId,
            pinned: latest.note.pinned,
            text: latest.note.text,
            createdAt: latest.note.createdAt,
            agent: latest.note.agent ?? null,
          },
          null,
        );
      }
    }, true);
  const comment = () =>
    run((db) => {
      addNoteComment(db, kind, noteId, reply);
      setReply("");
    });
  const written = [
    current.note.agent ? `By ${current.note.agent}` : null,
    `Written ${dayLabel(current.note.createdAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const problem = current.row.problem;
  return (
    <BottomSheet
      eyebrow={eyebrow}
      title="Note"
      size="large"
      onClose={onClose}
      footer={
        <>
          <Button
            rank="primary"
            label="Save note"
            icon={<CheckIcon color={c.bg} size={16} strokeWidth={2.4} />}
            onPress={save}
          />
          <DestructiveButton
            label="Delete note"
            message="This note and its comments will be deleted."
            keep="Keep it"
            onConfirm={remove}
          />
        </>
      }
    >
      <View style={styles.form}>
        <Text style={styles.written}>{written}</Text>
        {own ? (
          <TextArea
            label="Note"
            maxLength={LIMITS.noteLength}
            value={text}
            onChangeText={setText}
          />
        ) : (
          <Text style={styles.agentText}>{current.note.text}</Text>
        )}
        {problem && (
          <View style={styles.problem}>
            <Text accessibilityRole="alert" style={styles.problemText}>
              This note didn't sync. Keep this version, or take the one from your other devices.
            </Text>
            <View style={styles.problemActions}>
              {canKeepMine(current.row) && (
                <Button
                  label="Keep this version"
                  onPress={() => run((db) => resolveNoteProblem(db, current.row, "keep_mine"))}
                />
              )}
              <Button
                label="Take the other"
                onPress={() =>
                  run((db) => resolveNoteProblem(db, current.row, "keep_theirs"), true)
                }
              />
            </View>
          </View>
        )}
      </View>
      {(pinTo !== null || pinned) && (
        <Group style={styles.formGroup}>
          <ToggleRow
            label={pinTo === null ? "Pinned" : `Pin to ${pinTo}`}
            hint={pinned ? pinnedHint : unpinnedHint}
            on={pinned}
            onChange={setPinned}
          />
        </Group>
      )}
      {comments.length > 0 && (
        <Group label="Comments" aside={String(comments.length)} style={styles.formGroup}>
          {comments.map((item, i) => (
            <View key={item.id} style={[styles.comment, i > 0 && styles.divider]}>
              <View style={styles.byline}>
                {unreadIds.has(item.id) && <View style={styles.dot} accessibilityLabel="New" />}
                <Text style={styles.author}>{item.agent ?? "You"}</Text>
                {item.agent !== null && <Text style={styles.badge}>Agent</Text>}
                <Text style={styles.when}>{dayLabel(item.createdAt)}</Text>
              </View>
              <Text style={styles.commentText}>{item.text}</Text>
              {item.agent === null && (
                <Tap
                  accessibilityRole="button"
                  accessibilityLabel="Delete your comment"
                  onPress={() => run((db) => deleteNoteComment(db, kind, item.id))}
                  style={styles.deleteComment}
                >
                  <Text style={styles.deleteText}>Delete</Text>
                </Tap>
              )}
            </View>
          ))}
        </Group>
      )}
      <View style={styles.form}>
        <TextArea
          label="Add a comment"
          maxLength={LIMITS.noteLength}
          value={reply}
          onChangeText={setReply}
        />
        {reply.trim() !== "" && <Button label="Add comment" onPress={comment} />}
        <FieldError message={error} />
      </View>
    </BottomSheet>
  );
}

const sheet = themedStyles((c) => ({
  form: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  formGroup: { marginBottom: space.lg },
  written: { ...type.meta, color: c.fg3 },
  agentText: { ...type.body, color: c.fg },
  gone: { ...type.body, color: c.fg2, padding: space.lg },
  problem: { gap: space.sm, paddingTop: space.sm },
  problemText: { ...type.body, color: c.alert },
  problemActions: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  comment: { paddingVertical: space.md, paddingHorizontal: space.lg, gap: 6 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 },
  byline: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.fg },
  author: { ...type.labelSmall, color: c.fg2 },
  badge: {
    ...type.labelSmall,
    fontSize: 8.5,
    color: c.fg3,
    borderWidth: 1,
    borderColor: c.line2,
    borderRadius: radius.chip / 2,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: "hidden",
  },
  when: { ...type.meta, color: c.fg3, marginLeft: "auto" },
  commentText: { ...type.body, color: c.fg },
  deleteComment: { alignSelf: "flex-start", minHeight: 32, justifyContent: "center" },
  deleteText: { ...type.meta, color: c.fg3 },
}));
