import { beforeEach, expect, it } from "vitest";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import { hasUnread, isUnread, markSeen } from "../src/data/note-seen.ts";
import type { NoteComment } from "../src/model/types.ts";
import { files } from "./support/expo-file-system.ts";

beforeEach(() => {
  files.clear();
  forgetDevicePreferences();
});

const comment = (id: string, createdAt: string, agent: string | null = "Coach", noteId = "n") =>
  ({ id, noteId, text: "Reply", createdAt, agent }) satisfies NoteComment;

it("counts an agent's comment as new until its note is opened, and the lifter's never", () => {
  const coach = comment("c1", "2026-03-01T10:00:00.000Z");
  const own = comment("c2", "2026-03-01T11:00:00.000Z", null);
  expect(isUnread(coach)).toBe(true);
  expect(isUnread(own)).toBe(false);
  expect(hasUnread([own])).toBe(false);
  expect(hasUnread([own, coach])).toBe(true);
  expect(hasUnread(undefined)).toBe(false);

  markSeen("n", [coach, own]);
  expect(isUnread(coach)).toBe(false);
  expect(hasUnread([own, coach])).toBe(false);
  // Opening one note leaves another note's replies new.
  expect(isUnread(comment("c3", "2026-03-01T09:00:00.000Z", "Coach", "other"))).toBe(true);
});

it("shows a reply that arrives after the note was opened as new again", () => {
  const first = comment("c1", "2026-03-01T10:00:00.000Z");
  markSeen("n", [first]);
  const later = comment("c2", "2026-03-01T10:00:01.000Z");
  expect(isUnread(later)).toBe(true);
  // A reply from before the opening that syncs in late was already there to see.
  expect(isUnread(comment("c0", "2026-03-01T09:59:00.000Z"))).toBe(false);
  markSeen("n", [first, later]);
  expect(isUnread(later)).toBe(false);
});

it("never moves the seen time back, and opening a note without comments records nothing", () => {
  const latest = comment("c2", "2026-03-02T10:00:00.000Z");
  markSeen("n", [latest]);
  // Opened again on a copy missing the latest reply.
  markSeen("n", [comment("c1", "2026-03-01T10:00:00.000Z")]);
  expect(isUnread(latest)).toBe(false);
  markSeen("empty", []);
  expect(isUnread(comment("c3", "2026-03-01T10:00:00.000Z", "Coach", "empty"))).toBe(true);
});

it("remembers what was seen after the app restarts", () => {
  const coach = comment("c1", "2026-03-01T10:00:00.000Z");
  markSeen("n", [coach]);
  // A new launch reads the preferences from the device again.
  forgetDevicePreferences();
  expect(isUnread(coach)).toBe(false);
  // Unreadable saved state counts every agent reply as new rather than failing.
  files.set("document/leve-device-preferences.json", JSON.stringify({ seenNoteComments: "{" }));
  forgetDevicePreferences();
  expect(isUnread(coach)).toBe(true);
});

it("keeps an agent's reply new when only the lifter's later comment was there to see", () => {
  // The lifter's own comment is newer than anything the agent wrote, so it mustn't count as seen.
  markSeen("own-later", [
    comment("a", "2026-03-01T10:00:00.000Z", "Coach", "own-later"),
    comment("b", "2026-03-01T11:00:00.000Z", null, "own-later"),
  ]);
  expect(isUnread(comment("c", "2026-03-01T10:30:00.000Z", "Coach", "own-later"))).toBe(true);
});
