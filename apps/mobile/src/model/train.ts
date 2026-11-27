import { calendarDaysBetween } from "./time.ts";
import type { Folder, Routine, WithId, Workout } from "./types.ts";

/** Local midnight of the day `time` falls on (or the first moment of it, where DST skips midnight). */
export function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The local start of the week containing `time`, given the first weekday (0 = Sunday). */
export function startOfWeek(time: number, firstWeekday: number): number {
  const date = new Date(time);
  const offset = (date.getDay() - firstWeekday + 7) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset).getTime();
}

export interface RoutineCard {
  id: string;
  title: string;
  exerciseNames: string[];
  exerciseCount: number;
  /** Whole days since a finished workout from this routine last started; null if never. */
  daysSinceLast: number | null;
}

export interface RoutineGroup {
  folder: WithId<Folder> | null;
  routines: RoutineCard[];
}

/** Routines grouped by folder in folder order, then the routines not in a folder. */
export function routineGroups(
  routines: WithId<Routine>[],
  folders: WithId<Folder>[],
  workouts: WithId<Workout>[],
  now: number,
): RoutineGroup[] {
  const last = new Map<string, number>();
  for (const w of workouts) {
    if (!w.content.routineId || w.content.endedAt === null) continue;
    const at = Date.parse(w.content.startedAt);
    if (at > (last.get(w.content.routineId) ?? -Infinity)) last.set(w.content.routineId, at);
  }
  const card = (r: WithId<Routine>): RoutineCard => {
    const at = last.get(r.id);
    return {
      id: r.id,
      title: r.content.title,
      exerciseNames: r.content.exercises.map((e) => e.exerciseName),
      exerciseCount: r.content.exercises.length,
      // A clock running ahead on another device must not give "-1 days ago".
      daysSinceLast: at === undefined ? null : Math.max(0, calendarDaysBetween(at, now)),
    };
  };
  return displayOrder(routines, folders).map((group) => ({
    folder: group.folder,
    routines: group.routines.map(card),
  }));
}

/**
 * The order Train shows routines in: each folder by position with its routines by position, then
 * the routines not in a known folder. Every folder is listed, even an empty one.
 */
function displayOrder(routines: WithId<Routine>[], folders: WithId<Folder>[]) {
  const byPosition = <T extends { id: string; content: { position: number } }>(a: T, b: T) =>
    a.content.position - b.content.position || (a.id < b.id ? -1 : 1);
  const known = new Set(folders.map((f) => f.id));
  const groups: { folder: WithId<Folder> | null; routines: WithId<Routine>[] }[] = [...folders]
    .sort(byPosition)
    .map((folder) => ({
      folder,
      routines: routines.filter((r) => r.content.folderId === folder.id).sort(byPosition),
    }));
  const loose = routines.filter((r) => !r.content.folderId || !known.has(r.content.folderId));
  if (loose.length > 0) groups.push({ folder: null, routines: loose.sort(byPosition) });
  return groups;
}

/**
 * The routine to do next, by rotation: the one after the routine of the latest finished workout,
 * within that routine's folder (or the routines not in a folder), going back to the first after
 * the last. Workouts started empty or from a routine that no longer exists don't count. With no
 * such workout it is the first routine Train shows; with no routines there is none.
 */
export function upNextRoutine(
  routines: WithId<Routine>[],
  folders: WithId<Folder>[],
  workouts: WithId<Workout>[],
): { id: string; title: string } | null {
  const groups = displayOrder(routines, folders).filter((group) => group.routines.length > 0);
  const pick = (r: WithId<Routine> | undefined) =>
    r ? { id: r.id, title: r.content.title } : null;
  const existing = new Set(routines.map((r) => r.id));
  let latest: { routineId: string; at: number; id: string } | null = null;
  for (const w of workouts) {
    const { routineId, endedAt, startedAt } = w.content;
    if (!routineId || endedAt === null || !existing.has(routineId)) continue;
    const at = Date.parse(startedAt);
    if (Number.isNaN(at)) continue;
    // Two workouts that started at the same moment are told apart by id, so the pick holds still.
    if (!latest || at > latest.at || (at === latest.at && w.id > latest.id)) {
      latest = { routineId, at, id: w.id };
    }
  }
  const after = latest?.routineId;
  for (const group of groups) {
    const index = group.routines.findIndex((r) => r.id === after);
    if (index >= 0) return pick(group.routines[(index + 1) % group.routines.length]);
  }
  return pick(groups[0]?.routines[0]);
}

export function lastDoneLabel(days: number | null): string {
  if (days === null) return "Not done yet";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}
