import type { ExerciseNote, NoteComment, WithId, Workout, WorkoutNote } from "./types.ts";

// Which notes come back in a workout. A pinned note shows every time until it is deleted. Any
// other note shows once: in the next workout of its kind after it was written. A comment written
// later brings it back once more, in the next workout after the comment.

interface CarriedNote {
  workoutId: string;
  /** The routine of the workout it was written in; null for a workout without one. */
  workoutRoutineId: string | null;
  workoutTitle: string;
  workoutStartedAt: string;
  note: WorkoutNote;
}

/** Number only sessions whose title and local start minute look identical in the journal. */
export function journalSessionNumbers(workouts: readonly WithId<Workout>[]) {
  const groups = new Map<string, { id: string; start: number }[]>();
  for (const { id, content } of workouts) {
    const date = new Date(content.startedAt);
    const key = `${date.toDateString()} ${date.getHours()}:${date.getMinutes()} ${content.title || "Workout"}`;
    const row = { id, start: date.getTime() };
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const numbers = new Map<string, number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const [index, { id }] of group.entries()) numbers.set(id, index + 1);
  }
  return numbers;
}

/** Whether `a` started before `b`, ties broken by id so every workout has one place in line. */
function startedBefore(a: WithId<Workout>, b: WithId<Workout>) {
  const difference = Date.parse(a.content.startedAt) - Date.parse(b.content.startedAt);
  return difference < 0 || (difference === 0 && a.id < b.id);
}

/**
 * Whether a note that isn't pinned is due in `target`: something happened to it (it was written,
 * or commented on) after the last workout in its line started and before `target` started.
 */
function dueOnce(
  times: readonly number[],
  target: WithId<Workout>,
  line: readonly WithId<Workout>[],
) {
  const start = Date.parse(target.content.startedAt);
  const previous = line
    .filter((row) => row.id !== target.id && startedBefore(row, target))
    .reduce((latest, row) => Math.max(latest, Date.parse(row.content.startedAt)), -Infinity);
  return times.some((time) => time > previous && time < start);
}

function eventTimes(createdAt: string, comments: readonly NoteComment[] | undefined) {
  return [createdAt, ...(comments ?? []).map((comment) => comment.createdAt)].map(Date.parse);
}

/**
 * Workout notes from earlier workouts that show in `target`. A routine workout's notes show in
 * later workouts of that routine: pinned ones every time, others once. A note from a workout
 * without a routine shows once, in the very next workout of any kind, pinned or not.
 */
export function carriedWorkoutNotes(
  workouts: readonly WithId<Workout>[],
  target: WithId<Workout>,
  notesByWorkout: ReadonlyMap<string, WorkoutNote[]>,
  commentsByNote: ReadonlyMap<string, NoteComment[]> = new Map(),
): CarriedNote[] {
  const start = Date.parse(target.content.startedAt);
  const sameRoutine = workouts.filter(
    (row) => row.content.routineId !== null && row.content.routineId === target.content.routineId,
  );
  const carried: CarriedNote[] = [];
  for (const source of workouts) {
    const { id, content } = source;
    if (id === target.id || !startedBefore(source, target)) continue;
    if (!content.endedAt || Date.parse(content.endedAt) > start) continue;
    const routine = content.routineId;
    if (routine !== null && routine !== target.content.routineId) continue;
    const line = routine === null ? workouts : sameRoutine;
    for (const note of notesByWorkout.get(id) ?? []) {
      if (Date.parse(note.createdAt) > start) continue;
      const shows =
        (note.pinned && routine !== null) ||
        dueOnce(eventTimes(note.createdAt, commentsByNote.get(note.id)), target, line);
      if (shows)
        carried.push({
          workoutId: id,
          workoutRoutineId: routine,
          workoutTitle: content.title,
          workoutStartedAt: content.startedAt,
          note,
        });
    }
  }
  return carried.sort(
    (a, b) =>
      Number(b.note.pinned) - Number(a.note.pinned) ||
      Date.parse(b.note.createdAt) - Date.parse(a.note.createdAt) ||
      a.note.id.localeCompare(b.note.id),
  );
}

/** An exercise's notes as one card in `target` shows them, in the order they are listed. */
export interface ExerciseCardNotes {
  /** Pinned notes, oldest first, including ones pinned in this workout. */
  pinned: ExerciseNote[];
  /** Notes from earlier that are due once in this workout, newest first. */
  lastTime: ExerciseNote[];
  /** Notes written in this workout that aren't pinned, oldest first. */
  today: ExerciseNote[];
}

/**
 * The notes an exercise's card shows in `target`. `withExercise` are the workouts that include the
 * exercise (`target` among them or not); they decide when a note that isn't pinned is due.
 */
export function exerciseCardNotes(
  notes: readonly ExerciseNote[],
  target: WithId<Workout>,
  withExercise: readonly WithId<Workout>[],
  commentsByNote: ReadonlyMap<string, NoteComment[]> = new Map(),
): ExerciseCardNotes {
  const oldestFirst = [...notes].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
  const pinned = oldestFirst.filter((note) => note.pinned);
  const today = oldestFirst.filter((note) => !note.pinned && note.workoutId === target.id);
  const lastTime = oldestFirst
    .filter(
      (note) =>
        !note.pinned &&
        note.workoutId !== target.id &&
        dueOnce(eventTimes(note.createdAt, commentsByNote.get(note.id)), target, withExercise),
    )
    .reverse();
  return { pinned, lastTime, today };
}
