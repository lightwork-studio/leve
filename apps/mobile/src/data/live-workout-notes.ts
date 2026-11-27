import type { DeviceStore } from "@leve/storage";
import { workoutExerciseNotesData, workoutsByExercise } from "./exercise-notes.ts";
import { refreshedJournal, workoutJournalData } from "./read.ts";

interface LiveNotes {
  workoutId: string;
  version: number;
  historyVersion: number;
  journal: ReturnType<typeof workoutJournalData>;
  exerciseNotes: ReturnType<typeof workoutExerciseNotesData>;
  exerciseHistory: ReturnType<typeof workoutsByExercise> | undefined;
}

const liveNotesCache = new WeakMap<DeviceStore, LiveNotes>();

/** The mini-player warms the snapshot. Direct opens and newer revisions read it on demand. */
export function liveWorkoutNotes(
  store: DeviceStore,
  workoutId: string,
  version: number,
  historyVersion: number,
) {
  const cached = liveNotesCache.get(store);
  const sameHistory =
    cached?.workoutId === workoutId && cached.historyVersion === historyVersion
      ? cached
      : undefined;
  if (sameHistory?.version === version) return sameHistory;

  // Active edits leave prior sessions alone. Refresh this workout's notes and comments while
  // reusing the history until a change outside the active workout invalidates it.
  const journal = sameHistory?.journal
    ? refreshedJournal(store, sameHistory.journal)
    : workoutJournalData(store, workoutId);
  let exerciseHistory = sameHistory?.exerciseHistory;
  const exerciseNotes = workoutExerciseNotesData(
    store,
    workoutId,
    () => (exerciseHistory ??= workoutsByExercise(store)),
  );
  const notes = { workoutId, version, historyVersion, journal, exerciseNotes, exerciseHistory };
  liveNotesCache.set(store, notes);
  return notes;
}
