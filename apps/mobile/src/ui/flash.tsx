import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { mix } from "../theme.ts";
import { easeOut } from "./motion.ts";
import { useColors } from "./themed.ts";

const flashIn = 160;
const flashHold = 1200;
const flashOut = 1000;
/** How long a flash lasts: lit quickly, held, then faded. Whoever shows one takes it away after. */
export const flashDuration = flashIn + flashHold + flashOut;

/**
 * A row's background lit for a moment and then fading, to pick out what just arrived (the
 * workout just saved, say). It is ink mixed into the card, so it reads clearly on graphite and on
 * paper. With reduced motion it is simply shown, without fading in or out, until it is taken away.
 */
export function Flash() {
  const c = useColors();
  const reduced = useReducedMotion();
  const shown = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return;
    shown.value = withSequence(
      withTiming(1, { duration: flashIn, easing: easeOut }),
      withDelay(flashHold, withTiming(0, { duration: flashOut, easing: easeOut })),
    );
  }, [reduced, shown]);
  const style = useAnimatedStyle(() => ({ opacity: shown.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: mix(c.fg, c.s1, 0.14) }, style]}
    />
  );
}
