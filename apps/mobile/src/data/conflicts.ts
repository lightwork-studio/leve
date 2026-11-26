import { type JsonObject, jsonEqual } from "@leve/contract";

type JsonValue = unknown;

import type { DeviceRecord, DeviceStore, Resolution } from "@leve/storage";
import { durationLabel, weightInput } from "../ui/format.ts";
import { exerciseNoteReadOnlyReason } from "./exercise-notes.ts";
import { newId } from "./ids.ts";
import { readSettings, rejectedWorkoutDeletion, workoutDetailProblems } from "./read.ts";
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
  /** Whether this side can be kept. */
  choosable: boolean;
  /** What keeping this side does, for the confirm button. */
  confirm: string;
  /** Why this side can't be kept, when it can't. */
  why?: string;
  /**
   * Keeping this side sends a version the server refused once more, which it may refuse again:
   * said under it, and pausing sync stays on offer.
   */
  retry?: string;
  /**
   * Keeping this side loses work that exists nowhere else: said, with an offer to save a copy,
   * before a second confirm.
   */
  warning?: string;
}

/** The screen where a conflict is reviewed, as expo-router takes it. */
export type ReviewTarget =
  | { pathname: "/workout/[id]"; params: { id: string } }
  | { pathname: "/(tabs)/history" };

export interface Conflict {
  key: string;
  title: string;
  subtitle: string | null;
  phone: ConflictSide;
  account: ConflictSide;
  accountLabel?: string;
  /** The records as shown, so a choice made on an outdated view is refused. */
  records: DeviceRecord[];
  /**
   * A deletion that reaches into a workout (a workout or exercise deleted on one side while the
   * other changed what's in it) isn't settled in the popup: it leads to the workout's own review,
   * which restores what's needed and shows every set before anything is deleted.
   */
  review?: { target: ReviewTarget; message: string };
}

/** How one clashing record stands. */
type RecordCase =
  /** Changed on both sides. */
  | "both"
  /** Changed here, gone from the account (deleted there, or lost in a server restore). */
  | "gone_there"
  /** Deleted here, changed in the account. */
  | "gone_here"
  /** Deleted here and in the account: only the deletion is left to agree on. */
  | "gone_both"
  /** The server refused this phone's version as invalid. */
  | "rejected"
  /** Refused, and the account has no version of it (it never got there, or was deleted there). */
  | "rejected_new"
  /** The account's version was made by a newer Leve, which this build can't show. */
  | "newer_there"
  /**
   * Deleted here, and the account has no version of it either (a server restore lost it). Keeping
   * the deletion sends it, so the server keeps a marker and no device offers it again.
   */
  | "gone_nowhere";

function accountContent(row: DeviceRecord): JsonObject | null {
  if (row.server?.state === "live") return row.server.content ?? null;
  if (!row.server) return row.keptContent ?? null;
  return null;
}

function recordCase(row: DeviceRecord): RecordCase | null {
  // Undoing a refused change takes the account's version. One the account has no version of is
  // deleted instead, together with what this phone holds below it, which the popup lists.
  // Only a newer Leve can show the account's version: nothing here can be weighed against it.
  if (row.server?.state === "unavailable") return "newer_there";
  if (row.status === "invalid") return accountContent(row) ? "rejected" : "rejected_new";
  if (row.status !== "conflict") return null;
  // Changed here under something deleted in the account: kept only by copying that ancestor.
  // Deleted here since, it is gone on both sides: the account's deletion is this phone's too.
  if (row.problem?.reason === "parent_deleted")
    return row.content && !row.deleted ? "gone_there" : "gone_both";
  // A deletion made here is weighed against the account's version: the live one, or after a
  // restore whose server never had it, its last copy from before (which keeping theirs restores).
  if (row.deleted) {
    if (row.server?.state === "deleted") return "gone_both";
    if (accountContent(row)) return "gone_here";
    return row.server ? null : "gone_nowhere";
  }
  if (!row.content) return null;
  if (row.server?.state === "deleted" || (!row.server && !row.keptContent)) return "gone_there";
  return accountContent(row) ? "both" : null;
}

/**
 * What keeping `side` means for one record: null when that side can't be kept, and "with_parent"
 * for a record that is kept by copying its deleted ancestor.
 */
