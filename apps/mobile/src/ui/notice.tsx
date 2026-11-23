import { useEffect, useState } from "react";
import { type StyleProp, Text, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, touch, type } from "../theme.ts";
import { Enter } from "./enter.tsx";
import { announce } from "./focus.ts";
import { CheckIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * A problem that stays until it is fixed or dismissed (changes can't be saved, a setting was
 * refused): a card with a red rule down its side, a small caps label and plain text, and OK when it
 * can be dismissed.
 */
export function Banner({
  label,
  message,
  onDismiss,
  style,
}: {
  label: string;
  message: string;
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(sheet);
  return (
    <View accessibilityRole="alert" style={[styles.banner, style]}>
      <View style={styles.rule} />
      <View style={styles.bannerText}>
        <Text style={styles.bannerLabel}>{label}</Text>
        <Text style={styles.bannerMessage}>{message}</Text>
      </View>
      {onDismiss ? (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="OK"
          accessibilityHint="Dismisses this message"
          onPress={onDismiss}
          scaleTo={0.94}
          hitSlop={4}
          style={styles.ok}
        >
          <Text style={styles.okLabel}>OK</Text>
        </Tap>
      ) : null}
    </View>
  );
}

/** How long a toast stays, in milliseconds. */
export const TOAST_MS = 2400;

type ToastMessage = { id: number; text: string };
let next = 0;
let current: ToastMessage | null = null;
const listeners = new Set<(toast: ToastMessage | null) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Confirms that something happened with a short message at the top of the screen, which goes by
 * itself. The newest message replaces one still showing.
 */
export function showToast(text: string) {
  current = { id: ++next, text };
  for (const listener of listeners) listener(current);
  announce(text);
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    for (const listener of listeners) listener(null);
  }, TOAST_MS);
}

/** Where toasts appear: once, near the root of the app. */
export function ToastHost() {
  const styles = useStyles(sheet);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastMessage | null>(current);
  useEffect(() => {
    listeners.add(setToast);
    return () => {
      listeners.delete(setToast);
    };
  }, []);
  if (!toast) return null;
  return (
    <View pointerEvents="none" style={[styles.toastDock, { top: insets.top + 8 }]}>
      <Enter key={toast.id} distance={-20} leaves>
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.toast}>
          <CheckIcon color={c.bg} size={16} strokeWidth={2.4} />
          <Text style={styles.toastText} numberOfLines={1}>
            {toast.text}
          </Text>
        </View>
      </Enter>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: 18,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    boxShadow: c.shadow,
    overflow: "hidden",
  },
  rule: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: c.alert },
  bannerText: { flex: 1, minWidth: 0, gap: 4 },
  bannerLabel: { ...type.label, color: c.alert },
  bannerMessage: { ...type.body, fontSize: 13.5, lineHeight: 19.5, color: c.fg },
  ok: {
    minWidth: touch,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  okLabel: { ...type.action, fontSize: 10, letterSpacing: 1.4, color: c.fg },
  toastDock: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 25 },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 38,
    paddingLeft: 11,
    paddingRight: 15,
    borderRadius: radius.input,
    backgroundColor: c.fg,
    boxShadow: c.shadow,
  },
  toastText: { ...type.action, letterSpacing: 1.26, color: c.bg },
}));
