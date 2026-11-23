import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LayoutChangeEvent, StyleProp, ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { easeOut } from "./motion.ts";

/** How long the highlight takes to slide to a newly picked row. */
export const SLIDE_MS = 220;
/** How long a pick stays on screen, landed, before its menu or sheet closes. */
export const PICK_HOLD_MS = 180;

/** Where a row sits in its list. */
interface Frame {
  y: number;
  height: number;
}

/**
 * The rows' places in a list, for a highlight that slides between them. `onLayout(i)` goes on row
 * `i`; `frames[i]` is its place once it has been laid out.
 */
export function useRowFrames(): {
  frames: (Frame | undefined)[];
  onLayout: (index: number) => (event: LayoutChangeEvent) => void;
} {
  const [frames, setFrames] = useState<(Frame | undefined)[]>([]);
  const handlers = useRef(new Map<number, (event: LayoutChangeEvent) => void>());
  const onLayout = (index: number) => {
    let handler = handlers.current.get(index);
    if (!handler) {
      handler = (event: LayoutChangeEvent) => {
        const { y, height } = event.nativeEvent.layout;
        setFrames((now) => {
          const was = now[index];
          if (was && was.y === y && was.height === height) return now;
          const next = [...now];
          next[index] = { y, height };
          return next;
        });
      };
      handlers.current.set(index, handler);
    }
    return handler;
  };
  return { frames, onLayout };
}

/**
 * One highlight behind a list's selected row that slides to a newly selected row instead of
 * jumping, carrying its mark (a check) along, which pops as it lands. It is placed without moving
 * the first time, and draws nothing until its row has been laid out (rows should show their own
 * selected background until then: see `placed`). Reduced motion moves it at once.
 */
export function SlidingHighlight({
  frame,
  style,
  children,
  onPlaced,
}: {
  frame: Frame | undefined;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** Called once it is in place, so rows can stop drawing their own selected background. */
  onPlaced?: () => void;
}) {
  const y = useSharedValue(0);
  const height = useSharedValue(0);
  const mark = useSharedValue(1);
  const [placed, setPlaced] = useState(false);
  const last = useRef<Frame | undefined>(undefined);
  useEffect(() => {
    if (!frame) return;
    const was = last.current;
    last.current = frame;
    if (!was) {
      y.value = frame.y;
      height.value = frame.height;
      setPlaced(true);
      onPlaced?.();
      return;
    }
    if (was.y === frame.y && was.height === frame.height) return;
    const moved = was.y !== frame.y;
    y.value = withTiming(frame.y, { duration: SLIDE_MS, easing: easeOut });
    height.value = withTiming(frame.height, { duration: SLIDE_MS, easing: easeOut });
    // The mark shrinks as it leaves and pops back up as it lands on the new row.
    if (moved) {
      mark.value = withSequence(
        withTiming(0.55, { duration: SLIDE_MS / 2, easing: easeOut }),
        withSpring(1, { damping: 12, stiffness: 320, mass: 0.6 }),
      );
    }
  }, [frame, y, height, mark, onPlaced]);
  const box = useAnimatedStyle(() => ({
    height: height.value,
    transform: [{ translateY: y.value }],
  }));
  const pop = useAnimatedStyle(() => ({ transform: [{ scale: mark.value }] }));
  if (!placed) return null;
  return (
    <Animated.View pointerEvents="none" style={[highlightBase, style, box]}>
      {children !== undefined && <Animated.View style={pop}>{children}</Animated.View>}
    </Animated.View>
  );
}

const highlightBase: ViewStyle = { position: "absolute", top: 0, left: 0, right: 0 };