function resolutionFor(row: DeviceRecord, side: Side): Resolution["choice"] | "with_parent" | null {
  const which = recordCase(row);
  if (!which) return null;
  // Gone on both sides with no marker in the account: either choice sends the deletion.
  if (which === "gone_nowhere") return "keep_mine";
  if (side === "account") return "keep_theirs";
  switch (which) {
    case "both":
      return "keep_mine";
    case "gone_there":
      // Settings always uses its singleton ID, including when the destination has no copy.
      if (row.kind === "settings" && row.server === null) return "keep_mine";
      // A record under a deleted ancestor, or sharing its parent's id, goes along with that copy.
      if (row.problem?.reason === "parent_deleted" || row.kind === "workout_rest")
        return "with_parent";
      return "save_as_new";
    case "gone_here":
      // Keeping the deletion sends it again, against the account's current version.
      return "keep_mine";
    case "gone_both":
      // Both sides deleted it: the account's deletion is this phone's too.
      return "keep_theirs";
    case "rejected":
    case "rejected_new":
      // Sent again unchanged: it can get through once Leve or the server has been fixed. Not one
      // the account deleted (only saving it as new could keep that), nor one this phone holds
      // back itself, which no server would take.
      return row.server?.state === "deleted" || row.problem?.reason === TOO_MANY_DESCENDANTS
        ? null
        : "keep_mine";
    case "newer_there":
      return null;
  }
}

/** A deletion this phone holds back itself: the server would refuse the request whole. */
const TOO_MANY_DESCENDANTS = "invalid:too_many_descendants";

/**
 * Whether a record can't be settled until the sync running now answers: its upload is on its way,
 * or the account's version isn't known yet (a server restore, a download to fill in, a connection
 * still being made). Each ends with that sync, so the popup waits for it.
 */
function settling(store: DeviceStore, row: DeviceRecord): boolean {
  const sync = store.syncState();
  return (
    row.inFlight ||
    sync.restoring ||
    !!sync.refreshFrom ||
    (sync.account !== null && sync.release === null)
  );
}

/**
 * Whether the sync server can't take this phone's version yet: it lacks the feature or fields it
 * uses, until the server is updated. Only the account's version can be kept meanwhile, or sync
 * paused (see conflicts). Checked once `settling` is false.
 */
function serverLacks(store: DeviceStore, row: DeviceRecord): boolean {
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
  const base = baseKey(store, row);
  // A refused change is decided on its own: undoing it shouldn't take valid changes beside it.
  // Split on the status, not on whether it can be settled: one that can't stays out on its own
  // instead of holding back the rest of its workout.
  // Nothing to place it by (deleted on both sides, or its parents gone from this phone): it is
  // asked about by itself, never left out.
  if (!base) return `${row.kind}:${row.id}`;
  // A refused change, or a deletion that can only give way to the account's version, is decided
  // on its own, so neither takes valid changes beside it along.
  // (A workout or exercise is reviewed on its screen instead, whole.)
  const splitDeletion =
    deletesAccountChildren(store, row) && row.kind !== "workout" && row.kind !== "workout_exercise";
  // One the popup can't weigh (a version only a newer Leve can show) or place at all (a record in
  // a state no sync answer leaves it in) stays out on its own, never holding back the clashes
  // beside it.
  const unplaced = recordCase(row) === null || recordCase(row) === "newer_there";
  return row.status === "invalid" || splitDeletion || unplaced
    ? `${base}|${row.kind}:${row.id}`
    : base;
}

