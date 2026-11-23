import type { ReactNode } from "react";
import { type StyleProp, Text, View, type ViewStyle } from "react-native";
import { gutter, radius, space, type } from "../theme.ts";
import { ChevronIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** Small monospaced capitals naming what follows, with an optional count or note at the end. */
export function SectionLabel({
  children,
  aside,
  strong = false,
  header = false,
}: {
  children: string;
  aside?: string;
  /** Bone instead of grey, for the label that matters most. */
  strong?: boolean;
  /** Read as a heading by screen readers. */
  header?: boolean;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.labelRow}>
      <Text
        accessibilityRole={header ? "header" : undefined}
        style={[styles.label, strong && styles.strong]}
      >
        {children}
      </Text>
      {aside ? <Text style={styles.label}>{aside}</Text> : null}
    </View>
  );
}

/** A section's heading inside a screen, with an optional small caps note at the end. */
export function SectionHeading({ title, aside }: { title: string; aside?: string }) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={styles.headingText}>
        {title}
      </Text>
      {aside ? <Text style={styles.label}>{aside}</Text> : null}
    </View>
  );
}

/**
 * An inset group: a section label, a card of rows, and an optional note under it. Rows inside
 * draw their own hairlines (see `Row`'s `divider`).
 */
export function Group({
  label,
  aside,
  footnote,
  children,
  style,
}: {
  label?: string;
  aside?: string;
  footnote?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={[styles.group, style]}>
      {label ? (
        <View style={styles.groupHead}>
          <SectionLabel aside={aside} header>
            {label}
          </SectionLabel>
        </View>
      ) : null}
      <View style={styles.card}>{children}</View>
      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </View>
  );
}

/**
 * A row in a group: a title with an optional mono detail line under it, then whatever sits at the
 * end (a value, a control) and a chevron when it opens something.
 */
export function Row({
  title,
  detail,
  value,
  end,
  chevron = false,
  divider = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  title: string;
  detail?: string;
  value?: string;
  end?: ReactNode;
  chevron?: boolean;
  /** A hairline above it: every row but a group's first. */
  divider?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const body = (
    <>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {end}
      {chevron ? <ChevronIcon color={c.fg3} size={16} strokeWidth={2} /> : null}
    </>
  );
  const rowStyle = [styles.row, divider && styles.divider, style];
  return onPress ? (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, value].filter(Boolean).join(", ")}
      accessibilityHint={accessibilityHint ?? detail}
      onPress={onPress}
      scaleTo={0.98}
      style={rowStyle}
    >
      {body}
    </Tap>
  ) : (
    <View accessible style={rowStyle}>
      {body}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
  },
  label: { ...type.label, color: c.fg3 },
  strong: { color: c.fg },
  heading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingTop: 6,
    paddingBottom: space.md,
    paddingHorizontal: gutter.screen,
  },
  headingText: { ...type.heading, color: c.fg },
  group: { marginHorizontal: gutter.group, marginBottom: 22 },
  groupHead: { paddingHorizontal: 6, paddingBottom: 9 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  footnote: { ...type.caption, fontSize: 12, color: c.fg3, paddingTop: 9, paddingHorizontal: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { ...type.rowTitle, color: c.fg },
  rowDetail: { ...type.meta, color: c.fg3, marginTop: 4 },
  rowValue: { ...type.value, color: c.fg2 },
}));
