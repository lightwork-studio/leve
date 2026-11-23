import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

/** A bar's filled part, growing or shrinking to `fraction` (0 to 1) instead of jumping there. */
export function Fill({ fraction, style }: { fraction: number; style?: StyleProp<ViewStyle> }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const width = useSharedValue(clamped);
  useEffect(() => {
    width.value = withTiming(clamped, { duration: 360, easing: Easing.out(Easing.cubic) });
  }, [clamped, width]);
  const animated = useAnimatedStyle(() => ({ width: `${width.value * 100}%` }));
  return <Animated.View style={[style, animated]} />;
}
