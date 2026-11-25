import type { DeviceRecord, DeviceStore } from "@leve/storage";
import { useAppData } from "../data/app-data.tsx";
import {
  addNoteComment,
  deleteExerciseNote,
  deleteNoteComment,
  editExerciseNote,
  type NoteKind,
  resolveNoteProblem,
  setExerciseNotePinned,
} from "../data/exercise-notes.ts";
import { checkedNoteText, writeWorkoutNote } from "../data/workout-notes.ts";
import type { WorkoutNote } from "../model/types.ts";

/** A note as it was when the lifter started changing it: writes are checked against this copy. */
export interface SeenNote {
  id: string;
  text: string;
  pinned: boolean;
  createdAt: string;
  agent: string | null;
  /** The workout a workout note belongs to; unused for exercise notes. */
  workoutId?: string | null;
}

function stored(store: DeviceStore, kind: NoteKind, id: string) {
  const row = store.get(kind, id);
  if (!row?.content || row.deleted) throw Error("This note was deleted.");
  return row.content as unknown as Omit<SeenNote, "id">;
}

function asWorkoutNote(note: SeenNote): WorkoutNote {
  const { id, text, pinned, createdAt, agent } = note;
  return { id, text, pinned, createdAt, agent };
}

/**
 * Changes to one kind of note, made where the note is shown. Each runs as one write and throws a
 * message to show beside the note when it can't be made. A note is changed against the copy the
 * lifter saw, so an edit that arrived meanwhile is refused rather than overwritten.
 */
export function useNoteWrites(kind: NoteKind) {
  const { change } = useAppData();
  const run = (write: (store: DeviceStore) => unknown) => {
    change(write);
  };
  /** Refuses a change to a note that differs from the copy the lifter saw. */
  const unchanged = (db: DeviceStore, seen: SeenNote) => {
    const latest = stored(db, kind, seen.id);
    if (latest.text !== seen.text || latest.pinned !== seen.pinned)
      throw Error("This note changed. Reopen it to see the latest version.");
  };
  return {
    /** Change the text of the lifter's own note. */
    edit(seen: SeenNote, text: string) {
      if (text === seen.text) return;
      run((db) => {
        checkedNoteText(text);
        if (kind === "workout_note")
          writeWorkoutNote(db, String(seen.workoutId), asWorkoutNote(seen), {
            text,
            pinned: seen.pinned,
          });
        else {
          unchanged(db, seen);
          editExerciseNote(db, seen.id, text);
        }
      });
    },
    /** Pin or unpin a note, keeping its text exactly as it is. */
    setPinned(seen: SeenNote, pinned: boolean) {
      run((db) => {
        if (kind === "workout_note")
          writeWorkoutNote(db, String(seen.workoutId), asWorkoutNote(seen), {
            text: seen.text,
            pinned,
          });
        else {
          unchanged(db, seen);
          setExerciseNotePinned(db, seen.id, pinned);
        }
      });
    },
    /** Delete a note with its comments. */
    remove(seen: SeenNote) {
      run((db) => {
        if (kind === "exercise_note") {
          const row = db.get(kind, seen.id);
          if (!row?.content || row.deleted) return;
          unchanged(db, seen);
          deleteExerciseNote(db, seen.id);
        } else writeWorkoutNote(db, String(seen.workoutId), asWorkoutNote(seen), null);
      });
    },
    /** Answer a note. */
    reply(noteId: string, text: string) {
      run((db) => addNoteComment(db, kind, noteId, text));
    },
    /** Delete one of the lifter's own comments. */
    deleteReply(commentId: string) {
      run((db) => deleteNoteComment(db, kind, commentId));
    },
    /** Settle a note's sync problem with this device's version or the other one. */
    resolve(row: DeviceRecord, choice: "keep_mine" | "keep_theirs") {
      run((db) => resolveNoteProblem(db, row, choice));
    },
  };
}

/** This device's version can be kept only while it and its parent are still live on the server. */
export function canKeepMine(row: DeviceRecord) {
  return (
    !!row.content &&
    row.server?.state !== "deleted" &&
    row.server?.state !== "unavailable" &&
    row.problem?.reason !== "parent_deleted"
  );
}
