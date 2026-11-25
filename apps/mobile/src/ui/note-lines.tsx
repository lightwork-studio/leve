import { LIMITS } from "@leve/core";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import type { NoteKind } from "../data/exercise-notes.ts";
import { hasUnread, isUnread, markSeen, useSeenComments } from "../data/note-seen.ts";
import type { NoteComment } from "../model/types.ts";
import { font, radius, space, type } from "../theme.ts";
import { ActionSheet, useConfirmation } from "./action-sheet.tsx";
import { dayLabel } from "./format.ts";
import { CommentIcon, NoteIcon, PinIcon, PlusIcon } from "./icons.tsx";
import { canKeepMine, type SeenNote, useNoteWrites } from "./note-writes.ts";
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
  createdAt: string;
  /** The workout a workout note belongs to; unused for exercise notes. */
  workoutId?: string | null;
  /** Shown before the text in small caps, such as "Last time"; none for today's notes. */
  label?: string;
  /** The agent that wrote it; null for the lifter. */
  agent: string | null;
  comments: readonly NoteComment[];
  /** What a pin attaches it to, or null when it can't be pinned. */
  pinTo: string | null;
  pinnedHint: string;
  unpinnedHint: string;
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

/** The message to show for something that couldn't be saved. */
function problemText(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * Notes shown where they apply, always open: one slim line each, then a field to write one. The
 * lines sit in a shaded box once there is a note or one is being written; with neither, the field
 * stands alone. A note is changed where it is: tap it to edit, pin or delete it, and open its
 * replies under it to read and answer them.
 */
export function NoteLines({
  kind,
  notes,
  add,
  boxed = "auto",
  variant = "inset",
  onInteract,
}: {
  kind: NoteKind;
  notes: readonly NoteLine[];
  add?: NoteAdd;
  /** "always" keeps the box even with no notes, for a list that is its own card. */
  boxed?: "auto" | "always";
  /** "inset" sits inside a card, like an exercise's; "card" is a card of its own on the screen. */
  variant?: "inset" | "card";
  onInteract?: () => void;
}) {
  const styles = useStyles(sheet);
  const [writing, setWriting] = useState(false);
  // One note is edited at a time.
  const [editing, setEditing] = useState<string | null>(null);
  if (!notes.length && !add) return null;
  const box = boxed === "always" || notes.length > 0 || writing;
  return (
    <View style={variant === "card" ? styles.card : [styles.box, !box && styles.unboxed]}>
      {notes.map((note) => (
        <NoteItem
          key={note.id}
          kind={kind}
          note={note}
          editing={editing === note.id}
          onEdit={(on) => {
            onInteract?.();
            setEditing(on ? note.id : null);
          }}
          onInteract={onInteract}
        />
      ))}
      {add && <AddField add={add} onWriting={setWriting} />}
    </View>
  );
}

/**
 * One note: its line, its replies under it when open, and while it is being edited its text in a
 * field with Pin, Delete and Done under it. An agent's note keeps its text; it can be pinned or
 * deleted.
 */
function NoteItem({
  kind,
  note,
  editing,
  onEdit,
  onInteract,
}: {
  kind: NoteKind;
  note: NoteLine;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onInteract?: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { store } = useAppData();
  const writes = useNoteWrites(kind);
  const seen = useSeenComments();
  const unread = hasUnread(note.comments, seen);
  // Replies open by themselves while one is new, so an answer shows without a tap.
  const [repliesOpen, setRepliesOpen] = useState(unread);
  // A reply that arrives while the note is shown opens them as well.
  useEffect(() => {
    if (unread) setRepliesOpen(true);
  }, [unread]);
  const [text, setText] = useState(note.text);
  const [opened, setOpened] = useState<SeenNote>(note);
  const [error, setError] = useState("");
  const own = note.agent === null;
  const row = store.get(kind, note.id);
  const problem = row?.problem ? row : null;
  // A reply being typed keeps its thread open, even one opened empty to write the first reply.
  const [replying, setReplying] = useState(false);
  // Open with no replies yet only to write the first one.
  const showReplies = repliesOpen && (note.comments.length > 0 || editing || replying);
  // An empty thread opened to write a first reply closes again once editing ends.
  useEffect(() => {
    if (!editing && note.comments.length === 0 && !replying) setRepliesOpen(false);
  }, [editing, note.comments.length, replying]);
  // Replies that were new when they came into view keep their dot while the note is on screen.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!showReplies) return;
    const arrived = note.comments.filter((comment) => isUnread(comment));
    if (arrived.length) {
      setFresh((before) => new Set([...before, ...arrived.map((comment) => comment.id)]));
      markSeen(note.id, note.comments);
    }
  }, [showReplies, note.id, note.comments]);
  const attempt = (write: () => void, after?: () => void) => {
    try {
      write();
      setError("");
      after?.();
    } catch (cause) {
      setError(problemText(cause, "Couldn't save the note."));
    }
  };
  // Text typed into an edit that ended without being saved, kept to offer again.
  const [unsaved, setUnsaved] = useState(false);
  /** Whether the field holds text that differs from the note, beyond spaces at its ends. */
  const typed = () => own && text.trim() !== opened.text;
  const startEditing = () => {
    if (unsaved) {
      // The draft that couldn't be saved comes back, against the note's newest copy.
      setOpened(note);
      setError(
        "This note was changed on another device. Done replaces it with your text; Cancel keeps the new version.",
      );
      setUnsaved(false);
    } else {
      setText(note.text);
      setOpened(note);
      setError("");
    }
    onEdit(true);
  };
  /** Saves typed text, and returns the copy of the note it was saved over. */
  const saveDraft = () => {
    if (!typed()) return opened;
    writes.edit(opened, text);
    // Stored trimmed, so the copy to check later writes against is trimmed too.
    const saved = { ...opened, text: text.trim() };
    setOpened(saved);
    setText(saved.text);
    return saved;
  };
  /** A write refused because the note changed elsewhere: show its latest copy to decide on. */
  const refused = (cause: unknown) => {
    const changed = note.text !== opened.text || note.pinned !== opened.pinned;
    if (changed) {
      // Nothing typed: take the new text, so a later Done can't write the old one back.
      const draft = typed();
      setOpened(note);
      if (!draft) setText(note.text);
      setError(
        draft && text.trim() !== note.text
          ? "This note was changed on another device. Done replaces it with your text; Cancel keeps the new version."
          : "This note was changed on another device. This is the new version.",
      );
    } else setError(problemText(cause, "Couldn't save the note."));
  };
  const done = () => {
    try {
      saveDraft();
      setError("");
      onEdit(false);
    } catch (cause) {
      refused(cause);
    }
  };
  const cancel = () => {
    setText(opened.text);
    setError("");
    setUnsaved(false);
    onEdit(false);
  };
  // Leaving edit mode another way, such as by tapping another note, keeps what was typed.
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing && typed()) {
      try {
        saveDraft();
      } catch (cause) {
        refused(cause);
        // Changed elsewhere and closed with nothing to press: keep the draft for the next tap.
        // Any other refusal, such as an empty note, keeps the message it gave.
        if (note.text !== opened.text || note.pinned !== opened.pinned) {
          setUnsaved(true);
          setError("Your change wasn't saved: this note changed elsewhere. Tap it to choose.");
        }
      }
    }
    wasEditing.current = editing;
  });
  const removal = useConfirmation(() => {
    try {
      writes.remove(opened);
      setError("");
    } catch (cause) {
      refused(cause);
    }
  });
  const count = `${note.comments.length} ${note.comments.length === 1 ? "reply" : "replies"}`;
  const spoken = [
    note.pinned ? "Pinned" : note.label,
    note.agent ? `by ${note.agent}` : null,
    note.text,
    note.comments.length ? count : null,
    unread ? "new reply" : null,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.mark}>
          {note.pinned ? (
            <PinIcon color={c.fg2} size={ICON} />
          ) : (
            <NoteIcon color={c.fg3} size={ICON} />
          )}
        </View>
        {editing && own ? (
          <GrowingInput
            label="Edit note"
            autoFocus
            value={text}
            onChange={(next) => {
              setText(next);
              setError("");
            }}
          />
        ) : (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={spoken}
            accessibilityHint={
              editing
                ? "Closes this note's edit"
                : own
                  ? "Edits this note"
                  : note.pinTo !== null || note.pinned
                    ? "Pins or deletes this note"
                    : "Deletes this note"
            }
            accessibilityState={{ expanded: editing }}
            onPress={() => (editing ? onEdit(false) : startEditing())}
            scaleTo={0.99}
            hitSlop={{ top: 4, bottom: 4 }}
            style={styles.flex}
          >
            <Text style={styles.text} numberOfLines={editing ? undefined : 3}>
              {note.label && !note.pinned && (
                <Text style={styles.prefix}>{`${note.label.toUpperCase()}  `}</Text>
              )}
              {note.agent && <Text style={styles.prefix}>{`${note.agent.toUpperCase()}  `}</Text>}
              {note.text}
            </Text>
          </Tap>
        )}
        {note.comments.length > 0 && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={unread ? `${count}, new` : count}
            accessibilityState={{ expanded: showReplies }}
            onPress={() => {
              onInteract?.();
              setRepliesOpen(!showReplies);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.replies}
          >
            {unread && <View style={styles.dot} accessible accessibilityLabel="New" />}
            <CommentIcon color={unread || showReplies ? c.fg : c.fg3} size={ICON} />
            <Text style={[styles.replyCount, (unread || showReplies) && styles.replyCountNew]}>
              {note.comments.length}
            </Text>
          </Tap>
        )}
      </View>
      {editing && (
        <View style={styles.actions}>
          {(note.pinTo !== null || note.pinned) && (
            <Tap
              accessibilityRole="switch"
              accessibilityLabel={note.pinTo ? `Pin to ${note.pinTo}` : "Pinned"}
              accessibilityState={{ checked: note.pinned }}
              onPress={() => {
                try {
                  const saved = saveDraft();
                  writes.setPinned(saved, !note.pinned);
                  setOpened({ ...saved, pinned: !note.pinned });
                  setError("");
                } catch (cause) {
                  refused(cause);
                }
              }}
              style={[styles.pin, note.pinned && styles.pinOn]}
            >
              <PinIcon color={note.pinned ? c.bg : c.fg2} size={12} />
              <Text style={[styles.pinText, note.pinned && styles.pinTextOn]}>Pin</Text>
            </Tap>
          )}
          {note.comments.length === 0 && !showReplies && (
            <Tap
              accessibilityRole="button"
              accessibilityLabel="Reply to this note"
              onPress={() => setRepliesOpen(true)}
              style={styles.quiet}
            >
              <Text style={styles.quietText}>Reply</Text>
            </Tap>
          )}
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Delete note"
            onPress={removal.ask}
            style={styles.quiet}
          >
            <Text style={styles.quietText}>Delete</Text>
          </Tap>
          <View style={styles.flex} />
          {own && (
            <Tap
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={cancel}
              style={styles.quiet}
            >
              <Text style={styles.quietText}>Cancel</Text>
            </Tap>
          )}
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={done}
            style={styles.save}
          >
            <Text style={styles.saveText}>Done</Text>
          </Tap>
        </View>
      )}
      {editing && (
        <Text style={styles.editHint} numberOfLines={2}>
          {note.pinned ? note.pinnedHint : note.unpinnedHint}
        </Text>
      )}
      {problem && (
        <View style={styles.problem}>
          <Text accessibilityRole="alert" style={styles.problemText}>
            {canKeepMine(problem)
              ? "Didn't sync. Keep this version, or take the one from your other devices."
              : "Changed or deleted on another device. Take that version to settle it."}
          </Text>
          <View style={styles.problemActions}>
            {canKeepMine(problem) && (
              <Tap
                accessibilityRole="button"
                onPress={() => attempt(() => writes.resolve(problem, "keep_mine"))}
                style={styles.quiet}
              >
                <Text style={styles.quietText}>Keep this version</Text>
              </Tap>
            )}
            <Tap
              accessibilityRole="button"
              onPress={() => attempt(() => writes.resolve(problem, "keep_theirs"))}
              style={styles.quiet}
            >
              <Text style={styles.quietText}>Take the other</Text>
            </Tap>
          </View>
        </View>
      )}
      {showReplies && (
        <Replies
          kind={kind}
          note={note}
          unread={(comment) => fresh.has(comment.id) || isUnread(comment, seen)}
          onError={setError}
          onReplying={setReplying}
        />
      )}
      {error !== "" && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {removal.asking && (
        <ActionSheet
          message="This note and its replies will be deleted."
          action="Delete note"
          keep="Keep it"
          busy={removal.busy}
          busyLabel="Deleting…"
          onConfirm={removal.confirm}
          onClose={removal.cancel}
        />
      )}
    </View>
  );
}

