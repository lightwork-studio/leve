import { LIMITS } from "@leve/core";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../../src/data/app-data.tsx";
import { workoutJournalData } from "../../../src/data/read.ts";
import {
  canPinWorkoutNotes,
  type NoteDraft,
  unpinWorkoutNote,
  workoutNoteReadOnlyReason,
  writeWorkoutNote,
} from "../../../src/data/workout-notes.ts";
import type { NoteComment, WorkoutNote } from "../../../src/model/types.ts";
import { gutter, space, type } from "../../../src/theme.ts";
import { ActionSheet, DestructiveButton, useConfirmation } from "../../../src/ui/action-sheet.tsx";
import { BackLink } from "../../../src/ui/back-link.tsx";
import { BottomSheet } from "../../../src/ui/bottom-sheet.tsx";
import { Button } from "../../../src/ui/buttons.tsx";
import { ToggleRow } from "../../../src/ui/choice-row.tsx";
import { EmptyState } from "../../../src/ui/empty-state.tsx";
import { FieldError, TextArea } from "../../../src/ui/field.tsx";
import { dayLabel, timeLabel } from "../../../src/ui/format.ts";
import { Group } from "../../../src/ui/group.tsx";
import { CheckIcon, PlusIcon } from "../../../src/ui/icons.tsx";
import { EditingRest } from "../../../src/ui/live/editing-rest.tsx";
import { type MenuItem, MoreButton } from "../../../src/ui/popover-menu.tsx";
import { TabTitle } from "../../../src/ui/screen.tsx";
import { themedStyles, useColors, useStyles } from "../../../src/ui/themed.ts";
import { WorkoutSyncReview } from "../../../src/ui/workout-sync-review.tsx";

function sessionLabel(title: string, startedAt: string, number?: number) {
  const label = `${title || "Workout"} · ${dayLabel(startedAt)} · ${timeLabel(startedAt)}`;
  return number ? `${label} · Session ${number}` : label;
}

/**
 * A workout's notes: its own session and pinned notes with their coach replies, and pinned notes
 * carried over from earlier sessions. Each note's ⋯ holds what can be done to it; writing or
 * changing one happens in a sheet.
 */
