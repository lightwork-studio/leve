import type { ComponentProps } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { emphasised, pressScale, spring } from "./motion.ts";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type TapProps = Omit<ComponentProps<typeof Pressable>, "style"> & {
  style?: StyleProp<ViewStyle>;
  /** How far it shrinks while held; 1 keeps it still. */
  scaleTo?: number;
};

/**
 * A Pressable that gives way under the finger: it shrinks a little at once while held, then springs
 * back. Use it for anything tappable, so every control answers a touch the same way. It doesn't dim:
 * on filled buttons that only muddies the colour.
 */
export function Tap({ style, scaleTo = pressScale, onPressIn, onPressOut, ...props }: TapProps) {
  const held = useSharedValue(0);
  const pressed = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - held.value * (1 - scaleTo) }],
  }));
  return (
    <AnimatedPressable
      aria-checked={props.accessibilityState?.checked}
      aria-expanded={props.accessibilityState?.expanded}
      {...props}
      onPressIn={(event) => {
        held.value = withTiming(1, { duration: 80, easing: emphasised });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        held.value = withSpring(0, spring);
        onPressOut?.(event);
      }}
      style={[style, pressed]}
    />
  );
}