function baseKey(store: DeviceStore, row: DeviceRecord): string | null {
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

/** Everything this phone still shows below a record, every kind, parents before children. */
function localBelow(store: DeviceStore, kind: string, id: string): DeviceRecord[] {
  const below: DeviceRecord[] = [];
  for (const { kind: child } of store.contract.childKinds(kind)) {
    for (const row of store.list(child, { parentId: id })) {
      below.push(row, ...localBelow(store, child, row.id));
    }
  }
  return below;
}

/**
 * Whether unsynced work below a record, outside `shown`, is still on its way to the account: it
 * uploads in this sync and comes back as part of the conflict. Partially synced work isn't: it is
 * sent again only once the server supports what was left out, so it is counted under "Holds".
 */
function uploadingBelow(store: DeviceStore, kind: string, id: string, shown: Set<string>): boolean {
  // Pending work of a kind the server doesn't know never uploads: it isn't waited for either.
  const release = store.syncState().release;
  for (const { kind: child } of store.contract.childKinds(kind)) {
    for (const row of store.list(child, { parentId: id })) {
      const uploads =
        row.inFlight ||
        (row.status === "pending" && release !== null && store.contract.hasKind(child, release));
      const waiting = !shown.has(`${row.kind}:${row.id}`) && uploads;
      if (waiting) return true;
      // Below something the account never had, nothing can upload until it is settled.
      if (row.server && uploadingBelow(store, child, row.id, shown)) return true;
    }
  }
  return false;
}

/** The nearest record above `row` that the account deleted and this phone changed, if any. */
function deletedAncestor(store: DeviceStore, row: DeviceRecord): DeviceRecord | null {
  let current: DeviceRecord | null = row;
  for (let depth = 0; current && depth < 8; depth++) {
    const content = current.content ?? accountContent(current) ?? current.server?.content;
    const parent = content ? store.contract.parentOf(current.kind, content) : null;
    if (!parent) return null;
    current = store.get(parent.kind, parent.id);
    if (current && deletedThere(current)) return current;
  }
  return null;
}

/** Records the account deleted but this phone changed: letting them go drops what's below. */
const deletedThere = (row: DeviceRecord) =>
  recordCase(row) === "gone_there" && row.problem?.reason !== "parent_deleted";

/**
 * Keeping a deletion made here, over an account version that holds things below it (comments
 * added there, say): those would go too. Only offered for a record with nothing below it.
 */
function deletesAccountChildren(store: DeviceStore, row: DeviceRecord): boolean {
  return recordCase(row) === "gone_here" && store.serverDescendants(row.kind, row.id).length > 0;
}

/** Whether keeping this phone's side is possible for `row` within the records shown. */
function phonePlanOk(store: DeviceStore, row: DeviceRecord, shown: Set<string>): boolean {
  const plan = resolutionFor(row, "phone");
  if (deletesAccountChildren(store, row)) return false;
  if (plan !== "with_parent") return plan !== null;
  // Kept by copying the deleted record above it: that record has to be here, being copied.
  const ancestor = deletedAncestor(store, row);
  return !!ancestor && shown.has(`${ancestor.kind}:${ancestor.id}`);
}

/** Whether a workout conflict is a deletion that reaches into the workout (see Conflict.review). */
function reviewOnScreen(
  store: DeviceStore,
  key: string,
  records: DeviceRecord[],
): Conflict["review"] | "wait" | undefined {
  if (!key.startsWith("workout:") || key.includes("|")) return undefined;
  const review = routedReview(store, key, records);
  if (!review || review === "wait") return review;
  // Only lead somewhere that can settle it: otherwise the popup settles it itself.
  const workoutId = key.slice("workout:".length);
  const settlesThere =
    review.target.pathname === "/(tabs)/history"
      ? records.some(rejectedWorkoutDeletion)
      : workoutDetailProblems(store, workoutId).length > 0;
  return settlesThere ? review : undefined;
}

function routedReview(
  store: DeviceStore,
  key: string,
  records: DeviceRecord[],
): Conflict["review"] | "wait" | undefined {
  const deletion = (kinds: string[], which: RecordCase) =>
    records.some((row) => kinds.includes(row.kind) && recordCase(row) === which);
  const workoutId = key.slice("workout:".length);
  // The workout screen reviews only a workout it can show; otherwise History does.
  const shownWorkout = store.get("workout", workoutId);
  const workoutScreen: ReviewTarget =
    shownWorkout?.content && !shownWorkout.deleted
      ? { pathname: "/workout/[id]", params: { id: workoutId } }
      : { pathname: "/(tabs)/history" };
  // Deleted here and waiting to upload: its screen is gone until that sync answers.
  if (shownWorkout?.deleted && shownWorkout.status === "pending") return "wait";
  // Below a deleted note, a comment is kept by saving its note as new: the popup does that.
  const underDeletedWorkoutPart = (row: DeviceRecord) =>
    row.problem?.reason === "parent_deleted" &&
    ["workout", "workout_exercise"].includes(deletedAncestor(store, row)?.kind ?? "");
  if (deletion(["workout"], "gone_here"))
    return {
      target: { pathname: "/(tabs)/history" },
      message:
        "Deleted on this phone, but changed in your account since. Review it in History to see what changed before it goes.",
    };
  if (deletion(["workout_exercise"], "gone_here"))
    return {
      target: workoutScreen,
      message:
        "An exercise deleted on this phone was changed in your account since. Review the workout to see its sets before it goes.",
    };
  if (
    deletion(["workout", "workout_exercise"], "gone_there") ||
    records.some(underDeletedWorkoutPart)
  )
    return {
      target: workoutScreen,
      message:
        "Deleted in your account, but this phone has changes in it. Review the workout to keep them as new or let them go.",
    };
  return undefined;
}

/**
 * Every conflict, oldest first, except while the sync running now is still answering one (see
 * `settling`). Nothing else is left out: one that can't be settled for a while (a server that needs
 * an update, a change it refused, a version only a newer Leve can show) comes with the phone's side
 * not choosable and says why, and the popup offers pausing sync instead.
 */
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
    // A part the sync running now is still answering holds back its whole group until it has, so
    // a choice never covers only half of what clashes.
    if (records.some((row) => settling(store, row))) continue;
    // A deletion reaching into a workout is reviewed on the workout's own screen. Deleted here and
    // still to upload, it waits for that upload's answer.
    const review = reviewOnScreen(store, key, records);
    if (review === "wait") continue;
    if (review) {
      result.push({ ...describe(store, key, records, false), review });
      continue;
    }
    // Work below something deleted in the account that hasn't come back as part of this conflict
    // yet (still to upload, or on its way) would go with it unseen: wait until it has.
    const shown = new Set(records.map((row) => `${row.kind}:${row.id}`));
    // Only work that can still get there counts: below a parent the account never had, it can't
    // upload at all, so it is counted under "Holds" instead of waited for.
    const unsettled = records
      .filter(deletedThere)
      .some((row) => uploadingBelow(store, row.kind, row.id, shown));
    if (unsettled) continue;
    // Deleted on both sides at the top: everything below goes with it whichever side is kept.
    const bothDeleted = recordCase(records[0] as DeviceRecord) === "gone_both";
    const lacking = records.some((row) => serverLacks(store, row));
    const placed = records.every((row) => recordCase(row) !== null);
    const phoneOk =
      placed && !lacking && (bothDeleted || records.every((row) => phonePlanOk(store, row, shown)));
    result.push(describe(store, key, records, phoneOk, lacking));
  }
  // One the popup can't place goes last: the popup shows one at a time, and settling the others
  // first may settle it too (a review that takes it along, say).
  const unplaced = (item: Conflict) => item.records.some((row) => recordCase(row) === null);
  return [...result.filter((item) => !unplaced(item)), ...result.filter(unplaced)];
}

