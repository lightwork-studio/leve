import type { DeviceStore } from "@leve/storage";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import type { workoutJournalData } from "../data/read.ts";
import { canPinWorkoutNotes, writeWorkoutNote } from "../data/workout-notes.ts";
import type { WorkoutNote } from "../model/types.ts";
import { type NoteLine, NoteLines } from "./note-lines.tsx";

type Journal = NonNullable<ReturnType<typeof workoutJournalData>>;

/**
 * A workout's notes, opened under its Notes tile or row: the notes that came back from earlier
 * workouts (pinned ones first), this workout's own, and a field to write one. Each note is edited,
 * pinned and answered where it is.
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
  /** In the running workout, where adding a note needn't refresh history. */
  live?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { change } = useAppData();
  const { workout, notes, carried, comments } = journal;
  const title = workout.content.title || "Workout";
  const pinTo = canPinWorkoutNotes(workout.content) ? title : null;
  const line = (
    note: WorkoutNote,
    workoutId: string,
    // An earlier workout's note pins to that workout's routine; a workout without one has none.
    notePinTo: string | null,
    label?: string,
  ): NoteLine => ({
    id: note.id,
    text: note.text,
    pinned: note.pinned,
    createdAt: note.createdAt,
    workoutId,
    agent: note.agent,
    comments: comments.get(note.id) ?? [],
    ...(label ? { label } : {}),
    pinTo: notePinTo,
    pinnedHint: `Shows in every ${title}`,
    unpinnedHint: notePinTo ? `Shows in the next ${title}` : "Shows in your next workout",
  });
  const shown = journal.rejectedIds;
  const lines = [
    ...(onlyOwn ? [] : carried)
      .filter(({ note }) => !shown.has(note.id))
      .map(({ note, workoutId, workoutRoutineId }) =>
        line(note, workoutId, workoutRoutineId === null ? null : title, "Last time"),
      ),
    // This workout's own notes oldest first, so a new one goes at the end, as on an exercise.
    ...notes
      .filter((note) => !shown.has(note.id))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .map((note) => line(note, workout.id, pinTo)),
  ];
  return (
    <View style={style}>
      <NoteLines
        kind="workout_note"
        variant="card"
        notes={lines}
        add={{
          label: "Workout note",
          pinTo,
          pinnedHint: `Shows in every ${title}`,
          unpinnedHint: pinTo ? `Shows in the next ${title}` : "Shows in your next workout",
          onSave: (text, pinned) => {
            const write = (db: DeviceStore) =>
              writeWorkoutNote(db, workout.id, null, { text, pinned });
            if (live) change(write, "active-workout");
            else change(write);
          },
        }}
      />
    </View>
  );
}