/** A note's replies under it, oldest first, then a field to answer. */
function Replies({
  kind,
  note,
  unread,
  onError,
  onReplying,
}: {
  kind: NoteKind;
  note: NoteLine;
  unread: (comment: NoteComment) => boolean;
  onError: (message: string) => void;
  onReplying: (replying: boolean) => void;
}) {
  const styles = useStyles(sheet);
  const writes = useNoteWrites(kind);
  const [text, setText] = useState("");
  const type = (next: string) => {
    setText(next);
    onReplying(next.trim() !== "");
  };
  // Closed with a reply half typed, the thread no longer holds it open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the replies close.
  useEffect(() => () => onReplying(false), []);
  const send = () => {
    try {
      writes.reply(note.id, text);
      type("");
      onError("");
    } catch (cause) {
      onError(problemText(cause, "Couldn't save the reply."));
    }
  };
  return (
    <View style={styles.thread}>
      {note.comments.map((comment) => (
        <View key={comment.id} style={styles.reply}>
          <View style={styles.byline}>
            {unread(comment) && <View style={styles.dot} accessible accessibilityLabel="New" />}
            <Text style={styles.prefix}>{(comment.agent ?? "You").toUpperCase()}</Text>
            <Text style={styles.when}>{dayLabel(comment.createdAt)}</Text>
            {comment.agent === null && (
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Delete your reply"
                onPress={() => {
                  try {
                    writes.deleteReply(comment.id);
                  } catch (cause) {
                    onError(problemText(cause, "Couldn't delete the reply."));
                  }
                }}
                hitSlop={{ top: 8, bottom: 8 }}
              >
                <Text style={styles.when}>Delete</Text>
              </Tap>
            )}
          </View>
          <Text style={styles.replyText}>{comment.text}</Text>
        </View>
      ))}
      <View style={styles.replyField}>
        <GrowingInput
          label={`Reply to ${note.text}`}
          placeholder="Reply"
          value={text}
          onChange={type}
        />
        {text.trim() !== "" && (
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Send reply"
            onPress={send}
            style={styles.save}
          >
            <Text style={styles.saveText}>Send</Text>
          </Tap>
        )}
      </View>
    </View>
  );
}