/* ---------- settling ---------- */

/**
 * Keeps `side` for every clashing record of the conflict, as it was shown. Refuses when anything
 * in it changed since, so the person sees the latest before choosing.
 */
export function settleConflict(store: DeviceStore, shown: Conflict, side: Side): void {
  if (shown.review) throw Error("Review this one on its screen.");
  // Everything shown counts, not only the records: what the account's version still holds, too.
  const current = conflicts(store).find((item) => item.key === shown.key);
  if (!current || !jsonEqual(current, shown))
    throw Error("This changed in the meantime. Have a look at the latest versions.");
  if (!current[side].choosable) throw Error("That version can't be kept.");
  // Deleted on both sides at the top: both choices mean the account's deletion.
  const kept = recordCase(current.records[0] as DeviceRecord) === "gone_both" ? "account" : side;
  // Check every record before writing any, so a choice is never applied halfway.
  const listed = new Set(current.records.map((row) => `${row.kind}:${row.id}`));
  for (const row of current.records) {
    const ok =
      kept === "account" ? resolutionFor(row, "account") !== null : phonePlanOk(store, row, listed);
    if (!ok) throw Error("That version can't be kept.");
  }
  for (const shownRow of current.records) {
    // Settling a parent can settle what's below it (a copy takes its children along).
    const row = store.get(shownRow.kind, shownRow.id);
    if (!row?.problem) continue;
    const choice = resolutionFor(row, kept);
    // Still here after its ancestor was copied: the copy didn't take it along.
    if (!choice || choice === "with_parent") throw Error("That version can't be kept.");
    store.resolve(
      row.kind,
      row.id,
      choice === "save_as_new" ? { choice, newId: newId() } : { choice },
    );
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
  exerciseName: "Exercise",
  doubleDumbbellVolume: "Double dumbbells",
  archived: "Archived",
  routineId: "Routine",
  rpe: "RPE",
  repsInReserve: "Reps in reserve",
  completedAt: "Done",
  useRepRange: "Rep range",
  exerciseType: "Measured by",
};
/** Fields whose values are words joined by underscores ("upper_back", "same_routine"). */
const WORDS = new Set(["primaryMuscle", "secondaryMuscles", "equipment", "previousValues", "type"]);
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
  const words = (text: string) => (WORDS.has(name) ? text.replaceAll("_", " ") : text);
  if (Array.isArray(value)) return value.map((item) => words(String(item))).join(", ") || "None";
  if (name === "completedAt" && typeof value === "string") return dateTime(value);
  if (name === "routineId" && typeof value === "string")
    return String(field(store.get("routine", value), "title") ?? "Another routine");
  if (typeof value === "string") return short(words(value));
  if (typeof value === "number") return String(value);
  return "Changed";
}

