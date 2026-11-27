import type { ReactNode } from "react";
import {
  Image,
  type ImageSourcePropType,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { exerciseThumb } from "../data/exercise-images.ts";
import { CheckIcon } from "./icons.tsx";
import { themedStyles, useAppearance, useStyles } from "./themed.ts";

/**
 * The ground the exercise images are rendered on (media/exercises), so a plate of any shape
 * carries the image on past its edges. The images have no dark version yet, so the plate is
 * the same in both appearances.
 */
export const PLATE = "#F4F0E7";

/**
 * The images' primary and secondary muscle colours as they look under the studio lighting, for
 * a key that names what an image highlights. They belong to the images, not to the palette.
 */
export const PLATE_PRIMARY = "#CF5130";
export const PLATE_SECONDARY = "#E8A585";

/**
 * An exercise image on its own ground, filling the width it is given. The square image is drawn
 * `zoom` times the plate's height and centred, so a zoom above 1 crops into the empty margin
 * around the figure.
 */
export function ExercisePlate({
  source,
  height,
  radius,
  zoom = 1,
  label,
  style,
}: {
  source: ImageSourcePropType;
  height: number;
  radius: number;
  zoom?: number;
  /** What a screen reader says for the image. */
  label: string;
  style?: StyleProp<ViewStyle>;
}) {
  const side = Math.round(height * zoom);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[
        {
          height,
          borderRadius: radius,
          backgroundColor: PLATE,
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Image source={source} resizeMode="contain" style={{ width: side, height: side }} />
    </View>
  );
}

/** The thumbnail's corners, at every size. */
const THUMB_RADIUS = 12;

/**
 * An exercise's small square picture for lists and cards: its image framed on the whole person,
 * or `fallback` for an exercise without one, in a tile of the same size so the names beside
 * them line up. A finished exercise is shown dimmed under a check. It is decoration: the row it
 * sits in names the exercise.
 */
export function ExerciseThumb({
  exerciseId,
  size = 48,
  done = false,
  fallback,
}: {
  exerciseId: string;
  size?: number;
  done?: boolean;
  /** What fills the tile when the exercise has no image. */
  fallback: ReactNode;
}) {
  const styles = useStyles(sheet);
  const paper = useAppearance() === "paper";
  const source = exerciseThumb(exerciseId);
  return (
    <View
      style={[styles.thumb, { width: size, height: size }, source ? styles.plate : styles.tile]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {source ? <Image source={source} style={styles.fill} /> : fallback}
      {/* On paper the plate is almost the card's colour, so a hairline keeps its edge. */}
      {source && paper && <View style={styles.edge} />}
      {done && (
        <View style={styles.done}>
          <CheckIcon size={Math.round(size * 0.42)} color={DONE_INK} strokeWidth={2.6} />
        </View>
      )}
    </View>
  );
}

/** Over the image in either appearance, so it is the same pair in both. */
const DONE_SHADE = "rgba(16, 18, 23, 0.58)";
const DONE_INK = "#F3F1EC";

const sheet = themedStyles((c) => ({
  thumb: {
    borderRadius: THUMB_RADIUS,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  plate: { backgroundColor: PLATE },
  tile: { backgroundColor: c.s2, borderWidth: 1, borderColor: c.line },
  fill: { width: "100%", height: "100%" },
  edge: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: THUMB_RADIUS,
    borderWidth: 1,
    borderColor: c.line,
  },
  done: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: DONE_SHADE,
    alignItems: "center",
    justifyContent: "center",
  },
}));
