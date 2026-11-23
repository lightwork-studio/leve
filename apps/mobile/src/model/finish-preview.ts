import type { WorkoutTree } from "./past-workouts.ts";

/**
 * The workout in progress as finishing it would save it, so the summary can show its records and
 * how it compares before anything is written. It follows the save exactly: the workout ends now
 * (never before it started), sets that weren't logged are left out, an exercise without a logged
 * set goes, and the routine is kept only when the session counts for it.
 */
export function workoutAsSaved(
  tree: WorkoutTree,
  { countForRoutine, now }: { countForRoutine: boolean; now: number },
): WorkoutTree {
  const { content } = tree.workout;
  return {
    workout: {
      id: tree.workout.id,
      content: {
        ...content,
        routineId: countForRoutine ? content.routineId : null,
        endedAt: new Date(Math.max(now, Date.parse(content.startedAt))).toISOString(),
      },
    },
    entries: tree.entries.flatMap(({ entry, sets }) => {
      const logged = sets.filter((set) => set.content.completedAt !== null);
      return logged.length ? [{ entry, sets: logged }] : [];
    }),
  };
}