/** A slim text field that starts one line tall and grows with its text. */
function GrowingInput({
  label,
  placeholder,
  autoFocus = false,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [height, setHeight] = useState(LINE);
  return (
    <TextInput
      accessibilityLabel={label}
      {...(placeholder ? { placeholder, placeholderTextColor: c.fg3 } : {})}
      autoFocus={autoFocus}
      maxLength={LIMITS.noteLength}
      multiline
      // One line until the text needs more: the web's text area starts two lines tall.
      rows={1}
      onContentSizeChange={({ nativeEvent }) =>
        setHeight(Math.max(LINE, Math.ceil(nativeEvent.contentSize.height)))
      }
      value={value}
      onChangeText={onChange}
      style={[styles.input, { height }]}
    />
  );
}

function AddField({ add, onWriting }: { add: NoteAdd; onWriting: (writing: boolean) => void }) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState("");
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
    } catch (cause) {
      setError(problemText(cause, "Couldn't save the note."));
    }
  };
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.mark}>
          <PlusIcon color={writing ? c.fg : c.fg3} size={ICON} strokeWidth={2} />
        </View>
        <GrowingInput
          label={add.label}
          placeholder={add.alwaysPinned ? "Add a pinned note" : "Add a note"}
          value={text}
          onChange={change}
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
  flex: { flex: 1, minWidth: 0 },
  text: { flex: 1, minWidth: 0, ...font.body, fontSize: 14, lineHeight: 19, color: c.fg2 },
  prefix: { ...font.mono, fontSize: 10, letterSpacing: 1, color: c.fg3 },
  replies: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg },
  replyCount: { ...font.mono, fontSize: 11, color: c.fg3 },
  replyCountNew: { color: c.fg },
  input: {
    flex: 1,
    minHeight: LINE,
    padding: 0,
    ...font.body,
    fontSize: 14,
    lineHeight: LINE,
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
  quiet: { height: 28, paddingHorizontal: 6, justifyContent: "center" },
  editHint: { ...type.meta, fontSize: 10.5, color: c.fg3, paddingLeft: ICON + 8, paddingBottom: 4 },
  quietText: { ...type.action, color: c.fg2 },
  error: { ...type.meta, color: c.alert, paddingLeft: ICON + 8, paddingBottom: 4 },
  problem: { paddingLeft: ICON + 8, paddingBottom: 4, gap: 2 },
  problemText: { ...type.meta, color: c.alert },
  problemActions: { flexDirection: "row", gap: space.sm },
  // Replies hang under their note, on a thin rule in line with its text.
  thread: {
    marginLeft: ICON + 8,
    marginBottom: 6,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: c.line2,
    gap: 6,
  },
  reply: { gap: 2, paddingTop: 2 },
  byline: { flexDirection: "row", alignItems: "center", gap: 6 },
  when: { ...type.meta, fontSize: 10.5, color: c.fg3 },
  replyText: { ...font.body, fontSize: 13.5, lineHeight: 18, color: c.fg },
  replyField: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 28 },
}));
