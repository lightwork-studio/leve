import type { ReactNode } from "react";
import { Text } from "react-native";
import { touch, type } from "../theme.ts";
import { CheckIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * A header tile that switches a list into a mode for rearranging it (Reorder, Edit) and, drawn in
 * bone with a check, back out of it (Done).
 */
export function ModeTile({
  on,
  label,
  accessibilityLabel,
  doneAccessibilityLabel,
  icon,
  onToggle,
  disabled = false,
}: {
  on: boolean;
  label: string;
  accessibilityLabel: string;
  doneAccessibilityLabel: string;
  /** Draws the tile's icon in the given ink while the mode is off. */
  icon: (color: string) => ReactNode;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={on ? doneAccessibilityLabel : accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onToggle}
      scaleTo={0.95}
      style={[styles.tile, on && styles.tileBone, disabled && styles.off]}
    >
      {on ? <CheckIcon color={c.bg} size={16} strokeWidth={2.4} /> : icon(c.fg2)}
      <Text style={[styles.tileText, on && styles.tileTextBone]}>{on ? "Done" : label}</Text>
    </Tap>
  );
}

const sheet = themedStyles((c) => ({
  off: { opacity: 0.35 },
  tile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minHeight: touch,
    paddingHorizontal: 13,
    borderRadius: 13,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
  },
  tileBone: { backgroundColor: c.fg, borderColor: c.fg },
  tileText: { ...type.action, letterSpacing: 1.26, color: c.fg2 },
  tileTextBone: { color: c.bg },
}));