/** A set as the person logs it: "80 kg × 8", "5:00", "warm-up". */
function setValue(store: DeviceStore, values: JsonObject): string {
  const unit = readSettings(store).weightUnit;
  const parts: string[] = [];
  if (typeof values.weightKg === "number")
    parts.push(`${weightInput(values.weightKg, unit)} ${unit}`);
  const reps =
    typeof values.repRangeMin === "number" && typeof values.repRangeMax === "number"
      ? `${values.repRangeMin}–${values.repRangeMax}`
      : typeof values.reps === "number"
        ? String(values.reps)
        : null;
  if (reps !== null) parts.push(parts.length ? `× ${reps}` : `${reps} reps`);
  if (typeof values.durationSeconds === "number") parts.push(durationLabel(values.durationSeconds));
  if (typeof values.distanceMeters === "number") parts.push(`${values.distanceMeters} m`);
  if (typeof values.count === "number") parts.push(String(values.count));
  if (typeof values.rpe === "number") parts.push(`RPE ${values.rpe}`);
  if (typeof values.repsInReserve === "number") parts.push(`RIR ${values.repsInReserve}`);
  if (typeof values.type === "string" && values.type !== "normal")
    parts.push(values.type === "warmup" ? "(warm-up)" : `(${values.type})`);
  if (values.completedAt === null) parts.push("(not done)");
  return parts.join(" ") || "Empty";
}

/** A routine exercise's plan: "3 sets · 85 kg × 8". */
function plannedExercise(store: DeviceStore, exercise: JsonObject): string {
  const sets = Array.isArray(exercise.sets) ? (exercise.sets as JsonObject[]) : [];
  const values = sets.map((set) => setValue(store, set));
  // Set by set when they differ from one another, so their order shows too.
  const shown = new Set(values).size === 1 ? [values[0] as string] : values;
  const count = sets.length === 1 ? "1 set" : `${sets.length} sets`;
  return values.length ? `${count} · ${shown.join(", ")}` : count;
}

