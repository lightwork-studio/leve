import type { ComponentRef, ReactNode, RefObject } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, touch, type } from "../theme.ts";
import { Enter } from "./enter.tsx";
import { ChevronIcon, CloseIcon } from "./icons.tsx";
import { KeyboardAccessory } from "./keyboard-accessory.tsx";
import { useSheetDrag } from "./live/sheet-drag.ts";
import { SheetOutline, sheetBorderWidth, sheetRadius } from "./sheet-outline.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * A sheet rising from the bottom, for anything with several fields or a list: a grabber, a bar
 * with the way out on the left (Cancel, or ✕ when nothing is lost by leaving), the title in the
 * middle and an optional action on the right, then a scrolling body and a footer for the bone
 * confirm. Dragging the bar down, tapping the scrim, Escape and Android's back button all close
 * it. It covers the screen, so nothing behind it can be reached while it is open.
 */
export function BottomSheet({
  title,
  eyebrow,
  close = "cancel",
  closeLabel,
  action,
  footer,
  keyboardAccessory,
  size = "fit",
  onClose,
  children,
  scroll = true,
  scrollRef,
  visible = true,
  onDismiss,
}: {
  title: string;
  /** A small caps line above the title: what the sheet is about. */
  eyebrow?: string;
  /** Cancel for a sheet with something to lose; ✕ for one that only shows or picks. */
  close?: "cancel" | "x";
  /** The text on the close tile, when not "Cancel". */
  closeLabel?: string;
  /** Something on the bar's right, such as a ⊕ tile. */
  action?: ReactNode;
  footer?: ReactNode;
  keyboardAccessory?: ReactNode;
  /** `fit` hugs the content; `large` fills the screen but a strip at the top. */
  size?: "fit" | "large";
  onClose: () => void;
  children: ReactNode;
  /** Off for a body that scrolls on its own (a long list). */
  scroll?: boolean;
  scrollRef?: RefObject<ComponentRef<typeof ScrollView> | null>;
  visible?: boolean;
  onDismiss?: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const drag = useSheetDrag(onClose);
  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      aria-label={title}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.overlay}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <Enter
          distance={48}
          fadeIn={false}
          role="dialog"
          aria-modal
          aria-label={title}
          accessibilityViewIsModal
          style={[styles.sheet, size === "large" && styles.fill, { marginTop: insets.top + 12 }]}
        >
          <Animated.View style={[size === "fit" ? styles.fit : styles.fill, drag.style]}>
            <View {...drag.handlers} style={styles.head}>
              <View style={styles.grabber} />
              <View style={styles.bar}>
                <View style={styles.side}>
                  {close === "cancel" ? (
                    <Tap
                      accessibilityRole="button"
                      accessibilityLabel={closeLabel ?? "Cancel"}
                      onPress={onClose}
                      scaleTo={0.96}
                      style={styles.cancel}
                    >
                      <ChevronIcon direction="left" color={c.fg2} size={18} strokeWidth={2} />
                      <Text style={styles.cancelLabel} numberOfLines={1}>
                        {closeLabel ?? "Cancel"}
                      </Text>
                    </Tap>
                  ) : (
                    <Tap
                      accessibilityRole="button"
                      accessibilityLabel={closeLabel ?? "Close"}
                      onPress={onClose}
                      scaleTo={0.92}
                      style={styles.x}
                    >
                      <CloseIcon color={c.fg2} size={16} />
                    </Tap>
                  )}
                </View>
                <View style={styles.titles}>
                  {eyebrow ? (
                    <Text style={styles.eyebrow} numberOfLines={1}>
                      {eyebrow}
                    </Text>
                  ) : null}
                  <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
                    {title}
                  </Text>
                </View>
                <View style={[styles.side, styles.sideEnd]}>{action}</View>
              </View>
            </View>
            {scroll ? (
              <ScrollView
                ref={scrollRef}
                style={size === "fit" ? styles.fitBody : styles.fill}
                contentContainerStyle={styles.body}
                keyboardShouldPersistTaps="handled"
              >
                {children}
              </ScrollView>
            ) : (
              <View style={styles.fill}>{children}</View>
            )}
            {footer ? (
              <View style={[styles.footer, { paddingBottom: insets.bottom + 22 }]}>{footer}</View>
            ) : (
              <View style={{ height: insets.bottom + 12 }} />
            )}
            <KeyboardAccessory content={keyboardAccessory} />
          </Animated.View>
          <SheetOutline />
        </Enter>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const sheet = themedStyles((c) => ({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: c.scrim },
  sheet: {
    maxHeight: "100%",
    backgroundColor: c.bg,
    borderTopLeftRadius: sheetRadius,
    borderTopRightRadius: sheetRadius,
    paddingTop: sheetBorderWidth,
    overflow: "hidden",
  },
  fill: { flex: 1 },
  // Longhands rather than `flex: 0`: on the web that is CSS's `0 1 0%`, whose zero basis collapsed
  // the sheet's body and left its fields and buttons clipped away under the bar.
  fit: { flexGrow: 0, flexShrink: 1, flexBasis: "auto" },
  fitBody: { flexGrow: 0, flexShrink: 1 },
  head: { paddingTop: 8 },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: c.line2,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 56,
    paddingTop: 6,
    paddingBottom: 4,
    paddingHorizontal: 12,
  },
  side: { flexDirection: "row", alignItems: "center", minWidth: 84, maxWidth: 120 },
  sideEnd: { justifyContent: "flex-end" },
  titles: { flex: 1, minWidth: 0, alignItems: "center", gap: 3 },
  eyebrow: { ...type.label, color: c.fg3 },
  title: { ...type.rowTitle, fontSize: 15, color: c.fg, textAlign: "center" },
  cancel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    height: touch,
    paddingLeft: 7,
    paddingRight: 13,
    borderRadius: radius.input,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    flexShrink: 1,
  },
  cancelLabel: { ...type.action, letterSpacing: 1.26, color: c.fg2, flexShrink: 1 },
  x: {
    width: touch,
    height: touch,
    borderRadius: 12,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { paddingTop: 6, paddingBottom: 10 },
  footer: {
    paddingTop: 10,
    paddingHorizontal: 14,
    gap: 2,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
}));
