import { type JsonObject, jsonEqual } from "@leve/contract";

type JsonValue = unknown;

import type { DeviceRecord, DeviceStore, Resolution } from "@leve/storage";
import { durationLabel, weightInput } from "../ui/format.ts";
import { exerciseNoteReadOnlyReason } from "./exercise-notes.ts";
import { newId } from "./ids.ts";
import { readSettings } from "./read.ts";
import { workoutRestReadOnlyReason } from "./workout-actions.ts";
import { workoutNoteReadOnlyReason } from "./workout-notes.ts";
import { unavailableReviewFields } from "./workout-review.ts";

/**
 * Conflicts as the person settles them: the same thing changed on this phone and in their account
 * (by another phone or an agent) before they synced. A whole workout, with its exercises, sets,
 * notes and rest, is one conflict; so is a routine, a folder, a bodyweight entry, a note with its
 * comments, a custom exercise and the settings. Each is settled by keeping one side for every
 * record in it that clashes, through the store's own resolve.
 */

export type Side = "phone" | "account";

export interface ConflictLine {
  label: string;
  value: string;
}

export interface ConflictSide {
  /** What differs on this side, in plain words. */
  lines: ConflictLine[];
  /** Whether this side can be kept. A change the server refused can't be. */
  choosable: boolean;
  /** What keeping this side does, for the confirm button. */
  confirm: string;
}

export interface Conflict {
  key: string;
  title: string;
  subtitle: string | null;
  phone: ConflictSide;
  account: ConflictSide;
  /** The records as shown, so a choice made on an outdated view is refused. */
  records: DeviceRecord[];
}

/** How one clashing record stands. */
type RecordCase =
  /** Changed on both sides. */
  | "both"
  /** Changed here, gone from the account (deleted there, or lost in a server restore). */
  | "gone_there"
  /** Deleted here, changed in the account. */
  | "gone_here"
  /** The server refused this phone's version as invalid. */
  | "rejected";

function accountContent(row: DeviceRecord): JsonObject | null {
  if (row.server?.state === "live") return row.server.content ?? null;
  if (!row.server) return row.keptContent ?? null;
  return null;
}

function recordCase(row: DeviceRecord): RecordCase | null {
  if (row.status === "invalid") return "rejected";
  if (row.status !== "conflict") return null;
  // Changed here under something deleted in the account: kept only by copying that ancestor.
  if (row.problem?.reason === "parent_deleted") return row.content ? "gone_there" : null;
  if (row.server?.state === "unavailable") return null;
  if (row.deleted) return accountContent(row) ? "gone_here" : null;
  if (!row.content) return null;
  if (row.server?.state === "deleted" || (!row.server && !row.keptContent)) return "gone_there";
  return accountContent(row) ? "both" : null;
}

/**
 * The resolution keeping `side` means for one record: null when that side can't be kept, and
 * "with_parent" for a record that is kept by copying its deleted ancestor.
 */
function resolutionFor(row: DeviceRecord, side: Side): Resolution | "with_parent" | null {
  const which = recordCase(row);
  if (!which) return null;
  if (side === "account") return { choice: "keep_theirs" };
  switch (which) {
    case "both":
      return { choice: "keep_mine" };
    case "gone_there":
      // A record under a deleted ancestor, or sharing its parent's id, goes along with that copy.
      if (row.problem?.reason === "parent_deleted" || row.kind === "workout_rest")
        return "with_parent";
      return { choice: "save_as_new", newId: newId() };
    case "gone_here":
      // Keeping the deletion sends it again, against the account's current version. A copy the
      // restored server lacks can't be deleted there; it is only offered back.
      return row.server?.state === "live" ? { choice: "keep_mine" } : null;
    case "rejected":
      return null;
  }
}

/** Why a record can't be settled right now (a sync still running, a server that lacks it). */
function blocked(store: DeviceStore, row: DeviceRecord): boolean {
  const sync = store.syncState();
  if (row.inFlight || sync.restoring || sync.refreshFrom) return true;
  if (row.kind === "workout_note" || row.kind === "workout_note_comment")
    return workoutNoteReadOnlyReason(store) !== null;
  if (row.kind === "exercise_note" || row.kind === "exercise_note_comment")
    return exerciseNoteReadOnlyReason(store) !== null;
  if (row.kind === "workout_rest") return workoutRestReadOnlyReason(store) !== null;
  // Keeping this phone's version sends every field it holds; the server must know them all.
  return recordCase(row) === "both" && unavailableReviewFields(store, row).length > 0;
}

/* ---------- grouping ---------- */

