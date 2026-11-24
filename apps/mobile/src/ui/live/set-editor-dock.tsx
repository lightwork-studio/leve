import type { SetType } from "@leve/core";
import { Text, View } from "react-native";
import { type } from "../../theme.ts";
import { setTypeNames } from "../set-type-choices.tsx";
import { Tap } from "../tap.tsx";
import { themedStyles, useStyles } from "../themed.ts";
import { DoneButton, SetMarker } from "./dock.tsx";

/**
 * The dock as one set's editor, opened from the set's number: its type, and Remove set. Picking a
 * type applies it and returns the dock to logging; Done returns without changing anything. Values
 * are changed in the set's row.
 */
export function SetEditorDock({
  chip,
  logged,
  exercise,
  detail,
  value,
  onType,
  effort,
  onRemove,
  onDone,
}: {
  chip: string;
  logged: boolean;
  exercise: string;
  /** "Set 2 · logged · 92.5 × 8" */
  detail: string;
  value: SetType;
  onType: (type: SetType) => void;
  effort?: { label: string; onPress: () => void } | undefined;
  onRemove: () => void;
  onDone: () => void;
}) {
  const styles = useStyles(sheet);
  return (
    <View
      role="group"
      aria-label={`${detail.split(" · ")[0]} of ${exercise}`}
      style={styles.editor}
    >
      <View style={styles.head}>
        <View style={styles.target}>
          <SetMarker label={chip} logged={logged} />
          <View style={styles.text}>
            <Text style={styles.exercise} numberOfLines={1}>
              {exercise}
            </Text>
            <Text style={styles.detail} numberOfLines={1}>
              {detail}
            </Text>
          </View>
        </View>
        <DoneButton label="Done with this set" onPress={onDone} />
      </View>
      <Text style={styles.label}>Set type</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Set type" style={styles.types}>
        {(Object.keys(setTypeNames) as SetType[]).map((kind) => {
          const on = kind === value;
          return (
            <Tap
              key={kind}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => onType(kind)}
              scaleTo={0.97}
              style={[styles.type, on && styles.typeOn]}
            >
              <Text style={[styles.typeText, on && styles.typeTextOn]} numberOfLines={1}>
                {setTypeNames[kind]}
              </Text>
            </Tap>
          );
        })}
      </View>
      {effort && (
        <Tap accessibilityRole="button" onPress={effort.onPress} style={styles.effort}>
          <Text style={styles.effortText}>{effort.label}</Text>
        </Tap>
      )}
      <Tap accessibilityRole="button" onPress={onRemove} scaleTo={0.98} style={styles.remove}>
        <Text style={styles.removeText}>Remove set</Text>
      </Tap>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  editor: { paddingTop: 2 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 4,
    paddingBottom: 10,
  },
  target: { flexDirection: "row", alignItems: "center", gap: 9, flex: 1, minWidth: 0 },
  text: { flex: 1, minWidth: 0, gap: 4 },
  exercise: { ...type.rowTitle, fontSize: 14.5, lineHeight: 17, color: c.fg },
  detail: { ...type.label, color: c.fg3 },
  label: { ...type.label, color: c.fg3, paddingHorizontal: 4, paddingBottom: 8 },
  types: {
    flexDirection: "row",
    // Each type keeps a 44 pt target inside the track.
    height: 50,
    padding: 3,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.s2,
  },
  type: {
    flex: 1,
    minWidth: 0,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  typeOn: { backgroundColor: c.fg },
  typeText: {
    ...type.action,
    fontSize: 11.5,
    letterSpacing: 0.1,
    textTransform: "none",
    color: c.fg3,
  },
  typeTextOn: { color: c.bg },
  effort: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  effortText: { ...type.action, color: c.fg },
  remove: { minHeight: 44, marginTop: 6, alignItems: "center", justifyContent: "center" },
  removeText: { ...type.action, letterSpacing: 1.47, color: c.danger },
}));
