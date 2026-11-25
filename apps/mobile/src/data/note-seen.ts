import { useMemo, useSyncExternalStore } from "react";
import type { NoteComment } from "../model/types.ts";
import {
  readDevicePreference,
  subscribeDevicePreferences,
  writeDevicePreference,
} from "./device-preference-store.ts";

// Which agent comments the lifter has seen, kept on this device only: for each note, the time of
// the newest comment seen when it was last opened. An agent's comment after that is new.

const KEY = "seenNoteComments";

type Seen = Record<string, string>;

function readSeen(): Seen {
  return parseSeen(readDevicePreference(KEY));
}

function parseSeen(raw: unknown): Seen {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Seen) : {};
  } catch {
    return {};
  }
}

/** Whether a comment is one the lifter hasn't seen: an agent's, newer than the note's last opening. */
export function isUnread(comment: NoteComment, seen: Seen = readSeen()) {
  if (comment.agent === null) return false;
  const at = seen[comment.noteId];
  return at === undefined || Date.parse(comment.createdAt) > Date.parse(at);
}

/** Whether any of these comments is new. */
export function hasUnread(comments: readonly NoteComment[] | undefined, seen: Seen = readSeen()) {
  return (comments ?? []).some((comment) => isUnread(comment, seen));
}

/** Remember that a note's comments up to now have been seen. */
export function markSeen(noteId: string, comments: readonly NoteComment[]) {
  const newest = comments.reduce<string | null>(
    (latest, { createdAt }) =>
      latest === null || Date.parse(createdAt) > Date.parse(latest) ? createdAt : latest,
    null,
  );
  if (newest === null) return;
  const seen = readSeen();
  if (seen[noteId] && Date.parse(seen[noteId]) >= Date.parse(newest)) return;
  writeDevicePreference(KEY, JSON.stringify({ ...seen, [noteId]: newest }));
}

/** The seen map, re-read when comments are marked seen. */
export function useSeenComments(): Seen {
  const raw = useSyncExternalStore(subscribeDevicePreferences, () => readDevicePreference(KEY));
  return useMemo(() => parseSeen(raw), [raw]);
}
