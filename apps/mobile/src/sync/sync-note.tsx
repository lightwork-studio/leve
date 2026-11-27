import { useSyncExternalStore } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { Banner } from "../ui/notice.tsx";

/** What sync says on every screen: that it isn't running, or that a question waits. */
export interface SyncNote {
  label: string;
  message: string;
  /** The way back: "Resume", "Sign in", "Pause". */
  action?: { label: string; hint: string; onPress: () => void };
}

// SyncHost decides the note above the app. Screens the system draws above it (the live workout and
// finishing it, which are native modals) read it from here and show it themselves.
let current: SyncNote | null = null;
/** The latest handler for the note's action: the published note calls through it. */
let press: () => void = () => {};
const listeners = new Set<() => void>();

const same = (a: SyncNote | null, b: SyncNote | null) =>
  a?.label === b?.label && a?.message === b?.message && a?.action?.label === b?.action?.label;

export function publishSyncNote(note: SyncNote | null): void {
  // The same note keeps its snapshot (nothing draws again) but always acts with the latest handler.
  press = note?.action?.onPress ?? (() => {});
  if (same(current, note)) return;
  current = note
    ? { ...note, ...(note.action ? { action: { ...note.action, onPress: () => press() } } : {}) }
    : null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSyncNote(): SyncNote | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

/** The note as a banner, for a screen drawn above the app. Nothing while sync has nothing to say. */
export function SyncNoteBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const note = useSyncNote();
  if (!note) return null;
  return (
    <View style={style}>
      <Banner
        label={note.label}
        message={note.message}
        {...(note.action ? { action: note.action } : {})}
      />
    </View>
  );
}
