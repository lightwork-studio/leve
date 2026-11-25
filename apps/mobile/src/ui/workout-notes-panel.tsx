import { useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import type { workoutJournalData } from "../data/read.ts";
import { canPinWorkoutNotes, writeWorkoutNote } from "../data/workout-notes.ts";
import { type NoteLine, NoteLines } from "./note-lines.tsx";
import { NoteSheet } from "./note-sheet.tsx";

type Journal = NonNullable<ReturnType<typeof workoutJournalData>>;

/**
 * A workout's notes, opened under its Notes tile or row: the notes that came back from earlier
 * workouts (pinned ones first), this workout's own, and a field to write one.
 */
export function WorkoutNotesPanel({
  journal,
  live = false,
  onlyOwn = false,
  style,
}: {
  journal: Journal;
  /** Only the notes written in this workout, as a finished workout shows them. */
  onlyOwn?: boolean;
  /** In the running workout, where a write needn't refresh history. */
  live?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { change } = useAppData();
  const [open, setOpen] = useState<string | null>(null);
  const { workout, notes, carried, comments } = journal;
  const title = workout.content.title || "Workout";
  const pinTo = canPinWorkoutNotes(workout.content) ? title : null;
  const line = (note: (typeof notes)[number], label?: string): NoteLine => ({
    id: note.id,
    text: note.text,
    pinned: note.pinned,
    agent: note.agent,
    comments: comments.get(note.id) ?? [],
    ...(label ? { label } : {}),
  });
  const shown = journal.rejectedIds;
  const lines = [
    ...(onlyOwn ? [] : carried)
      .filter(({ note }) => !shown.has(note.id))
      .map(({ note }) => line(note, "Last time")),
    // This workout's own notes oldest first, so a new one goes at the end, as on an exercise.
    ...notes
      .filter((note) => !shown.has(note.id))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .map((note) => line(note)),
  ];
  // An earlier workout's note pins to that workout's routine; one from a workout without a
  // routine can't be pinned.
  const source = carried.find(({ note }) => note.id === open);
  const openPinTo = source ? (source.workoutRoutineId === null ? null : title) : pinTo;
  return (
    <View style={style}>
      <NoteLines
        variant="card"
        notes={lines}
        onOpen={(note) => setOpen(note.id)}
        add={{
          label: "Workout note",
          pinTo,
          pinnedHint: `Shows in every ${title}`,
          unpinnedHint: pinTo ? `Shows in the next ${title}` : "Shows in your next workout",
          onSave: (text, pinned) => {
            const write = (db: Parameters<Parameters<typeof change>[0]>[0]) =>
              writeWorkoutNote(db, workout.id, null, { text, pinned });
            if (live) change(write, "active-workout");
            else change(write);
          },
        }}
      />
      {open && (
        <NoteSheet
          kind="workout_note"
          noteId={open}
          eyebrow={title}
          pinTo={openPinTo}
          pinnedHint={`Shows in every ${title} until you delete it`}
          unpinnedHint={
            pinTo
              ? `Shows in the next ${title}, then stays with its workout`
              : "Shows in your next workout, then stays with this one"
          }
          onClose={() => setOpen(null)}
        />
      )}
    </View>
  );
}