function field(row: DeviceRecord | null, name: string): JsonValue | undefined {
  if (!row) return undefined;
  return row.content?.[name] ?? accountContent(row)?.[name] ?? row.server?.content?.[name];
}

function workoutOf(store: DeviceStore, row: DeviceRecord): string | null {
  switch (row.kind) {
    case "workout":
    case "workout_rest":
      return row.id;
    case "workout_note":
    case "workout_exercise": {
      const id = field(row, "workoutId");
      return typeof id === "string" ? id : null;
    }
    case "workout_set": {
      const entry = field(row, "workoutExerciseId");
      if (typeof entry !== "string") return null;
      const id = field(store.get("workout_exercise", entry), "workoutId");
      return typeof id === "string" ? id : null;
    }
    case "workout_note_comment": {
      const note = field(row, "noteId");
      if (typeof note !== "string") return null;
      const id = field(store.get("workout_note", note), "workoutId");
      return typeof id === "string" ? id : null;
    }
    default:
      return null;
  }
}

function groupKey(store: DeviceStore, row: DeviceRecord): string | null {
  const workout = workoutOf(store, row);
  if (workout) return `workout:${workout}`;
  if (row.kind === "exercise_note_comment") {
    const note = field(row, "noteId");
    return typeof note === "string" ? `exercise_note:${note}` : null;
  }
  if (row.kind.startsWith("workout")) return null;
  return `${row.kind}:${row.id}`;
}

/** Parents before children, so settling a parent can settle (or copy) what's below it. */
const DEPTH: Record<string, number> = {
  workout: 0,
  workout_rest: 1,
  workout_exercise: 1,
  workout_note: 1,
  workout_set: 2,
  workout_note_comment: 2,
  exercise_note: 0,
  exercise_note_comment: 1,
};
const byDepth = (a: DeviceRecord, b: DeviceRecord) =>
  (DEPTH[a.kind] ?? 0) - (DEPTH[b.kind] ?? 0) ||
  a.kind.localeCompare(b.kind) ||
  a.id.localeCompare(b.id);

