import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { easeOut } from "./motion.ts";

/**
 * The old content fades out quickly while the new one starts coming in halfway through, so the two
 * overlap for a moment and the space is never empty.
 */
const OUT = 120;
const IN = 160;
const IN_DELAY = 60;
/** How far the new content rises into place. */
const RISE = 4;

/**
 * Content that cross-fades when `id` changes, such as a chart's axis labels when its scale does:
 * what was there fades out where it was while the new content fades in, rising a few points. The
 * new content takes the space; the old is laid over it in the same box. Reduced motion swaps them
 * at once.
 */
export function CrossFade({
  id,
  children,
  style,
}: {
  id: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  // What was last shown for each id, so the old content leaves as it was last seen.
  const committed = useRef({ id, children });
  const [layers, setLayers] = useState<{ id: string; previous: ReactNode; turn: number }>({
    id,
    previous: null,
    turn: 0,
  });
  if (layers.id !== id) {
    // A change during rendering: both layers show from the same commit.
    setLayers({ id, previous: committed.current.children, turn: layers.turn + 1 });
  }
  useLayoutEffect(() => {
    committed.current = { id, children };
  });

  const incoming = useSharedValue(1);
  const outgoing = useSharedValue(0);
  // Before paint, so the first frame of a change shows the old layer, not the plain swap.
  useLayoutEffect(() => {
    if (layers.turn === 0) return;
    incoming.value = 0;
    incoming.value = withDelay(IN_DELAY, withTiming(1, { duration: IN, easing: easeOut }));
    outgoing.value = 1;
    outgoing.value = withTiming(0, { duration: OUT, easing: easeOut });
    // The old layer goes once it is invisible, so nothing stays behind.
    const timer = setTimeout(
      () => setLayers((now) => (now.turn === layers.turn ? { ...now, previous: null } : now)),
      Math.max(OUT, IN + IN_DELAY),
    );
    return () => clearTimeout(timer);
  }, [layers.turn, incoming, outgoing]);
  const inStyle = useAnimatedStyle(() => ({
    opacity: incoming.value,
    transform: [{ translateY: (1 - incoming.value) * RISE }],
  }));
  const outStyle = useAnimatedStyle(() => ({ opacity: outgoing.value }));

  return (
    <View style={style}>
      <Animated.View style={[styles.fill, inStyle]}>{children}</Animated.View>
      {layers.previous !== null && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, outStyle]}>
          {layers.previous}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flexGrow: 1 } });
