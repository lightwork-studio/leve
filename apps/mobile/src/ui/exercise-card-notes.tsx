import type { DeviceStore } from "@leve/storage";
import { useAppData } from "../data/app-data.tsx";
import { addExerciseNote, commentsByNote } from "../data/exercise-notes.ts";
import type { ExerciseNote, NoteComment } from "../model/types.ts";
import type { ExerciseCardNotes as CardNotes } from "../model/workout-notes.ts";
import { type NoteLine, NoteLines } from "./note-lines.tsx";

/**
 * An exercise's notes on its card, always shown: pinned ones, the ones from last time, then
 * today's, and a field to write one. Each note is edited, pinned and answered where it is.
 */
export function ExerciseCardNotes({
  exerciseId,
  exerciseName,
  workoutId,
  notes,
  commentsById,
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
  commentsById?: ReadonlyMap<string, NoteComment[]> | undefined;
  add?: boolean;
  /** A new note is always pinned, as on the exercise's own screen. */
  pinnedOnly?: boolean;
  variant?: "inset" | "card";
  /** In the running workout, where adding a note needn't refresh history. */
  live?: boolean;
  onInteract?: () => void;
}) {
  const { store, change } = useAppData();
  const all = !notes
    ? []
    : "pinned" in notes
      ? [...notes.pinned, ...notes.lastTime, ...notes.today]
      : notes;
  const comments =
    commentsById ?? (all.length > 0 ? commentsByNote(store, "exercise_note") : undefined);
  const lastTime = new Set(notes && "pinned" in notes ? notes.lastTime.map((note) => note.id) : []);
  const lines: NoteLine[] = all.map((note) => ({
    id: note.id,
    text: note.text,
    pinned: note.pinned,
    createdAt: note.createdAt,
    agent: note.agent,
    comments: comments?.get(note.id) ?? [],
    ...(lastTime.has(note.id) ? { label: "Last time" } : {}),
    pinTo: exerciseName,
    pinnedHint: `Shows on every ${exerciseName}`,
    unpinnedHint: `Shows next time you do ${exerciseName}`,
  }));
  return (
    <NoteLines
      kind="exercise_note"
      variant={variant}
      notes={lines}
      {...(onInteract ? { onInteract } : {})}
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
  );
}
