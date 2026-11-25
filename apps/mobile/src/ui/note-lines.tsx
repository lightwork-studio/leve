import { LIMITS } from "@leve/core";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { hasUnread, useSeenComments } from "../data/note-seen.ts";
import type { NoteComment } from "../model/types.ts";
import { font, radius, space, type } from "../theme.ts";
import { CommentIcon, NoteIcon, PinIcon, PlusIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

const ICON = 13;
/** One line of note text. */
const LINE = 19;

/** A note as a list of notes shows it. */
export interface NoteLine {
  id: string;
  text: string;
  pinned: boolean;
  /** Shown before the text in small caps, such as "Last time"; none for today's notes. */
  label?: string;
  /** The agent that wrote it; null for the lifter. */
  agent: string | null;
  comments: readonly NoteComment[];
}

/** Writing a new note where the notes are. */
export interface NoteAdd {
  /** The field's spoken label, such as "Note for Bench Press". */
  label: string;
  /** What a pin attaches the note to, or null when the note can't be pinned here. */
  pinTo: string | null;
  pinnedHint: string;
  unpinnedHint: string;
  /** Every note written here is pinned, as on an exercise's own screen. */
  alwaysPinned?: boolean;
  /** Saves the note; a thrown error shows under the field and keeps the text. */
  onSave: (text: string, pinned: boolean) => void;
}

/**
 * Notes shown where they apply, always open: one slim line each, then a field to write one. The
 * lines sit in a shaded box once there is a note or one is being written; with neither, the field
 * stands alone. Tapping a note opens it.
 */
export function NoteLines({
  notes,
  add,
  onOpen,
  boxed = "auto",
  variant = "inset",
}: {
  notes: readonly NoteLine[];
  add?: NoteAdd;
  onOpen: (note: NoteLine) => void;
  /** "always" keeps the box even with no notes, for a list that is its own card. */
  boxed?: "auto" | "always";
  /** "inset" sits inside a card, like an exercise's; "card" is a card of its own on the screen. */
  variant?: "inset" | "card";
}) {
  const styles = useStyles(sheet);
  const seen = useSeenComments();
  const [writing, setWriting] = useState(false);
  if (!notes.length && !add) return null;
  const box = boxed === "always" || notes.length > 0 || writing;
  return (
    <View style={variant === "card" ? styles.card : [styles.box, !box && styles.unboxed]}>
      {notes.map((note) => (
        <Line
          key={note.id}
          note={note}
          unread={hasUnread(note.comments, seen)}
          onPress={() => onOpen(note)}
        />
      ))}
      {add && <AddField add={add} onWriting={setWriting} />}
    </View>
  );
}

function Line({ note, unread, onPress }: { note: NoteLine; unread: boolean; onPress: () => void }) {
  const styles = useStyles(sheet);
  const c = useColors();
  const spoken = [
    note.pinned ? "Pinned" : note.label,
    note.agent ? `by ${note.agent}` : null,
    note.text,
    note.comments.length
      ? `${note.comments.length} ${note.comments.length === 1 ? "comment" : "comments"}`
      : null,
    unread ? "new reply" : null,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={onPress}
      scaleTo={0.99}
      hitSlop={{ top: 4, bottom: 4 }}
      style={styles.row}
    >
      <View style={styles.mark}>
        {note.pinned ? (
          <PinIcon color={c.fg2} size={ICON} />
        ) : (
          <NoteIcon color={c.fg3} size={ICON} />
        )}
      </View>
      <Text style={styles.text} numberOfLines={2}>
        {note.label && !note.pinned && (
          <Text style={styles.prefix}>{`${note.label.toUpperCase()}  `}</Text>
        )}
        {note.agent && <Text style={styles.prefix}>{`${note.agent.toUpperCase()}  `}</Text>}
        {note.text}
      </Text>
      {note.comments.length > 0 && (
        <View style={styles.replies}>
          {unread && <View style={styles.dot} />}
          <CommentIcon color={unread ? c.fg : c.fg3} size={ICON} />
          <Text style={[styles.replyCount, unread && styles.replyCountNew]}>
            {note.comments.length}
          </Text>
        </View>
      )}
    </Tap>
  );
}

function AddField({ add, onWriting }: { add: NoteAdd; onWriting: (writing: boolean) => void }) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState("");
  const [height, setHeight] = useState(LINE);
  const writing = text.trim() !== "";
  const pin = add.alwaysPinned || pinned;
  const change = (next: string) => {
    setText(next);
    setError("");
    onWriting(next.trim() !== "");
  };
  const save = () => {
    if (!writing) return;
    try {
      add.onSave(text, pin);
      change("");
      setPinned(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't save the note.");
    }
  };
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.mark}>
          <PlusIcon color={writing ? c.fg : c.fg3} size={ICON} strokeWidth={2} />
        </View>
        <TextInput
          accessibilityLabel={add.label}
          placeholder={add.alwaysPinned ? "Add a pinned note" : "Add a note"}
          placeholderTextColor={c.fg3}
          maxLength={LIMITS.noteLength}
          multiline
          // One line until the text needs more: the web's text area starts two lines tall.
          rows={1}
          onContentSizeChange={({ nativeEvent }) =>
            setHeight(Math.max(LINE, Math.ceil(nativeEvent.contentSize.height)))
          }
          value={text}
          onChangeText={change}
          style={[styles.input, { height }]}
        />
      </View>
      {writing && (
        <View style={styles.actions}>
          {add.pinTo !== null && !add.alwaysPinned && (
            <Tap
              accessibilityRole="switch"
              accessibilityLabel={`Pin to ${add.pinTo}`}
              accessibilityState={{ checked: pinned }}
              onPress={() => setPinned(!pinned)}
              style={[styles.pin, pinned && styles.pinOn]}
            >
              <PinIcon color={pinned ? c.bg : c.fg2} size={12} />
              <Text style={[styles.pinText, pinned && styles.pinTextOn]}>Pin</Text>
            </Tap>
          )}
          <Text style={styles.hint} numberOfLines={2}>
            {pin ? add.pinnedHint : add.unpinnedHint}
          </Text>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Save ${add.label.toLowerCase()}`}
            onPress={save}
            style={styles.save}
          >
            <Text style={styles.saveText}>Save</Text>
          </Tap>
        </View>
      )}
      {error !== "" && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  box: {
    marginHorizontal: 10,
    marginTop: 2,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 3,
    backgroundColor: c.s2,
    borderRadius: 12,
  },
  card: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: c.s1,
    borderRadius: radius.card - 4,
    borderWidth: 1,
    borderColor: c.line,
  },
  // No notes yet: the field alone, where the box's text would start.
  unboxed: { backgroundColor: "transparent", marginTop: -2, marginBottom: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 4 },
  mark: { paddingTop: 3, width: ICON },
  text: { flex: 1, minWidth: 0, ...font.body, fontSize: 14, lineHeight: 19, color: c.fg2 },
  prefix: { ...font.mono, fontSize: 10, letterSpacing: 1, color: c.fg3 },
  replies: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg },
  replyCount: { ...font.mono, fontSize: 11, color: c.fg3 },
  replyCountNew: { color: c.fg },
  input: {
    flex: 1,
    minHeight: 19,
    padding: 0,
    ...font.body,
    fontSize: 14,
    lineHeight: 19,
    color: c.fg,
    outlineStyle: "none",
  } as never,
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingLeft: ICON + 8,
    paddingTop: 2,
    paddingBottom: 4,
  },
  pin: {
    height: 28,
    paddingHorizontal: 9,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: c.line2,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pinOn: { backgroundColor: c.fg, borderColor: c.fg },
  pinText: { ...type.action, color: c.fg2 },
  pinTextOn: { color: c.bg },
  hint: { ...type.meta, fontSize: 10.5, color: c.fg3, flex: 1 },
  save: {
    height: 28,
    paddingHorizontal: 12,
    borderRadius: radius.chip,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  saveText: { ...type.action, color: c.bg },
  error: { ...type.meta, color: c.alert, paddingLeft: ICON + 8, paddingBottom: 4 },
}));