/** Every conflict that can be settled now, oldest first. */
export function conflicts(store: DeviceStore): Conflict[] {
  const groups = new Map<string, DeviceRecord[]>();
  for (const row of store.problems()) {
    const key = groupKey(store, row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const result: Conflict[] = [];
  for (const [key, rows] of groups) {
    const records = [...rows].sort(byDepth);
    // A part that can't be settled yet holds back its whole group, so a choice never covers only
    // half of what clashes.
    if (records.some((row) => !recordCase(row) || blocked(store, row))) continue;
    // What goes along with a copied ancestor needs that ancestor here, being copied.
    const copiesAncestor = records.some(
      (row) => recordCase(row) === "gone_there" && resolutionFor(row, "phone") !== "with_parent",
    );
    const phoneOk = records.every((row) => {
      const resolution = resolutionFor(row, "phone");
      return resolution === "with_parent" ? copiesAncestor : resolution !== null;
    });
    result.push(describe(store, key, records, phoneOk));
  }
  return result;
}

/* ---------- settling ---------- */

/**
 * Keeps `side` for every clashing record of the conflict, as it was shown. Refuses when anything
 * in it changed since, so the person sees the latest before choosing.
 */
export function settleConflict(store: DeviceStore, shown: Conflict, side: Side): void {
  const current = conflicts(store).find((item) => item.key === shown.key);
  if (!current || !jsonEqual(current.records, shown.records))
    throw Error("This changed in the meantime. Have a look at the latest versions.");
  if (!current[side].choosable) throw Error("That version can't be kept.");
  for (const shownRow of current.records) {
    // Settling a parent can settle what's below it (a copy takes its children along).
    const row = store.get(shownRow.kind, shownRow.id);
    if (!row?.problem) continue;
    const resolution = resolutionFor(row, side);
    // Still here after its ancestor was copied: the copy didn't take it along.
    if (!resolution || resolution === "with_parent") throw Error("That version can't be kept.");
    store.resolve(row.kind, row.id, resolution);
  }
}

/* ---------- describing ---------- */

const LABELS: Record<string, string> = {
  title: "Name",
  name: "Name",
  startedAt: "Started",
  endedAt: "Finished",
  text: "Text",
  pinned: "Pinned",
  seconds: "Rest",
  restSeconds: "Rest",
  position: "Order",
  supersetId: "Superset",
  exercises: "Exercises",
  folderId: "Folder",
  effortScale: "Effort scale",
  takenAt: "Taken",
  bodyweightKg: "Bodyweight",
  fatPercent: "Body fat",
  type: "Type",
  primaryMuscle: "Main muscle",
  secondaryMuscles: "Other muscles",
  equipment: "Equipment",
  usesBodyweight: "Counts bodyweight",
  weightUnit: "Weight unit",
  distanceUnit: "Distance unit",
  shortDistanceUnit: "Short distance unit",
  measurementUnit: "Measurement unit",
  firstWeekday: "Week starts",
  defaultRestSeconds: "Default rest",
  countWarmups: "Count warm-ups",
  previousValues: "Previous values",
  autoUpdateRoutineValues: "Update routines",
  trackRepsInReserve: "Track reps in reserve",
};
/** Bookkeeping the person never sees: differences here alone don't make a line. */
const HIDDEN = new Set([
  "createdAt",
  "agent",
  "workoutId",
  "workoutExerciseId",
  "noteId",
  "exerciseId",
  "initialPlan",
  "planSlot",
  "rpeEnabled",
]);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function day(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function short(text: string, length = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function valueLabel(store: DeviceStore, name: string, value: JsonValue | undefined): string {
  const unit = readSettings(store).weightUnit;
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (name === "bodyweightKg" && typeof value === "number")
    return `${weightInput(value, unit)} ${unit}`;
  if (name === "fatPercent" && typeof value === "number") return `${value}%`;
  if (
    (name === "seconds" || name.endsWith("RestSeconds") || name === "restSeconds") &&
    typeof value === "number"
  )
    return value === 0 ? "Off" : durationLabel(value);
  if (
    (name === "startedAt" || name === "endedAt" || name === "takenAt") &&
    typeof value === "string"
  )
    return dateTime(value);
  if (name === "firstWeekday" && typeof value === "number") return WEEKDAYS[value] ?? String(value);
  if (name === "folderId" && typeof value === "string")
    return String(field(store.get("routine_folder", value), "title") ?? "Another folder");
  if (name === "exercises" && Array.isArray(value))
    return value.length === 1 ? "1 exercise" : `${value.length} exercises`;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ") || "None";
  if (typeof value === "string") return short(value);
  if (typeof value === "number") return String(value);
  return "Changed";
}

/** A set as the person logs it: "80 kg × 8", "5:00", "warm-up". */
function setValue(store: DeviceStore, values: JsonObject): string {
  const unit = readSettings(store).weightUnit;
  const parts: string[] = [];
  if (typeof values.weightKg === "number")
    parts.push(`${weightInput(values.weightKg, unit)} ${unit}`);
  if (typeof values.reps === "number")
    parts.push(parts.length ? `× ${values.reps}` : `${values.reps} reps`);
  if (typeof values.durationSeconds === "number") parts.push(durationLabel(values.durationSeconds));
  if (typeof values.distanceMeters === "number") parts.push(`${values.distanceMeters} m`);
  if (typeof values.count === "number") parts.push(String(values.count));
  if (typeof values.type === "string" && values.type !== "normal")
    parts.push(values.type === "warmup" ? "(warm-up)" : `(${values.type})`);
  if (values.completedAt === null) parts.push("(not done)");
  return parts.join(" ") || "Empty";
}

function recordLabel(store: DeviceStore, row: DeviceRecord): string {
  switch (row.kind) {
    case "workout":
      return "Workout";
    case "workout_rest":
      return "Rest";
    case "workout_exercise":
      return String(field(row, "exerciseName") ?? "Exercise");
    case "workout_set": {
      const entry = field(row, "workoutExerciseId");
      const name =
        typeof entry === "string"
          ? field(store.get("workout_exercise", entry), "exerciseName")
          : null;
      const siblings =
        typeof entry === "string"
          ? [...store.list("workout_set", { parentId: entry })].sort(
              (a, b) => Number(field(a, "position") ?? 0) - Number(field(b, "position") ?? 0),
            )
          : [];
      const index = siblings.findIndex((set) => set.id === row.id);
      const set = index >= 0 ? `Set ${index + 1}` : "Set";
      return typeof name === "string" ? `${name} · ${set}` : set;
    }
    case "workout_note":
    case "exercise_note":
      return "Note";
    case "workout_note_comment":
    case "exercise_note_comment":
      return "Comment";
    case "body_measurement":
      return "Entry";
    default:
      return "";
  }
}

/** One side's lines for one record: what differs from the other side, or what it is when the other side has none. */
function sideLines(
  store: DeviceStore,
  row: DeviceRecord,
  mine: JsonObject | null,
  theirs: JsonObject | null,
  gone: string,
): ConflictLine[] {
  const label = recordLabel(store, row);
  if (!mine) return [{ label: label || "This", value: gone }];
  if (row.kind === "workout_set") return [{ label, value: setValue(store, mine) }];
  if (!theirs) {
    // Nothing to compare with: name what it is.
    if (typeof mine.bodyweightKg === "number")
      return [{ label: "Bodyweight", value: valueLabel(store, "bodyweightKg", mine.bodyweightKg) }];
    const name = mine.title ?? mine.name ?? mine.text ?? mine.exerciseName;
    if (typeof name === "string") return [{ label: label || "Name", value: short(name) }];
    return [{ label: label || "This", value: "Kept" }];
  }
  const fields = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].filter(
    (name) => !HIDDEN.has(name) && !jsonEqual(mine[name] ?? null, theirs[name] ?? null),
  );
  return fields.map((name) => ({
    label:
      label && row.kind !== "workout" && row.kind !== "body_measurement"
        ? `${label} · ${LABELS[name] ?? name}`
        : (LABELS[name] ?? name),
    value: valueLabel(store, name, mine[name]),
  }));
}

function describe(
  store: DeviceStore,
  key: string,
  records: DeviceRecord[],
  phoneOk: boolean,
): Conflict {
  const owner = records[0] as DeviceRecord;
  const phone: ConflictLine[] = [];
  const account: ConflictLine[] = [];
  for (const row of records) {
    const which = recordCase(row);
    const mine = row.deleted ? null : (row.content ?? null);
    const theirs = accountContent(row);
    phone.push(
      ...sideLines(
        store,
        row,
        mine,
        theirs,
        which === "rejected" ? "Couldn't be saved" : "Deleted",
      ),
    );
    const missing =
      row.server?.state === "deleted" || row.problem?.reason === "parent_deleted"
        ? "Deleted"
        : "Not in your account";
    account.push(...sideLines(store, row, theirs, mine, missing));
    // Keeping a deletion over the account's version deletes everything below it there too: say
    // what that is, beyond the parts that clash.
    if (which === "gone_here") {
      const below = store.serverDescendants(row.kind, row.id);
      const count = (...kinds: string[]) =>
        below.filter((item) => kinds.includes(item.kind)).length;
      const parts = (
        [
          [count("workout_exercise"), "exercise"],
          [count("workout_set"), "set"],
          [count("workout_note", "workout_note_comment", "exercise_note_comment"), "note"],
        ] as const
      )
        .filter(([n]) => n > 0)
        .map(([n, noun]) => `${n} ${noun}${n === 1 ? "" : "s"}`);
      if (parts.length) account.push({ label: "Holds", value: parts.join(" · ") });
    }
  }
  const kind = key.slice(0, key.indexOf(":"));
  const id = key.slice(key.indexOf(":") + 1);
  let title: string;
  let subtitle: string | null = null;
  switch (kind) {
    case "workout": {
      const workout = store.get("workout", id);
      title = String(field(workout, "title") ?? "Workout");
      subtitle = day(field(workout, "startedAt"));
      break;
    }
    case "routine":
      title = String(field(owner, "title") ?? "Routine");
      subtitle = "Routine";
      break;
    case "routine_folder":
      title = String(field(owner, "title") ?? "Folder");
      subtitle = "Folder";
      break;
    case "body_measurement":
      title = "Bodyweight";
      subtitle = day(field(owner, "takenAt"));
      break;
    case "exercise_note":
      title = "Exercise note";
      break;
    case "custom_exercise":
      title = String(field(owner, "name") ?? "Custom exercise");
      subtitle = "Custom exercise";
      break;
    case "settings":
      title = "Settings";
      break;
    default:
      title = "Changed in two places";
  }
  const ownerCase = recordCase(owner);
  const ownerGoneThere = ownerCase === "gone_there";
  const ownerGoneHere = ownerCase === "gone_here";
  const rejected = records.some((row) => recordCase(row) === "rejected");
  const noun = kind === "workout" ? "workout" : kind === "settings" ? "settings" : "it";
  return {
    key,
    title,
    subtitle,
    records,
    phone: {
      lines: phone,
      choosable: phoneOk,
      confirm: ownerGoneThere
        ? noun === "it"
          ? "Keep it"
          : `Keep the ${noun}`
        : ownerGoneHere
          ? "Delete it"
          : "Keep this version",
    },
    account: {
      lines: account,
      choosable: true,
      confirm: ownerGoneThere ? "Delete it" : rejected ? "Undo my change" : "Keep this version",
    },
  };
}
