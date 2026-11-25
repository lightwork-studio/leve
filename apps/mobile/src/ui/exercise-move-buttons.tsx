import { type ComponentRef, type RefObject, useLayoutEffect, useRef } from "react";
import {
  type HostInstance,
  Keyboard,
  Platform,
  type ScrollView,
  type StyleProp,
  Text,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { space } from "../theme.ts";
import { moveFocus } from "./focus.ts";
import { revealInList } from "./reveal.ts";
import { Tap } from "./tap.tsx";

export function ExerciseMoveButtons({
  topInset = 0,
  buttonStyle,
  textStyle,
  name,
  index,
  count,
  scroll,
  onMove,
}: {
  topInset?: number;
  buttonStyle: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
  name: string;
  index: number;
  count: number;
  scroll: RefObject<ComponentRef<typeof ScrollView> | null>;
  onMove: (direction: -1 | 1) => boolean | undefined;
}) {
  const up = useRef<HostInstance>(null);
  const down = useRef<HostInstance>(null);
  const pending = useRef<-1 | 1 | null>(null);
  const move = (direction: -1 | 1) => {
    if (Platform.OS !== "web") Keyboard.dismiss();
    pending.current = direction;
    if (onMove(direction) === false) pending.current = null;
  };
  useLayoutEffect(() => {
    const direction = pending.current;
    if (direction === null) return;
    pending.current = null;
    const button =
      index === count - 1 || (index > 0 && direction === -1) ? up.current : down.current;
    if (!button) return;
    if (Platform.OS === "web") {
      const control = button as unknown as HTMLElement;
      const frame = requestAnimationFrame(() => revealInList(control, "nearest"));
      const cancelFocus = moveFocus(button);
      return () => {
        cancelAnimationFrame(frame);
        cancelFocus();
      };
    }
    const viewport = scroll.current;
    if (!viewport) return;
    const content = viewport.getInnerViewRef();
    if (!content) return;
    let current = true;
    button.measureLayout(content, (_x, y) => {
      if (current) viewport.scrollTo({ y: Math.max(0, y - topInset - space.md), animated: false });
    });
    const cancelFocus = moveFocus(button);
    return () => {
      current = false;
      cancelFocus();
    };
  }, [index, count, scroll, topInset]);
  return (
    <>
      {index > 0 && (
        <Tap
          ref={up}
          accessibilityRole="button"
          style={buttonStyle}
          accessibilityLabel={`Move ${name} up from position ${index + 1}`}
          onPress={() => move(-1)}
        >
          <Text style={textStyle}>Move up</Text>
        </Tap>
      )}
      {index < count - 1 && (
        <Tap
          ref={down}
          accessibilityRole="button"
          style={buttonStyle}
          accessibilityLabel={`Move ${name} down from position ${index + 1}`}
          onPress={() => move(1)}
        >
          <Text style={textStyle}>Move down</Text>
        </Tap>
      )}
    </>
  );
}
