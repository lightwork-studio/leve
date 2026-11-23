import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { PanResponder, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { type } from "../../theme.ts";
import { DeleteIcon } from "../icons.tsx";
import { easeOut } from "../motion.ts";
import { Tap } from "../tap.tsx";
import { themedStyles, useColors, useStyles } from "../themed.ts";

/** How far an open row slides to show Remove. */
export const SWIPE_OPEN = 100;

/**
 * Whether a drag is a swipe: past 10 pt, and clearly more sideways than up or down. Anything else
 * is a tap (which still opens a value) or a scroll.
 */
export function isSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** Where a row dragged by `dx` from `base` sits: it resists going right, or past open. */
export function swipeOffset(base: number, dx: number): number {
  const x = base + dx;
  if (x > 0) return x * 0.2;
  if (x < -SWIPE_OPEN) return -SWIPE_OPEN + (x + SWIPE_OPEN) * 0.25;
  return x;
}

/**
 * A set row that slides left to show Remove behind it. Letting go past halfway leaves it open;
 * dragging further never removes anything without the tap. The screen keeps one row open at most
 * and closes it on any other tap.
 */
export function SwipeRow({
  open,
  enabled,
  onOpen,
  onRemove,
  children,
}: {
  open: boolean;
  /** Off while the pad or a set's editor is open. */
  enabled: boolean;
  onOpen: (open: boolean) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const reduced = useReducedMotion();
  const x = useSharedValue(open ? -SWIPE_OPEN : 0);
  const state = useRef({ open, enabled, reduced, onOpen });
  state.current = { open, enabled, reduced, onOpen };
  const settle = (to: number) => {
    x.value = state.current.reduced ? to : withTiming(to, { duration: 220, easing: easeOut });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the screen's choice.
  useEffect(() => settle(open ? -SWIPE_OPEN : 0), [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads the latest through state.
  const responder = useMemo(
    () =>
      PanResponder.create({
        // Taken from a value or the check once the drag is a swipe, so the tap is cancelled.
        onMoveShouldSetPanResponderCapture: (_, g) => state.current.enabled && isSwipe(g.dx, g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => {
          x.value = swipeOffset(state.current.open ? -SWIPE_OPEN : 0, g.dx);
        },
        onPanResponderRelease: (_, g) => {
          const next = swipeOffset(state.current.open ? -SWIPE_OPEN : 0, g.dx) < -SWIPE_OPEN / 2;
          settle(next ? -SWIPE_OPEN : 0);
          state.current.onOpen(next);
        },
        onPanResponderTerminate: () => settle(state.current.open ? -SWIPE_OPEN : 0),
      }),
    [x],
  );
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const behind = useAnimatedStyle(() => ({ opacity: x.value < -1 ? 1 : 0 }));
  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[styles.behind, behind]}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? "auto" : "no-hide-descendants"}
        pointerEvents={open ? "auto" : "none"}
      >
        <Tap accessibilityRole="button" onPress={onRemove} scaleTo={0.96} style={styles.remove}>
          <DeleteIcon color={c.dangerInk} size={18} />
          <Text style={styles.removeText}>Remove</Text>
        </Tap>
      </Animated.View>
      <Animated.View {...responder.panHandlers} style={[styles.front, slide]}>
        {children}
      </Animated.View>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  wrap: { borderRadius: 14 },
  behind: { position: "absolute", top: 3, bottom: 3, right: 0, width: 92 },
  remove: {
    flex: 1,
    borderRadius: 13,
    backgroundColor: c.danger,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  removeText: { ...type.labelSmall, fontWeight: "700", color: c.dangerInk },
  // Opaque, so the row covers Remove until it slides.
  front: { backgroundColor: c.s1, borderRadius: 14 },
}));
