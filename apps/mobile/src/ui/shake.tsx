import { type ReactNode, useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";

/** Each swing of the shake, in points, smaller every time: left, right, and settling. */
const SWINGS = [-6, 5, -3, 2, 0] as const;
const SWING_MS = 70;

/**
 * Shakes its content once, sideways, each time `trigger` changes while `active`: the field that
 * refused a save tells you why the button "didn't work". With reduced motion it stays still, and
 * the change of colour and message says it alone. Nothing around it moves.
 */
export function Shake({
  trigger,
  active,
  style,
  children,
}: {
  trigger: unknown;
  active: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const x = useSharedValue(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new trigger shakes it.
  useEffect(() => {
    if (!active || reduced) return;
    x.value = withSequence(...SWINGS.map((to) => withTiming(to, { duration: SWING_MS })));
  }, [trigger]);
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return <Animated.View style={[style, moved]}>{children}</Animated.View>;
}
