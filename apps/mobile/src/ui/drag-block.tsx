import { type ReactNode, useRef, useState } from "react";
import { PanResponder, Platform, View } from "react-native";
import { haptic } from "./haptics.ts";
import { GripIcon } from "./icons.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** How far a held grip moves before it counts as a drag rather than a touch. */
const DRAG_SLOP = 8;

/**
 * A block of rows that follows the finger while one of its grips is held. It reports how far it
 * has been dragged; the list around it decides where that lands and moves the other rows aside.
 */
export function DragBlock({
  lifted,
  offset,
  onGrab,
  onMove,
  onEnd,
  children,
}: {
  lifted: boolean;
  offset: number;
  onGrab: () => void;
  onMove: (dy: number) => void;
  /** The distance dragged when it is let go, or undefined when it never moved or was cancelled. */
  onEnd: (dy?: number) => void;
  children: (grip: (label: string) => ReactNode) => ReactNode;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  // The latest callbacks, for the gesture made once.
  const handlers = useRef({ onGrab, onMove, onEnd });
  handlers.current = { onGrab, onMove, onEnd };
  const [pan] = useState(() => {
    let dragging = false;
    const end = (dy?: number) => {
      const distance = dragging ? dy : undefined;
      dragging = false;
      handlers.current.onEnd(distance);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      // Start fires once the grip has acquired the responder, even on a scrolling page.
      onPanResponderStart: () => {
        // On web the grip's touch action handles the swipe and keeps the scrollbar in place.
        if (Platform.OS !== "web") handlers.current.onGrab();
      },
      onPanResponderMove: (_, { dx, dy }) => {
        if (!dragging) {
          if (Math.abs(dy) < DRAG_SLOP || Math.abs(dy) <= Math.abs(dx)) return;
          dragging = true;
          haptic.tap();
        }
        handlers.current.onMove(dy);
      },
      onPanResponderRelease: (_, { dy }) => end(dy),
      onPanResponderTerminate: () => end(),
    });
  });
  return (
    <View
      style={[lifted && styles.lifted, offset !== 0 && { transform: [{ translateY: offset }] }]}
    >
      {children((label) => (
        <View
          {...pan.panHandlers}
          accessibilityLabel={label}
          importantForAccessibility="no"
          accessibilityElementsHidden
          style={styles.grip}
        >
          <GripIcon color={c.fg3} size={20} />
        </View>
      ))}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  lifted: {
    zIndex: 3,
    backgroundColor: c.s2,
    borderRadius: 16,
    boxShadow: c.shadow,
  },
  grip: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    // The browser decides whether to scroll before React can update the ScrollView.
    ...(Platform.OS === "web" && { touchAction: "none" }),
  },
}));
