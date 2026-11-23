import { type ComponentRef, type RefObject, useEffect } from "react";
import { Text, View } from "react-native";
import { gutter, type } from "../../theme.ts";
import { Enter } from "../enter.tsx";
import { focusMovedByApp, moveFocus } from "../focus.ts";
import { Tap } from "../tap.tsx";
import { themedStyles, useStyles } from "../themed.ts";

/**
 * Says something was just removed, with Undo, floating just above the dock. Screen readers move
 * to Undo as it shows. The screen decides how long it stays, and hears when the person has moved
 * keyboard focus to Undo (so it can wait while it has); the focus Undo is given as it shows doesn't
 * count.
 */
export function UndoToast({
  message,
  onUndo,
  undoRef,
  onFocusChange,
}: {
  message: string;
  onUndo: () => void;
  undoRef: RefObject<ComponentRef<typeof View> | null>;
  onFocusChange?: (focused: boolean) => void;
}) {
  const styles = useStyles(sheet);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves once, as it shows.
  useEffect(() => moveFocus(undoRef.current), [message]);
  return (
    <Enter leaves style={styles.toast} pointerEvents="box-none">
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        aria-live="polite"
        style={styles.card}
      >
        <Text style={styles.message} numberOfLines={1}>
          {message}
        </Text>
        <Tap
          ref={undoRef}
          accessibilityRole="button"
          accessibilityLabel={`Undo: ${message}`}
          onPress={onUndo}
          onFocus={() => {
            if (!focusMovedByApp()) onFocusChange?.(true);
          }}
          onBlur={() => onFocusChange?.(false)}
          style={styles.undo}
        >
          <Text style={styles.undoText}>Undo</Text>
        </Tap>
      </View>
    </Enter>
  );
}

const sheet = themedStyles((c) => ({
  toast: { position: "absolute", left: gutter.group, right: gutter.group, bottom: "100%" },
  card: {
    marginBottom: 10,
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line2,
    boxShadow: c.shadow,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingLeft: 16,
    paddingRight: 6,
  },
  message: { ...type.body, fontSize: 13, color: c.fg, flexShrink: 1 },
  undo: {
    minHeight: 44,
    paddingHorizontal: 15,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  undoText: { ...type.action, fontWeight: "700", letterSpacing: 1.47, color: c.fg },
}));
