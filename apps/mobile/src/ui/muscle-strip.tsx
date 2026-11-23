import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { choiceLabel } from "../data/custom-exercises.ts";
import {
  type MuscleAmounts,
  muscleStep,
  rankedMuscles,
  STRIP_CAP,
  stripNames,
} from "../model/muscle-map.ts";
import { type } from "../theme.ts";
import { MuscleFigure } from "./muscle-figure.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** A muscle amount as a short number: whole sets plainly, a half credit with its decimal. */
export function amountLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A screen reader's list of every muscle with its sets. */
export function spokenMuscles(rows: readonly [string, number][]): string {
  return rows
    .map(
      ([group, value]) =>
        `${choiceLabel(group)} ${amountLabel(value)} ${value === 1 ? "set" : "sets"}`,
    )
    .join(", ");
}

/**
 * A small figure beside the muscles a workout worked, most first. Past four muscles it names the
 * top three and how many more; with `expandable`, that count opens the whole list. It draws a
 * hairline above itself, to sit under readouts in the same card. Nothing shows without sets.
 */
export function MuscleStrip({
  amounts,
  label = "Muscles · sets",
  height = 60,
  expandable = false,
}: {
  amounts: MuscleAmounts;
  label?: string;
  height?: number;
  expandable?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => rankedMuscles(amounts), [amounts]);
  if (!rows.length) return null;
  const max = rows[0]?.[1] ?? 0;
  const { shown, more } = stripNames(rows, expandable && open);
  return (
    <View style={styles.strip}>
      <MuscleFigure
        amounts={amounts}
        height={height}
        gap={3}
        accessibilityLabel={`Muscles worked: ${spokenMuscles(rows)}`}
      />
      <View style={styles.text}>
        <Text style={styles.label}>
          {label}
          {rows.length > STRIP_CAP ? ` · ${rows.length}` : ""}
        </Text>
        <View style={styles.names}>
          {shown.map(([group, value]) => (
            <View
              key={group}
              style={styles.name}
              accessible
              accessibilityLabel={`${choiceLabel(group)} ${amountLabel(value)} ${value === 1 ? "set" : "sets"}`}
            >
              <View
                style={[styles.swatch, { backgroundColor: c.muscle.ramp[muscleStep(value, max)] }]}
              />
              <Text style={styles.nameText}>
                {choiceLabel(group)} <Text style={styles.value}>{amountLabel(value)}</Text>
              </Text>
            </View>
          ))}
          {more > 0 && !expandable ? <Text style={styles.nameText}>+{more} more</Text> : null}
          {expandable && rows.length > STRIP_CAP ? (
            <Tap
              accessibilityRole="button"
              accessibilityLabel={open ? "Show fewer muscles" : `Show ${more} more muscles`}
              accessibilityState={{ expanded: open }}
              onPress={() => setOpen(!open)}
              hitSlop={{ top: 11, bottom: 11, left: 4, right: 4 }}
              style={styles.more}
            >
              <Text style={styles.moreText}>{open ? "Fewer" : `+${more} more`}</Text>
            </Tap>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  text: { flex: 1, minWidth: 0, gap: 7 },
  label: { ...type.label, color: c.fg3 },
  names: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 5 },
  name: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  nameText: { ...type.value, color: c.fg2 },
  value: { color: c.fg },
  more: {
    height: 22,
    paddingHorizontal: 8,
    marginVertical: -2,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: c.line2,
    justifyContent: "center",
  },
  moreText: { ...type.value, fontSize: 11, color: c.fg },
}));
