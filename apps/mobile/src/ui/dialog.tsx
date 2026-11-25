import { type ComponentRef, forwardRef, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, touch, type } from "../theme.ts";
import { Button } from "./buttons.tsx";
import { Enter } from "./enter.tsx";
import { HelperLine } from "./field.tsx";
import { CheckIcon, CloseIcon } from "./icons.tsx";
import { Shake } from "./shake.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * A small dialog for one short decision or one value: naming a folder, setting a rest time. It has
 * no title bar. A small caps line says what it is for and ✕ leaves; then the value itself, large,
 * and one full-width bone confirm. It sits high on the screen, clear of the keyboard. Tapping the
 * scrim, ✕, Escape and Android's back button all close it, and nothing behind it can be reached
 * while it is open. Without `onClose` it can't be closed (no ✕): only its own buttons answer it.
 */
export function Dialog({
  eyebrow,
  label,
  onClose,
  closeLabel = "Cancel",
  aside,
  confirm,
  footer,
  children,
}: {
  /** Small caps at the top: "New folder", "Rest timer · Bench Press". */
  eyebrow: string;
  /** What a screen reader calls the dialog, when the eyebrow doesn't say it. */
  label?: string;
  onClose?: () => void;
  /** What a screen reader calls ✕. */
  closeLabel?: string;
  /** A small control between the eyebrow and ✕. */
  aside?: ReactNode;
  /** The bone button at the foot, with a check. Without one, choosing in the body is the answer. */
  confirm?: { label: string; onPress: () => void; accessibilityLabel?: string };
  /** A quiet action under the confirm, such as a destructive one that asks first. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const name = label ?? eyebrow;
  return (
    <Modal
      transparent
      animationType="fade"
      onRequestClose={onClose ?? (() => {})}
      aria-label={name}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.overlay, { paddingTop: insets.top + 40 }]}
      >
        {onClose ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <Enter
          distance={10}
          role="dialog"
          aria-modal
          aria-label={name}
          accessibilityViewIsModal
          style={styles.card}
        >
          <View style={styles.top}>
            <Text style={styles.eyebrow} numberOfLines={2}>
              {eyebrow}
            </Text>
            {aside}
            {onClose ? (
              <Tap
                accessibilityRole="button"
                accessibilityLabel={closeLabel}
                onPress={onClose}
                scaleTo={0.92}
                style={styles.close}
              >
                <CloseIcon color={c.fg2} size={16} />
              </Tap>
            ) : null}
          </View>
          {children}
          {confirm ? (
            <Button
              rank="primary"
              label={confirm.label}
              {...(confirm.accessibilityLabel
                ? { accessibilityLabel: confirm.accessibilityLabel }
                : {})}
              icon={<CheckIcon color={c.bg} size={16} strokeWidth={2.4} />}
              onPress={confirm.onPress}
              style={styles.confirm}
            />
          ) : null}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </Enter>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type DialogFieldProps = Omit<TextInputProps, "style"> & {
  /** The quiet line under the field, on the left. */
  hint?: string;
  /** On the right of that line: "12 / 30". */
  count?: string;
  over?: boolean;
  /** Takes the hint's place in vermilion, turns the underline vermilion and shakes the field. */
  error?: string;
  /** Counts refused saves, so the same message shakes the field again. */
  attempt?: number;
};

/**
 * The dialog's value as a large title typed over an underline, with its helper line below: a hint
 * and a count, or the problem when a save is refused.
 */
export const DialogField = forwardRef<ComponentRef<typeof TextInput>, DialogFieldProps>(
  function DialogField({ hint, count, over = false, error, attempt, ...input }, ref) {
    const styles = useStyles(sheet);
    const c = useColors();
    return (
      <View>
        <Shake trigger={`${attempt ?? 0}:${error ?? ""}`} active={!!error}>
          <TextInput
            ref={ref}
            placeholderTextColor={c.fg3}
            aria-invalid={error ? true : undefined}
            {...input}
            style={[styles.hero, !!error && styles.heroInvalid]}
          />
        </Shake>
        <View style={styles.meta}>
          <HelperLine
            {...(hint ? { hint } : {})}
            {...(count ? { count } : {})}
            {...(error ? { error } : {})}
            over={over}
          />
        </View>
      </View>
    );
  },
);

const sheet = themedStyles((c) => ({
  overlay: { flex: 1, paddingHorizontal: 12, backgroundColor: c.scrim },
  card: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    paddingTop: 14,
    paddingRight: 14,
    paddingBottom: 14,
    paddingLeft: 18,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    borderRadius: 26,
    overflow: "hidden",
    boxShadow: c.shadow,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 10 },
  eyebrow: { ...type.label, color: c.fg3, flex: 1, minWidth: 0 },
  close: {
    width: touch,
    height: touch,
    borderRadius: 13,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  confirm: { marginTop: 16, marginRight: -4 },
  footer: { marginTop: 6, marginRight: 4, alignItems: "center" },
  hero: {
    ...font.bodyBold,
    fontSize: 27,
    lineHeight: 31,
    letterSpacing: -0.54,
    color: c.fg,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1.5,
    borderBottomColor: c.fg,
    // The underline is the field's edge; browsers would add a box of their own.
    outlineWidth: 0,
  },
  heroInvalid: { borderBottomColor: c.alert },
  meta: { marginTop: 9, marginRight: 4, marginLeft: -2 },
}));
