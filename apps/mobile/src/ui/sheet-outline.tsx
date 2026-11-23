import { StyleSheet, View } from "react-native";
import { useColors } from "./themed.ts";

export const sheetBorderWidth = 1;
export const sheetRadius = 28;

/** Draw one continuous stroke around the top of a sheet, with its bottom edge clipped away. */
export function SheetOutline({
  radius = sheetRadius,
  sides = false,
}: {
  radius?: number;
  sides?: boolean;
}) {
  const c = useColors();
  return (
    <View pointerEvents="none" style={[styles.clip, sides ? styles.sides : { height: radius }]}>
      <View
        style={[styles.stroke, { bottom: -radius, borderRadius: radius, borderColor: c.line2 }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden" },
  sides: { bottom: 0 },
  // A uniform rounded border avoids the gaps iOS can draw with per-edge border widths.
  stroke: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    borderWidth: sheetBorderWidth,
    overflow: "hidden",
  },
});
