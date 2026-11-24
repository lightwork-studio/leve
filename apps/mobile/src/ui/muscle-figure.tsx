import { memo, useMemo } from "react";
import { type GestureResponderEvent, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { type MuscleAmounts, type MuscleStep, muscleSteps } from "../model/muscle-map.ts";
import { type Palette, type } from "../theme.ts";
import {
  FIGURE_ASPECT,
  FIGURE_VIEWBOX,
  musclePath,
  nearestMuscle,
  SIDES,
  type Side,
  sideMuscles,
  toPathUnits,
} from "./muscle-geometry.ts";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** Figures shorter than this are small: a quieter body, and a finer edge. */
const SMALL = 90;

/** Each step's fill, from untrained to most trained. */
export function stepColor(c: Palette, step: MuscleStep): string {
  return c.muscle.ramp[step];
}

export interface MuscleFigureProps {
  /** How much each muscle was trained; shaded ⌈4 × value ÷ max⌉ (see `muscleStep`). */
  amounts: MuscleAmounts;
  /** The height of each side, in points; the width follows. */
  height: number;
  sides?: readonly Side[];
  /** A muscle to pick out: the others dim, and it gets an outline and lines between its parts. */
  selected?: string | null;
  /**
   * Makes the figure answer taps: a tap picks the muscle under it, or the nearest one within about
   * 20 points. Offer the same choice another way too (a list or chips), for screen readers.
   */
  onSelect?: (muscle: string) => void;
  /** Names each side under it. */
  labels?: boolean;
  /** Space between the sides. */
  gap?: number;
  /** What the figure shows, for screen readers; empty for a decoration that text beside it says. */
  accessibilityLabel: string;
}

/**
 * The body from the front and back, each muscle shaded by how much it was trained. Selection dims
 * the other muscles and rings the chosen one, which keeps its own shade. The ring is drawn under the
 * muscle and fine lines in the body's colour over it, so a muscle drawn in parts (the abs, say)
 * still shows them when its shade is as light as the ring.
 */
export const MuscleFigure = memo(function MuscleFigure({
  amounts,
  height,
  sides = SIDES,
  selected = null,
  onSelect,
  labels = false,
  gap = 6,
  accessibilityLabel,
}: MuscleFigureProps) {
  const styles = useStyles(sheet);
  const steps = useMemo(() => muscleSteps(amounts), [amounts]);
  return (
    <View
      // Without a label it is decoration beside text that says the same.
      accessible={accessibilityLabel !== ""}
      accessibilityRole={accessibilityLabel ? "image" : undefined}
      accessibilityLabel={accessibilityLabel || undefined}
      style={[styles.figure, { gap }]}
    >
      {sides.map((side) => {
        const drawn = (
          <FigureSide
            key={side}
            side={side}
            steps={steps}
            height={height}
            selected={selected}
            onSelect={onSelect}
          />
        );
        return labels ? (
          <View key={side} style={styles.column}>
            {drawn}
            <Text style={styles.label}>{side}</Text>
          </View>
        ) : (
          drawn
        );
      })}
    </View>
  );
});

function FigureSide({
  side,
  steps,
  height,
  selected,
  onSelect,
}: {
  side: Side;
  steps: ReadonlyMap<string, MuscleStep>;
  height: number;
  selected: string | null;
  onSelect: ((muscle: string) => void) | undefined;
}) {
  const c = useColors();
  const width = Math.round(height * FIGURE_ASPECT * 10) / 10;
  // One screen point in path units, for edges that stay the same width at any size.
  const point = FIGURE_VIEWBOX[side][3] / height;
  const small = height < SMALL;
  const body = small ? c.muscle.small : c.muscle.body;
  const neutral = small ? c.muscle.small : c.muscle.neutral;
  const chosen = selected ? musclePath(side, selected) : undefined;
  const pick = (event: GestureResponderEvent) => {
    if (!onSelect) return;
    const { locationX, locationY } = event.nativeEvent;
    const at = toPathUnits(side, height, locationX, locationY);
    const muscle = nearestMuscle(side, at.px, at.py, at.unitsPerPoint);
    if (muscle) onSelect(muscle);
  };
  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height} viewBox={FIGURE_VIEWBOX[side].join(" ")}>
        <Path
          d={musclePath(side, "outline")}
          fill={body}
          stroke={c.muscle.line ?? undefined}
          strokeWidth={c.muscle.line ? point * (small ? 0.75 : 1) : undefined}
        />
        <Path d={musclePath(side, "neutral")} fill={neutral} />
        {sideMuscles(side).map((group) =>
          chosen && group === selected ? null : (
            <Path
              key={group}
              testID={`muscle-${side}-${group}`}
              d={musclePath(side, group)}
              fill={c.muscle.ramp[steps.get(group) ?? 0]}
              opacity={selected ? 0.3 : 1}
            />
          ),
        )}
        {chosen && selected ? (
          <>
            {/* Half the ring is hidden under the muscle, so 3 points show as 1.5 outside it. */}
            <Path
              testID={`muscle-${side}-selected`}
              d={chosen}
              fill="none"
              stroke={c.fg}
              strokeWidth={point * 3}
              strokeLinejoin="round"
            />
            <Path
              testID={`muscle-${side}-${selected}`}
              d={chosen}
              fill={c.muscle.ramp[steps.get(selected) ?? 0]}
              opacity={1}
            />
            <Path
              testID={`muscle-${side}-selected-parts`}
              d={chosen}
              fill="none"
              stroke={body}
              strokeWidth={point * 0.75}
            />
          </>
        ) : null}
      </Svg>
      {onSelect ? (
        // A plain layer over the drawing takes the touch, so the tap's place is measured in it.
        <View
          testID={`muscle-figure-${side}`}
          style={{ position: "absolute", top: 0, left: 0, width, height }}
          onStartShouldSetResponder={() => true}
          onResponderRelease={pick}
        />
      ) : null}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  figure: { flexDirection: "row", alignItems: "flex-end", justifyContent: "center" },
  column: { alignItems: "center", gap: 7 },
  label: { ...type.label, fontSize: 9.5, color: c.fg3 },
}));
