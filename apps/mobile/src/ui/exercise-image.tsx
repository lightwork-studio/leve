import {
  Image,
  type ImageSourcePropType,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";

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
