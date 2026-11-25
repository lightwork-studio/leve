import type { DeviceStore } from "@leve/storage";
import { useState } from "react";
import { useAppData } from "../data/app-data.tsx";
import { addExerciseNote, commentsByNote } from "../data/exercise-notes.ts";
import type { ExerciseNote, NoteComment } from "../model/types.ts";
import type { ExerciseCardNotes as CardNotes } from "../model/workout-notes.ts";
import { type NoteLine, NoteLines } from "./note-lines.tsx";
import { NoteSheet } from "./note-sheet.tsx";

/**
 * An exercise's notes on its card, always shown: pinned ones, the ones from last time, then
 * today's, and a field to write one. A note opens in its sheet.
 */
export function ExerciseCardNotes({
  exerciseId,
  exerciseName,
  workoutId,
  notes,
  add = true,
  pinnedOnly = false,
  variant = "inset",
  live = false,
  onInteract,
}: {
  exerciseId: string;
  exerciseName: string;
  /** The workout a new note is written in; null outside a workout. */
  workoutId: string | null;
  /** The notes as the card lists them; a plain list shows them in that order without labels. */
  notes: CardNotes | readonly ExerciseNote[] | undefined;
  add?: boolean;
  /** A new note is always pinned, as on the exercise's own screen. */
  pinnedOnly?: boolean;
  variant?: "inset" | "card";
  /** In the running workout, where a write needn't refresh history. */
  live?: boolean;
  onInteract?: () => void;
}) {
  const { store, change } = useAppData();
  const [open, setOpen] = useState<string | null>(null);
  const count = !notes
    ? 0
    : "pinned" in notes
      ? notes.pinned.length + notes.lastTime.length + notes.today.length
      : notes.length;
  // Read only when there is a note to show: a card without notes, or one that opens before the
  // workout's notes are read, lists no comments.
  const comments =
    count > 0 ? commentsByNote(store, "exercise_note") : new Map<string, NoteComment[]>();
  const line = (note: ExerciseNote, label?: string): NoteLine => ({
    id: note.id,
    text: note.text,
    pinned: note.pinned,
    agent: note.agent,
    comments: comments.get(note.id) ?? [],
    ...(label ? { label } : {}),
  });
  const lines: NoteLine[] = !notes
    ? []
    : "pinned" in notes
      ? [
          ...notes.pinned.map((note) => line(note)),
          ...notes.lastTime.map((note) => line(note, "Last time")),
          ...notes.today.map((note) => line(note)),
        ]
      : notes.map((note) => line(note));
  return (
    <>
      <NoteLines
        variant={variant}
        notes={lines}
        onOpen={(note) => {
          onInteract?.();
          setOpen(note.id);
        }}
        {...(add
          ? {
              add: {
                label: `Note for ${exerciseName}`,
                pinTo: exerciseName,
                pinnedHint: `Shows on every ${exerciseName}`,
                alwaysPinned: pinnedOnly,
                unpinnedHint: `Shows next time you do ${exerciseName}`,
                onSave: (text: string, pinned: boolean) => {
                  onInteract?.();
                  const write = (db: DeviceStore) =>
                    addExerciseNote(db, { exerciseId, workoutId, text, pinned });
                  if (live) change(write, "active-workout");
                  else change(write);
                },
              },
            }
          : {})}
      />
      {open && (
        <NoteSheet
          kind="exercise_note"
          noteId={open}
          eyebrow={exerciseName}
          pinTo={exerciseName}
          pinnedHint={`Shows on every ${exerciseName} until you delete it`}
          unpinnedHint={`Shows next time you do ${exerciseName}, then stays with this workout`}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
