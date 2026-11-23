import type { WithId, Workout, WorkoutNote } from "./types.ts";

interface CarriedNote {
  workoutId: string;
  workoutTitle: string;
  workoutStartedAt: string;
  note: WorkoutNote;
  showReply: boolean;
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

/** Sticky notes carry forward. Each reply belongs to the first workout started after it was ready. */
export function carriedWorkoutNotes(
  workouts: readonly WithId<Workout>[],
  target: WithId<Workout>,
  notesByWorkout: ReadonlyMap<string, WorkoutNote[]>,
): CarriedNote[] {
  const start = Date.parse(target.content.startedAt);
  const earlier = workouts.filter((row) => {
    const time = Date.parse(row.content.startedAt);
    return time < start || (time === start && row.id < target.id);
  });
  const previous = earlier.reduce<WithId<Workout> | undefined>((latest, row) => {
    if (!latest) return row;
    const difference = Date.parse(row.content.startedAt) - Date.parse(latest.content.startedAt);
    return difference > 0 || (difference === 0 && row.id > latest.id) ? row : latest;
  }, undefined);
  const carried: CarriedNote[] = [];
  for (const { id, content } of earlier) {
    if (!content.endedAt || Date.parse(content.endedAt) > start) continue;
    for (const note of notesByWorkout.get(id) ?? []) {
      if (Date.parse(note.createdAt) > start) continue;
      const ready =
        note.reply && Math.max(Date.parse(note.reply.createdAt), Date.parse(content.endedAt));
      const showReply =
        ready !== null &&
        ready <= start &&
        (!previous || previous.id === id || Date.parse(previous.content.startedAt) < ready);
      if (note.kind === "sticky" || showReply) {
        carried.push({
          workoutId: id,
          workoutTitle: content.title,
          workoutStartedAt: content.startedAt,
          note,
          showReply,
        });
      }
    }
  }
  return carried.sort(
    (a, b) =>
      Date.parse(b.note.createdAt) - Date.parse(a.note.createdAt) ||
      a.note.id.localeCompare(b.note.id),
  );
}
