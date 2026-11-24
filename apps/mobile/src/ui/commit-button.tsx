import type { ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { font, radius, type } from "../theme.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

// The quieter lines are dimmed only so far that they keep normal text contrast on vermilion.

/**
 * The one vermilion button: an action that commits something (start, log, save). Text on the left
 * and an icon on the right.
 *
 * `slot` is the main action above the tabs: a small caps `label` over a large `title` (Start ·
 * Push A). `dock` is a screen's closing action: a caps `label` with an optional `detail` line under
 * it.
 */
export function CommitButton({
  label,
  title,
  detail,
  icon,
  onPress,
  accessibilityLabel,
  disabled = false,
  busy = false,
  variant = "dock",
}: {
  label: string;
  title?: string;
  detail?: string;
  icon?: ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  variant?: "slot" | "dock";
}) {
  const styles = useStyles(sheet);
  const colors = useColors();
  const slot = variant === "slot";
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [label, title].filter(Boolean).join(", ")}
      accessibilityState={{ busy, disabled: disabled || busy }}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onPress={onPress}
      scaleTo={0.98}
      style={[styles.button, slot ? styles.slot : styles.dock, disabled && styles.disabled]}
    >
      <View style={styles.text}>
        {slot ? (
          <>
            <Text style={styles.eyebrow} numberOfLines={1}>
              {label}
            </Text>
            {title ? (
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Text style={styles.label} numberOfLines={2}>
              {label}
            </Text>
            {detail ? (
              <Text style={styles.detail} numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </>
        )}
      </View>
      {busy ? <ActivityIndicator color={colors.commitInk} /> : icon}
    </Tap>
  );
}

const sheet = themedStyles((c) => ({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: c.commit,
  },
  slot: { minHeight: 70, borderRadius: radius.card, paddingHorizontal: 22, boxShadow: c.shadow },
  dock: { minHeight: 76, borderRadius: 24, paddingHorizontal: 24 },
  disabled: { opacity: 0.35 },
  text: { flex: 1, minWidth: 0 },
  eyebrow: { ...type.commit, fontSize: 10.5, color: c.commitInk, opacity: 0.85 },
  title: {
    ...font.bodyBold,
    fontSize: 21,
    lineHeight: 24,
    letterSpacing: -0.2,
    color: c.commitInk,
    marginTop: 4,
  },
  label: { ...type.commit, color: c.commitInk },
  detail: {
    ...font.mono,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.9,
    color: c.commitInk,
    opacity: 0.85,
  },
}));
