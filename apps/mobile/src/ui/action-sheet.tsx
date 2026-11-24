import { useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, type } from "../theme.ts";
import { Button } from "./buttons.tsx";
import { Enter } from "./enter.tsx";
import { haptic } from "./haptics.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

/**
 * Asking before something that can't be undone: one sentence saying what will happen, any other
 * ways forward, the action in red, and the safe choice on a card of its own underneath. It covers
 * the screen, so only its choices can be reached, and closing it any other way (the scrim, Escape,
 * Android's back button) keeps everything as it was.
 */
export function ActionSheet({
  message,
  choices = [],
  action,
  keep = "Cancel",
  busy = false,
  busyLabel,
  onConfirm,
  onClose,
}: {
  message: string;
  /** Ways forward that lose nothing, offered above the destructive action. */
  choices?: { label: string; onPress: () => void }[];
  /** The destructive action, named as what it does: "Discard workout". */
  action: string;
  /** The safe choice: "Keep training". */
  keep?: string;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={close} aria-label={action}>
      <View style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={keep}
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
        <Enter
          distance={24}
          role="alertdialog"
          aria-modal
          aria-label={action}
          accessibilityViewIsModal
          style={[styles.stack, { paddingBottom: insets.bottom + 16 }]}
        >
          <View style={styles.card}>
            <Text style={styles.message}>{message}</Text>
            {choices.map((choice) => (
              <Tap
                key={choice.label}
                accessibilityRole="button"
                disabled={busy}
                onPress={choice.onPress}
                scaleTo={0.99}
                style={[styles.choice, styles.divider]}
              >
                <Text style={styles.choiceLabel}>{choice.label}</Text>
              </Tap>
            ))}
            <Tap
              accessibilityRole="button"
              accessibilityState={{ busy, disabled: busy }}
              disabled={busy}
              onPress={onConfirm}
              scaleTo={0.99}
              style={[styles.choice, styles.divider]}
            >
              <Text style={[styles.choiceLabel, styles.danger]}>
                {busy && busyLabel ? busyLabel : action}
              </Text>
            </Tap>
          </View>
          <View style={styles.card}>
            <Tap
              accessibilityRole="button"
              disabled={busy}
              onPress={close}
              scaleTo={0.99}
              style={styles.choice}
            >
              <Text style={styles.choiceLabel}>{keep}</Text>
            </Tap>
          </View>
        </Enter>
      </View>
    </Modal>
  );
}

/**
 * What a destructive button needs to ask first: whether its sheet is open, whether the action is
 * running, and the action to run. `capture` keeps the action as it was when the sheet opened, for
 * a choice bound to what the person saw then; otherwise the latest one runs. `onAsk` runs as the
 * sheet opens, to note what the person is shown.
 */
export function useConfirmation(onConfirm: () => unknown, capture = false, onAsk?: () => void) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const captured = useRef<(() => unknown) | null>(null);
  const latest = useRef(onConfirm);
  latest.current = onConfirm;
  return {
    asking,
    busy,
    ask: () => {
      onAsk?.();
      captured.current = onConfirm;
      setAsking(true);
    },
    cancel: () => {
      if (busy) return;
      captured.current = null;
      setAsking(false);
    },
    confirm: async () => {
      if (busy) return;
      const run = capture && captured.current ? captured.current : latest.current;
      setBusy(true);
      try {
        await run();
      } finally {
        captured.current = null;
        setBusy(false);
        setAsking(false);
      }
    },
  };
}

/**
 * A destructive action as red text that never acts on its own: it opens an action sheet saying
 * what will happen, and runs only when that is confirmed.
 */
export function DestructiveButton({
  label,
  message,
  action = label,
  keep,
  busyLabel,
  onConfirm,
  capture = false,
  onAsk,
  disabled = false,
  accessibilityHint,
}: {
  label: string;
  message: string;
  /** The confirming choice in the sheet, when it should differ from the button. */
  action?: string;
  keep?: string;
  busyLabel?: string;
  onConfirm: () => unknown;
  /** Run the action as it was when the sheet opened (see useConfirmation). */
  capture?: boolean;
  /** Runs as the sheet opens, before anything is asked (see useConfirmation). */
  onAsk?: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const confirmation = useConfirmation(onConfirm, capture, onAsk);
  return (
    <>
      <Button
        rank="destructive"
        label={label}
        disabled={disabled || confirmation.busy}
        accessibilityHint={accessibilityHint ?? "Asks before it does anything"}
        onPress={() => {
          haptic.warning();
          confirmation.ask();
        }}
      />
      {confirmation.asking && (
        <ActionSheet
          message={message}
          action={action}
          {...(keep ? { keep } : {})}
          busy={confirmation.busy}
          {...(busyLabel ? { busyLabel } : {})}
          onConfirm={confirmation.confirm}
          onClose={confirmation.cancel}
        />
      )}
    </>
  );
}

const sheet = themedStyles((c) => ({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: c.scrim },
  stack: { paddingHorizontal: 10, gap: 8 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  message: {
    ...type.caption,
    fontSize: 13,
    lineHeight: 19.5,
    color: c.fg2,
    textAlign: "center",
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  choice: { minHeight: 58, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  choiceLabel: { ...type.action, fontSize: 11, letterSpacing: 1.54, color: c.fg },
  danger: { color: c.danger },
}));
