import { router, usePathname } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { type StyleProp, Text, View, type ViewStyle } from "react-native";
import { font, touch, type } from "../theme.ts";
import { Button } from "../ui/buttons.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { shortDay } from "../ui/format.ts";
import { Tap } from "../ui/tap.tsx";
import { themedStyles, useStyles } from "../ui/themed.ts";
import { readLastSynced } from "./sync-preferences.ts";

/** What sync says on every screen: that it isn't running, or that a question waits. */
export interface SyncNote {
  label: string;
  message: string;
  /**
   * `problem` when Leve can't sync (drawn in the alert colour), `quiet` when the person chose it
   * (paused, signed out) or sync only waits for a workout to end.
   */
  tone: "problem" | "quiet";
  /** The note in a word or two, for the tag in the week bar: "Paused", "Not synced". */
  tag: string;
  /** Why, in a few words, after the label on one line: "since 26 Nov". */
  short?: string;
  /** The way back: "Resume", "Sign in", "Pause". */
  action?: { label: string; hint: string; onPress: () => void };
}

// SyncHost decides the note. The week bar shows it as a tag on the tabs, SyncHost as a line on
// every other screen, and screens the system draws above the app (the live workout and finishing
// it, which are native modals) read it from here and show the line themselves.
let current: SyncNote | null = null;
/** The latest handler for the note's action: the published note calls through it. */
let press: () => void = () => {};
const listeners = new Set<() => void>();

const same = (a: SyncNote | null, b: SyncNote | null) =>
  a?.label === b?.label &&
  a?.message === b?.message &&
  a?.tone === b?.tone &&
  a?.tag === b?.tag &&
  a?.short === b?.short &&
  a?.action?.label === b?.action?.label;

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

/** Where the details offer no way to Settings: already there, or logging a workout. */
const NO_SETTINGS = new Set(["/settings", "/workout/active", "/workout/finish"]);

/**
 * The whole note: what it says, when this phone last synced, its action, and the way to Settings.
 * Opened from the tag or the line.
 */
function SyncDetails({ note, onClose }: { note: SyncNote; onClose: () => void }) {
  const styles = useStyles(sheet);
  const pathname = usePathname();
  const last = readLastSynced();
  const { action } = note;
  const settings = !NO_SETTINGS.has(pathname) && action?.label !== "Settings";
  return (
    <Dialog
      eyebrow={note.label}
      onClose={onClose}
      closeLabel="Close"
      bottom
      {...(action
        ? {
            confirm: {
              label: action.label,
              accessibilityLabel: action.label,
              onPress: () => {
                onClose();
                action.onPress();
              },
            },
          }
        : {})}
      {...(settings
        ? {
            footer: (
              <Button
                rank="text"
                label="Sync settings"
                onPress={() => {
                  onClose();
                  router.push("/settings");
                }}
              />
            ),
          }
        : {})}
    >
      <Text style={styles.message}>{note.message}</Text>
      {last !== null ? (
        <Text style={styles.when}>
          {`Last synced ${shortDay(last)}, ${new Date(last).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}
        </Text>
      ) : null}
    </Dialog>
  );
}

/** Red and filled when Leve can't sync; a grey ring when it was chosen or only waits. */
function Dot({ tone }: { tone: SyncNote["tone"] }) {
  const styles = useStyles(sheet);
  return <View style={[styles.dot, tone === "quiet" && styles.dotQuiet]} />;
}

const spoken = (note: SyncNote) => `${note.label}. ${note.message}`;
const DETAILS_HINT = "Shows what this means and what you can do";

/**
 * The note as a small tag, for the week bar over the tabs: a dot and a word or two. Tapping it
 * opens the details. Nothing while sync has nothing to say.
 */
export function SyncTag() {
  const styles = useStyles(sheet);
  const note = useSyncNote();
  const [open, setOpen] = useState(false);
  if (!note) return null;
  return (
    <>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={spoken(note)}
        accessibilityHint={DETAILS_HINT}
        onPress={() => setOpen(true)}
        scaleTo={0.94}
        hitSlop={TAG_SLOP}
        style={[styles.tag, note.tone === "problem" && styles.tagProblem]}
      >
        <Dot tone={note.tone} />
        <Text
          style={[styles.tagText, note.tone === "problem" && styles.problemText]}
          numberOfLines={1}
        >
          {note.tag}
        </Text>
      </Tap>
      {open ? <SyncDetails note={note} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Reaches the tag's 26 pt height out to a 44 pt target. */
const TAG_SLOP = { top: 9, bottom: 9, left: 4, right: 4 };

/**
 * The note as one line, for every screen without the week bar: a dot, the label and why, with the
 * action beside it. Tapping the line opens the details. `note` defaults to the published one.
 */
export function SyncLine({
  note: given,
  rule = false,
  style,
}: {
  note?: SyncNote | null;
  /** A hairline under it, where it sits on the screen's own ground. */
  rule?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(sheet);
  const published = useSyncNote();
  const note = given === undefined ? published : given;
  const [open, setOpen] = useState(false);
  if (!note) return null;
  const { action } = note;
  return (
    <View style={[styles.line, rule && styles.lineRule, style]}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={spoken(note)}
        accessibilityHint={DETAILS_HINT}
        onPress={() => setOpen(true)}
        scaleTo={0.98}
        style={styles.lineText}
      >
        <Dot tone={note.tone} />
        <Text style={styles.lineLabel} numberOfLines={1}>
          <Text style={note.tone === "problem" ? styles.problemText : styles.quietText}>
            {note.label}
          </Text>
          {note.short ? <Text style={styles.lineShort}>{` · ${note.short}`}</Text> : null}
        </Text>
      </Tap>
      {action ? (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={action.label}
          accessibilityHint={action.hint}
          onPress={action.onPress}
          scaleTo={0.94}
          hitSlop={8}
          style={styles.pill}
        >
          <Text style={styles.pillText}>{action.label}</Text>
        </Tap>
      ) : null}
      {open ? <SyncDetails note={note} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.alert },
  dotQuiet: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: c.fg3 },
  problemText: { color: c.alert },
  quietText: { color: c.fg },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 26,
    flexShrink: 0,
    paddingLeft: 8,
    paddingRight: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.line2,
  },
  tagProblem: { borderColor: c.alert },
  tagText: { ...type.labelSmall, color: c.fg },
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36 },
  lineRule: { borderBottomWidth: 1, borderBottomColor: c.line },
  lineText: {
    flex: 1,
    minWidth: 0,
    minHeight: touch,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingLeft: 8,
  },
  lineLabel: { ...type.action, flexShrink: 1 },
  lineShort: { ...font.mono, color: c.fg3 },
  pill: {
    minHeight: 28,
    paddingHorizontal: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: c.line2,
    backgroundColor: c.s2,
    alignItems: "center",
    justifyContent: "center",
  },
  pillText: { ...type.labelSmall, color: c.fg },
  message: { ...type.body, color: c.fg2, marginTop: 8 },
  when: { ...type.meta, color: c.fg3, marginTop: 10 },
}));
