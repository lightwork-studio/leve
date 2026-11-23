import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { spring } from "./motion.ts";
import { useColors } from "./themed.ts";

const KNOB_TRAVEL = 24;

/**
 * The app's one switch, drawn the same everywhere: an ink track with a knob the colour of the
 * ground when on, a dim track with a grey knob when off, and a knob that springs across. It is
 * only the look; the row around it takes the tap and carries the switch role and state.
 */
export function Toggle({ on }: { on: boolean }) {
  // The colours it moves between, taken from the palette on screen (and so changing with it).
  const { s3, fg, fg2, bg } = useColors();
  const progress = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(on ? 1 : 0, spring);
  }, [on, progress]);
  const track = useAnimatedStyle(
    () => ({ backgroundColor: interpolateColor(progress.value, [0, 1], [s3, fg]) }),
    [s3, fg],
  );
  const knob = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(progress.value, [0, 1], [fg2, bg]),
      transform: [{ translateX: progress.value * KNOB_TRAVEL }],
    }),
    [fg2, bg],
  );
  return (
    <Animated.View style={[styles.track, track]}>
      <Animated.View style={[styles.knob, knob]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  track: { width: 56, height: 32, borderRadius: 16, padding: 3, justifyContent: "center" },
  knob: { width: 26, height: 26, borderRadius: 13 },
});
