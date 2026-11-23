import type { ReactNode } from "react";
import { type StyleProp, Text, type ViewStyle } from "react-native";
import { radius, touch, type } from "../theme.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

/**
 * The ranks of button below the one vermilion commit (see CommitButton):
 *
 * - `primary`: bone, for confirming an edit in a sheet or dialog (Save set, Save note).
 * - `secondary`: an outlined tile, for an action beside the main one (Add exercise).
 * - `text`: quiet mono capitals, for a tertiary action (Show all). `link` is a shade brighter.
 * - `destructive`: red text. It never acts on its own: it opens a confirmation (see
 *   DestructiveButton), so use that rather than this rank directly.
 */
export type ButtonRank = "primary" | "secondary" | "text" | "link" | "destructive";

export function Button({
  label,
  onPress,
  rank = "secondary",
  icon,
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  label: string;
  onPress: () => void;
  rank?: ButtonRank;
  /** Drawn before the label, in the label's colour (see `useButtonInk`). */
  icon?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(sheet);
  const textual = rank === "text" || rank === "link" || rank === "destructive";
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      scaleTo={textual ? 0.97 : 0.98}
      style={[styles.base, styles[rank], disabled && styles.disabled, style]}
    >
      {icon}
      <Text style={[styles.label, styles[`${rank}Label`]]} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

const sheet = themedStyles((c) => ({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: touch,
  },
  primary: {
    minHeight: 54,
    borderRadius: 17,
    backgroundColor: c.fg,
    paddingHorizontal: 18,
  },
  secondary: {
    minHeight: 52,
    borderRadius: radius.button,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    paddingHorizontal: 16,
  },
  text: { paddingHorizontal: 16 },
  link: { paddingHorizontal: 16 },
  destructive: { paddingHorizontal: 16 },
  disabled: { opacity: 0.35 },
  label: { ...type.action, letterSpacing: 1.5, flexShrink: 1 },
  primaryLabel: { ...type.commit, fontSize: 10.5, letterSpacing: 1.5, color: c.bg },
  secondaryLabel: { letterSpacing: 1.26, color: c.fg },
  textLabel: { color: c.fg3 },
  linkLabel: { color: c.fg2 },
  destructiveLabel: { color: c.danger },
}));

/** The ink a rank's label is drawn in, for its icon. */
export function buttonInk(
  c: { fg: string; bg: string; fg2: string; fg3: string; danger: string },
  rank: ButtonRank,
) {
  switch (rank) {
    case "primary":
      return c.bg;
    case "secondary":
      return c.fg;
    case "link":
      return c.fg2;
    case "destructive":
      return c.danger;
    default:
      return c.fg3;
  }
}
