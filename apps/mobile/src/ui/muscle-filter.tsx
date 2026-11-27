import { memo, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { choiceLabel } from "../data/custom-exercises.ts";
import { type MuscleTargets, targetAmounts } from "../model/muscle-map.ts";
import { radius, type } from "../theme.ts";
import { ExerciseThumb } from "./exercise-image.tsx";
import { MuscleFigure } from "./muscle-figure.tsx";
import { FIGURE_MUSCLES, sideOf } from "./muscle-geometry.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

/**
 * Filtering exercises by muscle: tap a muscle on the figure (a tap snaps to the nearest one), or
 * choose its name from the chips below, which screen readers use. Every muscle is shown while none
 * is chosen; tapping the chosen muscle again, or Clear, goes back to that.
 */
export function MuscleFilter({
  groups,
  muscle,
  onSelect,
  counts,
}: {
  /** The muscles that can be chosen. */
  groups: readonly string[];
  muscle: string;
  onSelect: (muscle: string) => void;
  /** With a muscle chosen, how many exercises target it and how many also work it; else the total. */
  counts: { primary: number; also: number } | { total: number };
}) {
  const styles = useStyles(sheet);
  const amounts = useMemo(() => (muscle ? { [muscle]: 1 } : {}), [muscle]);
  const toggle = (group: string) => onSelect(group === muscle ? "" : group);
  const name = muscle ? choiceLabel(muscle) : "All muscles";
  const onFigure = FIGURE_MUSCLES.filter((g) => groups.includes(g)).length;
  return (
    <View>
      <View style={styles.card}>
        <MuscleFigure
          amounts={amounts}
          height={168}
          gap={8}
          selected={muscle && FIGURE_MUSCLES.includes(muscle) ? muscle : null}
          onSelect={(group) => {
            if (groups.includes(group)) toggle(group);
          }}
          accessibilityLabel={`Filter by muscle group, ${name}`}
        />
        <View style={styles.text}>
          <View>
            <Text style={styles.label}>{muscle ? "Filtered by" : "Filter by muscle"}</Text>
            {muscle ? (
              <Text style={styles.name}>{name}</Text>
            ) : (
              <Text style={styles.placeholder}>Tap a muscle on either side</Text>
            )}
          </View>
          <Text style={styles.counts}>
            {"total" in counts
              ? `${counts.total} ${counts.total === 1 ? "exercise" : "exercises"}\n${onFigure} muscles`
              : `${counts.primary} ${counts.primary === 1 ? "targets" : "target"} it\n${counts.also} also ${counts.also === 1 ? "works" : "work"} it`}
          </Text>
          {muscle ? (
            <Tap
              accessibilityRole="button"
              accessibilityLabel="Clear muscle filter"
              onPress={() => onSelect("")}
              hitSlop={{ top: 6, bottom: 6 }}
              style={styles.clear}
            >
              <Text style={styles.clearText}>Clear</Text>
            </Tap>
          ) : null}
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        accessibilityRole="radiogroup"
        accessibilityLabel="Muscle groups"
        contentContainerStyle={styles.chips}
      >
        {groups.map((group) => {
          const on = muscle === group;
          return (
            <Tap
              key={group}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => toggle(group)}
              scaleTo={0.95}
              hitSlop={{ top: 5, bottom: 5 }}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{choiceLabel(group)}</Text>
            </Tap>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * A row's picture of an exercise: its image when it has one, else a small figure of the side that
 * shows its main muscle, with its muscles shaded.
 */
export const MusclePreview = memo(function MusclePreview({
  exerciseId,
  targets,
}: {
  exerciseId: string;
  targets: MuscleTargets | undefined;
}) {
  const amounts = useMemo(() => targetAmounts(targets), [targets]);
  return (
    <ExerciseThumb
      exerciseId={exerciseId}
      fallback={
        <MuscleFigure
          amounts={amounts}
          height={42}
          sides={[sideOf(targets?.primaryMuscles[0])]}
          accessibilityLabel=""
        />
      }
    />
  );
});

const sheet = themedStyles((c) => ({
  card: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 12,
    paddingTop: 14,
    paddingRight: 14,
    paddingBottom: 12,
    paddingLeft: 10,
  },
  text: { flex: 1, minWidth: 0, justifyContent: "space-between", gap: 10, paddingVertical: 2 },
  label: { ...type.label, color: c.fg3 },
  name: { ...type.heading, fontSize: 22, lineHeight: 24, color: c.fg, marginTop: 8 },
  placeholder: { ...type.body, fontSize: 16, lineHeight: 22, color: c.fg3, marginTop: 8 },
  counts: { ...type.meta, lineHeight: 17, color: c.fg2 },
  clear: {
    alignSelf: "flex-start",
    minHeight: 32,
    paddingHorizontal: 11,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: c.line2,
    justifyContent: "center",
  },
  clearText: { ...type.action, fontSize: 10, color: c.fg2 },
  chips: { gap: 6, paddingHorizontal: 14, paddingBottom: 14 },
  chip: {
    height: 34,
    paddingHorizontal: 11,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.line2,
    justifyContent: "center",
  },
  chipOn: { backgroundColor: c.fg, borderColor: c.fg },
  chipText: { ...type.action, fontSize: 9.5, letterSpacing: 0.95, color: c.fg2 },
  chipTextOn: { color: c.bg },
}));
