import { useMemo, useRef } from "react";
import { PanResponder } from "react-native";
import { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { spring } from "../motion.ts";

/** How far down (points) or how fast (points per millisecond) a drag must go to minimise. */
const CLOSE_DISTANCE = 110;
const CLOSE_SPEED = 0.8;

/**
 * Lets the live workout's header be dragged down to minimise it, like a sheet. The sheet follows
 * the finger (upwards only a little, against resistance), minimises when let go far or fast enough,
 * and springs back otherwise (or when `onClose` returns false, as it can't close yet). Only the
 * header drags, so the set list scrolls freely.
 */
export function useSheetDrag(onClose: () => unknown) {
  const offset = useSharedValue(0);
  const close = useRef(onClose);
  close.current = onClose;
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_, g) => {
          offset.value = g.dy > 0 ? g.dy : Math.max(-16, g.dy / 4);
        },
        onPanResponderRelease: (_, g) => {
          const far = g.dy > CLOSE_DISTANCE || (g.dy > 24 && g.vy > CLOSE_SPEED);
          // It springs back when it isn't let go far enough, or when it can't close yet.
          if (!far || close.current() === false) offset.value = withSpring(0, spring);
        },
        onPanResponderTerminate: () => {
          offset.value = withSpring(0, spring);
        },
      }),
    [offset],
  );
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  return { handlers: responder.panHandlers, style };
}