/** The exercises of a routine that differ, exercise by exercise. */
function routineExerciseLines(store: DeviceStore, mine: unknown, theirs: unknown): ConflictLine[] {
  const list = (value: unknown) => (Array.isArray(value) ? (value as JsonObject[]) : []);
  const others = list(theirs);
  const unmatched = new Map(others.map((exercise) => [exercise.id, exercise]));
  const lines: ConflictLine[] = [];
  list(mine).forEach((exercise, index) => {
    const match = unmatched.get(exercise.id);
    unmatched.delete(exercise.id);
    const moved = !!match && others.indexOf(match) !== index;
    if (match && !moved && jsonEqual(match, exercise)) return;
    const plan = plannedExercise(store, exercise);
    // When the sets read the same, say what else differs: rest, superset, rep range.
    const extra =
      match && plan === plannedExercise(store, match)
        ? (["restSeconds", "supersetId", "useRepRange", "exerciseType"] as const)
            .filter((name) => !jsonEqual(exercise[name] ?? null, match[name] ?? null))
            .map((name) => `${LABELS[name] ?? name} ${valueLabel(store, name, exercise[name])}`)
        : [];
    lines.push({
      label: String(exercise.exerciseName ?? "Exercise"),
      value: [plan, ...extra, ...(moved ? [`number ${index + 1}`] : [])].join(" · "),
    });
  });
  for (const exercise of unmatched.values())
    lines.push({
      label: String(exercise.exerciseName ?? "Exercise"),
      value: "Not in this version",
    });
  return lines;
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
      // Gone from this phone (deleted here): its place in the account's order instead.
      const position = field(row, "position");
      const set =
        index >= 0
          ? `Set ${index + 1}`
          : typeof position === "number" && Number.isInteger(position)
            ? `Set ${position}`
            : "Set";
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
  if (!theirs) {
    // Nothing to compare with: everything it holds, so keeping or letting it go is seen in full.
    if (row.kind === "workout_set") return [{ label, value: setValue(store, mine) }];
    const lines: ConflictLine[] = [];
    for (const name of Object.keys(mine)) {
      if (HIDDEN.has(name) || mine[name] === null || mine[name] === undefined) continue;
      if (name === "exercises" && row.kind === "routine")
        lines.push(...routineExerciseLines(store, mine.exercises, []));
      else
        lines.push({
          label:
            label && row.kind !== "workout" && row.kind !== "body_measurement"
              ? `${label} · ${LABELS[name] ?? name}`
              : (LABELS[name] ?? name),
          value: valueLabel(store, name, mine[name]),
        });
    }
    return lines.length ? lines : [{ label: label || "This", value: "Kept" }];
  }
  const fields = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].filter(
    (name) => !jsonEqual(mine[name] ?? null, theirs[name] ?? null),
  );
  const shown = fields.filter((name) => !HIDDEN.has(name));
  const prefix = (name: string) =>
    label && row.kind !== "workout" && row.kind !== "body_measurement"
      ? `${label} · ${LABELS[name] ?? name}`
      : (LABELS[name] ?? name);
  const lines: ConflictLine[] = [];
  if (row.kind === "workout_set") {
    // The set as logged, then whatever else differs that its value doesn't show.
    const value = setValue(store, mine);
    lines.push({ label, value });
    if (value === setValue(store, theirs))
      for (const name of shown)
        lines.push({ label: prefix(name), value: valueLabel(store, name, mine[name]) });
  } else {
    for (const name of shown) {
      if (name === "exercises" && row.kind === "routine")
        lines.push(...routineExerciseLines(store, mine.exercises, theirs.exercises));
      else lines.push({ label: prefix(name), value: valueLabel(store, name, mine[name]) });
    }
  }
  // Only bookkeeping differs: still say that something does, so neither side reads as nothing.
  if (!lines.length && fields.length) lines.push({ label: label || "Details", value: "Changed" });
  return lines;
}

