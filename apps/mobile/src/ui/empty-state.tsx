import type { ReactNode } from "react";
import { type StyleProp, Text, View, type ViewStyle } from "react-native";
import { font, gutter, radius, type } from "../theme.ts";
import { themedStyles, useStyles } from "./themed.ts";

/**
 * Nothing to show yet: a card with a small caps label, one line saying what is missing, a quiet
 * sentence on what to do, and at most one secondary action (pass a `Button`).
 */
export function EmptyState({
  label,
  title,
  text,
  action,
  style,
  inset = true,
}: {
  label?: string;
  title: string;
  text?: string;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Off for a card already inside a group's margins. */
  inset?: boolean;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={[styles.card, inset && styles.inset, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {text ? <Text style={styles.text}>{text}</Text> : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    paddingVertical: 28,
    paddingHorizontal: 22,
    alignItems: "center",
  },
  inset: { marginHorizontal: gutter.group, marginBottom: 22 },
  label: { ...type.label, color: c.fg3, marginBottom: 10, textAlign: "center" },
  title: { ...font.bodyBold, fontSize: 18, lineHeight: 23, color: c.fg, textAlign: "center" },
  text: {
    ...type.body,
    fontSize: 14,
    lineHeight: 21,
    color: c.fg2,
    textAlign: "center",
    marginTop: 6,
  },
  action: { marginTop: 14, alignSelf: "center" },
}));
