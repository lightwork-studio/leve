import { LIMITS } from "@leve/core";
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { addExerciseNote } from "../data/workout-actions.ts";
import type { WithId, WorkoutEntry } from "../model/types.ts";
import { font, radius, space, type } from "../theme.ts";
import { ChevronIcon, NoteIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

export function ExerciseNotes({
  entry,
  expanded,
  editor,
  onInteract,
}: {
  entry: WithId<WorkoutEntry>;
  expanded: boolean;
  editor?: { draft: string | null; setDraft: (value: string | null) => void };
  onInteract?: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { change } = useAppData();
  const [showAll, setShowAll] = useState(false);
  const draft = editor?.draft ?? null;
  const [error, setError] = useState("");
  const saved = useRef(false);
  const notes = entry.content.notes ?? [];
  const name = entry.content.exerciseName;
  const save = () => {
    if (!editor || draft === null || saved.current) return;
    try {
      change(
        (store) => addExerciseNote(store, entry.content.workoutId, entry.id, draft),
        "active-workout",
      );
      saved.current = true;
      editor.setDraft(null);
      setShowAll(true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't save the note.");
    }
  };
  if (!editor && (!expanded || !notes.length)) return null;
  return (
    <View style={styles.panel}>
      {notes.length > 0 && (expanded || editor) && (
        <>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Exercise notes for ${name}, ${notes.length}`}
            accessibilityState={{ expanded: showAll }}
            onPress={() => {
              onInteract?.();
              setShowAll(!showAll);
            }}
            style={styles.summary}
          >
            {/* The note icon stands in for the word, with a count when there are several. */}
            <View style={styles.mark}>
              <NoteIcon color={c.fg3} size={15} />
              {notes.length > 1 && <Text style={styles.count}>{notes.length}</Text>}
            </View>
            <View style={styles.preview}>
              <Text style={styles.peek} numberOfLines={2}>
                {showAll
                  ? `${notes.length} ${notes.length === 1 ? "note" : "notes"}`
                  : notes[0]?.text}
              </Text>
            </View>
            <ChevronIcon direction={showAll ? "down" : "right"} color={c.fg2} size={18} />
          </Tap>
          {showAll &&
            notes.map((note) => (
              <Text key={note.id} style={styles.text}>
                {note.text}
              </Text>
            ))}
        </>
      )}
      {editor && draft !== null ? (
        <>
          <TextInput
            multiline
            accessibilityLabel={`Note for ${name}`}
            placeholder="Exercise note"
            placeholderTextColor={c.fg2}
            maxLength={LIMITS.noteLength}
            autoFocus
            style={styles.input}
            value={draft}
            onChangeText={(value) => {
              editor.setDraft(value);
              setError("");
            }}
          />
          {error !== "" && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <View style={styles.actions}>
            <Tap
              accessibilityRole="button"
              style={styles.action}
              onPress={() => editor.setDraft(null)}
            >
              <Text style={styles.label}>Cancel</Text>
            </Tap>
            <Tap
              accessibilityRole="button"
              style={styles.action}
              disabled={!draft.trim()}
              onPress={save}
            >
              <Text style={styles.label}>Save exercise note</Text>
            </Tap>
          </View>
        </>
      ) : (
        editor && (
          <Tap
            accessibilityRole="button"
            style={styles.action}
            onPress={() => {
              onInteract?.();
              saved.current = false;
              setError("");
              editor.setDraft("");
            }}
          >
            <Text style={styles.label}>Add exercise note</Text>
          </Tap>
        )
      )}
    </View>
  );
}
const sheet = themedStyles((c) => ({
  panel: { gap: space.xs },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 44,
    paddingVertical: 9,
    paddingLeft: space.md,
    paddingRight: space.sm,
    borderRadius: space.md,
    backgroundColor: c.s2,
  },
  mark: { flexDirection: "row", alignItems: "center", gap: 3, alignSelf: "flex-start" },
  count: { ...type.meta, color: c.fg3 },
  preview: { flex: 1, minWidth: 0 },
  peek: { ...font.body, fontSize: 13, lineHeight: 18, color: c.fg2 },
  label: { ...type.action, color: c.fg },
  text: { color: c.fg, ...font.body, fontSize: 15 },
  input: {
    padding: space.sm,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.input,
    minHeight: 60,
    color: c.fg,
    ...font.body,
    textAlignVertical: "top",
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  action: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  error: { color: c.alert, ...font.body },
}));