function describe(
  store: DeviceStore,
  key: string,
  records: DeviceRecord[],
  phoneOk: boolean,
  /** The sync server can't take this phone's version yet (see serverLacks). */
  lacking = false,
): Conflict {
  const owner = records[0] as DeviceRecord;
  const phone: ConflictLine[] = [];
  const account: ConflictLine[] = [];
  for (const row of records) {
    const which = recordCase(row);
    const mine = row.deleted ? null : (row.content ?? null);
    // Under something deleted in the account, the account's copy goes with it, whatever it held.
    const theirs = row.problem?.reason === "parent_deleted" ? null : accountContent(row);
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
        : row.server?.state === "unavailable"
          ? "Made with a newer Leve"
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
          [count("workout_note"), "note"],
          [count("workout_note_comment", "exercise_note_comment"), "comment"],
        ] as const
      )
        .filter(([n]) => n > 0)
        .map(([n, noun]) => `${n} ${noun}${n === 1 ? "" : "s"}`);
      if (parts.length) account.push({ label: "Holds", value: parts.join(" · ") });
      // And what's below, as the account has it: an edit or a comment made there shows.
      for (const item of below) {
        const child = store.get(item.kind, item.id);
        const values = child?.server?.state === "live" ? child.server.content : null;
        if (!child || !values) continue;
        if (item.kind === "workout_set")
          account.push({ label: recordLabel(store, child), value: setValue(store, values) });
        else if (typeof values.text === "string")
          account.push({ label: recordLabel(store, child), value: short(values.text) });
      }
    }
    // Letting go something the account no longer has drops what this phone holds below it.
    // Deleting a refused record the account has no version of drops what's below it here too.
    if (deletedThere(row) || which === "rejected_new") {
      const below = localBelow(store, row.kind, row.id);
      const count = (...kinds: string[]) =>
        below.filter((item) => kinds.includes(item.kind)).length;
      const said = (
        [
          [count("workout_exercise"), "exercise"],
          [count("workout_set"), "set"],
          [count("workout_note"), "note"],
          [count("workout_note_comment", "exercise_note_comment"), "comment"],
          [count("workout_rest"), "rest setting"],
        ] as const
      )
        .filter(([n]) => n > 0)
        .map(([n, noun]) => `${n} ${noun}${n === 1 ? "" : "s"}`);
      if (said.length) phone.push({ label: "Holds", value: said.join(" · ") });
      // A refused change below it is never asked about on its own: show it here, since letting
      // this go drops it too.
      const listed = new Set(records.map((item) => `${item.kind}:${item.id}`));
      for (const item of below) {
        if (item.status !== "invalid" || listed.has(`${item.kind}:${item.id}`) || !item.content)
          continue;
        for (const line of sideLines(store, item, item.content, null, ""))
          phone.push({ label: line.label, value: `${line.value} (not saved)` });
      }
    }
  }
  const base = key.split("|")[0] as string;
  const kind = base.slice(0, base.indexOf(":"));
  const id = base.slice(base.indexOf(":") + 1);
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
  const goneBoth =
    ownerCase === "gone_both" || records.every((row) => recordCase(row) === "gone_nowhere");
  const missingSettings = owner.kind === "settings" && owner.server === null;
  const accountLabel = missingSettings
    ? owner.keptContent
      ? "Previous synced settings"
      : "Default settings"
    : null;
  const rejected = records.some((row) => recordCase(row) === "rejected");
  const refusedNew = records.some((row) => recordCase(row) === "rejected_new");
  // Only a newer Leve can show the account's version: neither side can be weighed here.
  // A state no sync answer should leave a record in: shown, but only pausing sync is offered.
  const unplaced = records.some((row) => recordCase(row) === null);
  const newer = records.some((row) => recordCase(row) === "newer_there");
  // Named after the topmost record that clashes, not the group: an exercise deleted in the
  // account leaves its workout in place either way.
  const noun = owner.kind === "workout" ? "workout" : "it";
  return {
    key,
    title,
    subtitle,
    records,
    ...(accountLabel ? { accountLabel } : {}),
    phone: {
      lines: phone,
      choosable: phoneOk,
      ...(phoneOk
        ? {}
        : {
            why: unplaced
              ? "This version of Leve can't settle this one. Pause sync until it is fixed."
              : newer
                ? "Your account has a version made with a newer Leve. Update Leve to see both, or keep the account's version without seeing it."
                : lacking
                  ? "Your sync server needs an update before it can take this version."
                  : records.some((row) => row.problem?.reason === TOO_MANY_DESCENDANTS)
                    ? "It holds too much to delete in one go. Keep the account's version, then delete what's in it a part at a time."
                    : rejected || refusedNew
                      ? "This phone's change couldn't be saved in your account."
                      : records.some((row) => deletesAccountChildren(store, row))
                        ? "It holds things below it in your account. Keep its version to see them, then delete it again if you want."
                        : "This version can't be kept on its own.",
          }),
      ...(phoneOk && (rejected || refusedNew)
        ? {
            retry:
              "Your account didn't take this change. Trying again sends it unchanged: it gets through once Leve or your sync server is fixed, and if not, this comes back.",
          }
        : {}),
      confirm:
        phoneOk && (rejected || refusedNew)
          ? "Try again"
          : goneBoth
            ? "Keep it deleted"
            : ownerGoneThere
              ? noun === "it"
                ? "Keep it"
                : `Keep the ${noun}`
              : ownerGoneHere
                ? "Delete it"
                : "Keep this version",
    },
    account: {
      lines: account,
      choosable: !unplaced,
      ...(unplaced ? { why: "This version of Leve can't settle it." } : {}),
      // Work kept nowhere else goes with this choice: asked once more, with a copy offered.
      ...(refusedNew
        ? {
            warning:
              "Your account has no copy of this phone's version, so deleting it can't be undone. Save a copy first if you might want it back.",
          }
        : newer
          ? {
              warning:
                "This phone's version goes, and this version of Leve can't show your account's. Save a copy first if you might want it back.",
            }
          : {}),
      confirm: accountLabel
        ? `Use ${accountLabel.toLowerCase()}`
        : goneBoth
          ? "Keep it deleted"
          : ownerGoneThere || refusedNew
            ? "Delete it"
            : rejected
              ? "Undo my change"
              : "Keep this version",
    },
  };
}