export default function WorkoutNotesScreen() {
  const styles = useStyles(sheet);
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { store, change, version } = useAppData();
  const insets = useSafeAreaInsets();
  // biome-ignore lint/correctness/useExhaustiveDependencies: every store change invalidates the journal.
  const data = useMemo(
    () => workoutJournalData(store, id, { numberMatchingSessions: true }),
    [store, id, version],
  );
  const [editing, setEditing] = useState<{
    workoutId: string;
    original: WorkoutNote | null;
  } | null>(null);
  // A second press may arrive before React has removed the editor.
  const openEditor = useRef<typeof editing>(null);
  const showEditor = (next: typeof editing) => {
    openEditor.current = next;
    setEditing(next);
  };
  const [draft, setDraft] = useState<NoteDraft>({ text: "", pinned: false });
  const [listError, setListError] = useState<{ workoutId: string; message: string } | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<WorkoutNote | null>(null);
  const readOnlyReason = workoutNoteReadOnlyReason(store);
  const writable = readOnlyReason === null;
  const edit = (original: WorkoutNote | null) => {
    setDraft({ text: original?.text ?? "", pinned: original?.pinned ?? false });
    setError("");
    showEditor({ workoutId: id, original });
  };
  const save = (value: NoteDraft | null) => {
    if (!editing || editing !== openEditor.current || editing.workoutId !== id) return;
    try {
      change((db) => writeWorkoutNote(db, id, editing.original, value));
      showEditor(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Deleting from a note's menu, after the action sheet: the same as deleting it in the editor.
  const removal = useConfirmation(() => {
    const note = deleting;
    if (!note) return;
    try {
      change((db) => writeWorkoutNote(db, id, note, null));
      setListError(null);
    } catch (e) {
      setListError({ workoutId: id, message: (e as Error).message });
    }
    setDeleting(null);
  });
  const unpin = (workoutId: string, noteId: string) => {
    try {
      change((db) => unpinWorkoutNote(db, workoutId, noteId));
      setListError(null);
    } catch (e) {
      setListError({ workoutId: id, message: (e as Error).message });
    }
  };
  const visibleNotes = data?.notes.filter((note) => !data.rejectedIds.has(note.id)) ?? [];
  const empty = !!data && !data.carried.length && !data.problems.length && !visibleNotes.length;
  const addNote = writable ? (
    <Button
      label="Add note"
      icon={<PlusIcon color={c.fg} size={16} strokeWidth={2} />}
      onPress={() => edit(null)}
    />
  ) : null;

  return (
    <ScrollView
      style={styles.screen}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingTop: insets.top + space.sm,
        paddingBottom: insets.bottom + space.xl,
      }}
    >
      <View style={styles.nav}>
        <BackLink
          label="Workout"
          fallback={data?.workout.content.endedAt ? `/workout/${id}` : "/workout/active"}
        />
      </View>
      <View style={styles.titles}>
        <TabTitle title="Workout notes" />
        {data && (
          <Text style={styles.session}>
            {sessionLabel(
              data.workout.content.title,
              data.workout.content.startedAt,
              data.sessionNumbers?.get(id),
            )}
          </Text>
        )}
      </View>
      {!data ? (
        <EmptyState label="Notes" title="Workout unavailable." />
      ) : (
        <>
          {listError?.workoutId === id && (
            <View style={styles.problem}>
              <FieldError message={listError.message} />
            </View>
          )}
          {empty && (
            <EmptyState
              label="Notes"
              title="No notes on this workout"
              text={readOnlyReason ?? "Pinned notes come back the next time you train."}
              action={addNote}
            />
          )}
          {data.carried.length > 0 && (
            <Group label="From earlier sessions">
              {data.carried.map(({ workoutId, workoutTitle, workoutStartedAt, note }, i) => {
                const rejected = data.rejectedIds.has(note.id);
                const items: MenuItem[] = [
                  ...(writable && note.pinned && !rejected
                    ? [{ label: "Unpin note", onPress: () => unpin(workoutId, note.id) }]
                    : []),
                  {
                    label: "Open source workout’s notes",
                    onPress: () =>
                      router.push({ pathname: "/workout/notes/[id]", params: { id: workoutId } }),
                  },
                ];
                return (
                  <View
                    key={`${workoutId}/${note.id}`}
                    style={[styles.note, i > 0 && styles.divider]}
                  >
                    <View style={styles.noteText}>
                      <Text style={styles.tag}>
                        {note.pinned ? "Pinned note" : "Last time"} ·{" "}
                        {sessionLabel(
                          workoutTitle,
                          workoutStartedAt,
                          data.sessionNumbers?.get(workoutId),
                        )}
                      </Text>
                      <Text style={styles.text}>{note.text}</Text>
                      <Comments comments={data.comments.get(note.id)} />
                      {rejected && (
                        <Text accessibilityRole="alert" style={styles.warning}>
                          Sync issue · review this note in its source workout.
                        </Text>
                      )}
                    </View>
                    <MoreButton small label="Note options" items={items} />
                  </View>
                );
              })}
            </Group>
          )}
          {data.problems.map((record) => {
            const editable =
              writable && record.status === "invalid"
                ? data.notes.find((note) => note.id === record.id)
                : null;
            return (
              <View key={record.id} style={styles.review}>
                <WorkoutSyncReview workoutId={id} record={record} readOnlyReason={readOnlyReason} />
                {editable && <Button label="Edit rejected note" onPress={() => edit(editable)} />}
              </View>
            );
          })}
          {visibleNotes.length > 0 && (
            <Group label="This workout" aside={String(visibleNotes.length)}>
              {visibleNotes.map((note, i) => (
                <View key={note.id} style={[styles.note, i > 0 && styles.divider]}>
                  <View style={styles.noteText}>
                    <Text style={styles.tag}>
                      {note.pinned ? "Pinned note" : "Note"}
                      {note.agent ? ` · ${note.agent}` : ""}
                    </Text>
                    <Text style={styles.text}>{note.text}</Text>
                    <Comments comments={data.comments.get(note.id)} />
                  </View>
                  {writable && (
                    <MoreButton
                      small
                      label="Note options"
                      items={[
                        { label: "Edit note", onPress: () => edit(note) },
                        {
                          label: "Delete note",
                          destructive: true,
                          onPress: () => {
                            setDeleting(note);
                            removal.ask();
                          },
                        },
                      ]}
                    />
                  )}
                </View>
              ))}
            </Group>
          )}
          {!empty && (
            <View style={styles.actions}>
              {addNote ?? <Text style={styles.session}>{readOnlyReason}</Text>}
            </View>
          )}
        </>
      )}

      {data && editing?.workoutId === id && (
        <BottomSheet
          keyboardAccessory={
            data.workout.content.endedAt === null ? <EditingRest key={id} workoutId={id} /> : null
          }
          title={editing.original ? "Edit note" : "New note"}
          eyebrow={data.workout.content.title || "Workout"}
          onClose={() => showEditor(null)}
          footer={
            <>
              {writable && (
                <Button
                  rank="primary"
                  label="Save note"
                  icon={<CheckIcon color={c.bg} size={16} strokeWidth={2.4} />}
                  onPress={() => save(draft)}
                />
              )}
              {writable && editing.original && (
                <DestructiveButton
                  label="Delete note"
                  message="This note and its comments will be deleted."
                  keep="Keep it"
                  busyLabel="Deleting…"
                  onConfirm={() => save(null)}
                />
              )}
            </>
          }
        >
          <View style={styles.form}>
            <TextArea
              label="Note"
              editable={writable}
              maxLength={LIMITS.noteLength}
              value={draft.text}
              onChangeText={(text) => setDraft({ ...draft, text })}
            />
          </View>
          {(draft.pinned || canPinWorkoutNotes(data.workout.content)) && (
            <Group style={styles.formGroup}>
              <ToggleRow
                label="Pin for future workouts"
                hint="Shown again each time you train this routine"
                disabled={!writable}
                on={draft.pinned}
                onChange={(on) => setDraft({ ...draft, pinned: on })}
              />
            </Group>
          )}
          <View style={styles.form}>
            {readOnlyReason && (
              <Text accessibilityRole="alert" style={styles.session}>
                {readOnlyReason}
              </Text>
            )}
            <FieldError message={error} />
          </View>
        </BottomSheet>
      )}

      {removal.asking && deleting && (
        <ActionSheet
          message="This note and its comments will be deleted."
          action="Delete note"
          keep="Keep it"
          busy={removal.busy}
          busyLabel="Deleting…"
          onConfirm={removal.confirm}
          onClose={() => {
            removal.cancel();
            setDeleting(null);
          }}
        />
      )}
    </ScrollView>
  );
}

/** A note's comments, oldest first, each with who wrote it. */
function Comments({ comments }: { comments: readonly NoteComment[] | undefined }) {
  const styles = useStyles(sheet);
  if (!comments?.length) return null;
  return comments.map((comment) => (
    <View key={comment.id}>
      <Text style={styles.tag}>{comment.agent ?? "You"}</Text>
      <Text style={styles.reply}>{comment.text}</Text>
    </View>
  ));
}

const sheet = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.bg },
  nav: { flexDirection: "row", paddingHorizontal: gutter.group, paddingBottom: space.sm },
  titles: { paddingHorizontal: gutter.screen, paddingTop: 2, paddingBottom: 18, gap: 8 },
  session: { ...type.meta, fontSize: 11.5, lineHeight: 17, color: c.fg2 },
  problem: { paddingHorizontal: gutter.screen, paddingBottom: space.md },
  review: { marginHorizontal: gutter.group, marginBottom: 22, gap: space.sm },
  note: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingVertical: space.md,
    paddingLeft: space.lg,
    paddingRight: space.md,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  noteText: { flex: 1, minWidth: 0, gap: 6, paddingTop: 4 },
  tag: { ...type.label, color: c.fg3 },
  text: { ...type.body, color: c.fg },
  reply: { ...type.meta, fontSize: 12, lineHeight: 18, color: c.fg2 },
  warning: { ...type.meta, color: c.alert },
  actions: { flexDirection: "row", paddingHorizontal: gutter.group },
  form: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm },
  formGroup: { marginBottom: space.lg },
}));
