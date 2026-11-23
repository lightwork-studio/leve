import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { easeOut } from "./motion.ts";
import { useColors } from "./themed.ts";

/**
 * A row's background lit for a moment and then fading, to pick out what just arrived (the
 * workout just saved, say). With reduced motion it isn't drawn: nothing moves to draw the eye.
 */
export function Flash() {
  const c = useColors();
  const reduced = useReducedMotion();
  const shown = useSharedValue(reduced ? 0 : 1);
  useEffect(() => {
    if (reduced) return;
    shown.value = withDelay(700, withTiming(0, { duration: 1300, easing: easeOut }));
  }, [reduced, shown]);
  const style = useAnimatedStyle(() => ({ opacity: shown.value }));
  if (reduced) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: c.s3 }, style]}
    />
  );
}
