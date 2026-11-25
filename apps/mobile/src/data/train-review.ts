import { jsonEqual } from "@leve/contract";
import type { DeviceRecord, DeviceStore } from "@leve/storage";
import { newId } from "./ids.ts";
import { unavailableReviewFields } from "./workout-review.ts";

/**
 * A routine or folder version the server rejected, as Train offers it for review:
 * - `restore`: deleted here after it changed elsewhere. It comes back to be seen before deleting
 *   it again, as a workout does in History.
 * - `deleted_elsewhere`: changed here after it was deleted elsewhere.
 * - `both_changed`: a folder changed here and elsewhere. A routine changed on both sides is
 *   reviewed in its editor, field by field, so Train leaves it there.
 */
export type TrainReviewCase = "restore" | "deleted_elsewhere" | "both_changed";

export type TrainReviewChoice = "keep_mine" | "keep_theirs" | "save_as_new";

export function trainReviewCase(row: DeviceRecord | null): TrainReviewCase | null {
  if (row?.status !== "conflict") return null;
  if (row.kind !== "routine" && row.kind !== "routine_folder") return null;
  if (row.deleted)
    return row.server?.state === "live" || (!row.server && !!row.keptContent) ? "restore" : null;
  if (!row.content) return null;
  if (row.server?.state === "deleted") return "deleted_elsewhere";
  if (row.kind === "routine_folder" && row.server?.state === "live" && row.server.content)
    return "both_changed";
  return null;
}

/** What each case offers. Keeping a deleted record means saving it as new, and only a routine has
 * anything worth saving: a folder is a name, and its routines already show under no folder. */
export function trainReviewChoices(row: DeviceRecord): TrainReviewChoice[] {
  switch (trainReviewCase(row)) {
    case "restore":
      return ["keep_theirs"];
    case "both_changed":
      return ["keep_mine", "keep_theirs"];
    case "deleted_elsewhere":
      return row.kind === "routine" ? ["save_as_new", "keep_theirs"] : ["keep_theirs"];
    default:
      return [];
  }
}

export function trainReviews(store: DeviceStore): DeviceRecord[] {
  return store.problems().filter((row) => trainReviewCase(row) !== null);
}

/** Why the review can't be settled yet, or null. */
export function trainReviewBlocked(store: DeviceStore, row: DeviceRecord): string | null {
  const sync = store.syncState();
  if (row.inFlight || sync.refreshFrom || sync.restoring)
    return "Finish syncing before choosing a version.";
  // Keeping this device's folder sends it again, which needs every field it holds.
  if (trainReviewCase(row) === "both_changed" && unavailableReviewFields(store, row).length)
    return "Sync with a server that supports all saved fields before choosing a version.";
  return null;
}

/** Settles the review as it was shown: a record that changed since is refused, to be seen first. */
export function resolveTrainReview(
  store: DeviceStore,
  shown: DeviceRecord,
  choice: TrainReviewChoice,
): DeviceRecord | null {
  const row = store.get(shown.kind, shown.id);
  if (!row || !trainReviewCase(row) || !jsonEqual(row, shown))
    throw Error("This record changed. Review the latest versions before choosing.");
  if (!trainReviewChoices(row).includes(choice)) throw Error("Choose one of the offered versions.");
  const blocked = trainReviewBlocked(store, row);
  if (blocked) throw Error(blocked);
  return store.resolve(
    row.kind,
    row.id,
    choice === "save_as_new" ? { choice, newId: newId() } : { choice },
  );
}
