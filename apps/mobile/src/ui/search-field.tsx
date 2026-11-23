import { type ComponentRef, forwardRef, type ReactNode } from "react";
import {
  ScrollView,
  type StyleProp,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { type } from "../theme.ts";
import { CloseIcon, SearchIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * The search field: a magnifier, the text, and ✕ to clear it once there is any. `label` names it
 * for screen readers ("Search exercises").
 */
export const SearchField = forwardRef<
  ComponentRef<typeof TextInput>,
  Omit<TextInputProps, "style" | "value" | "onChangeText"> & {
    label: string;
    /** What the ✕ is called, when "Clear search" isn't specific enough. */
    clearLabel?: string;
    value: string;
    onChangeText: (text: string) => void;
    style?: StyleProp<ViewStyle>;
  }
>(function SearchField(
  { label, clearLabel = "Clear search", value, onChangeText, style, ...input },
  ref,
) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <View style={[styles.search, style]}>
      <SearchIcon color={c.fg2} size={20} />
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityRole="search"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        returnKeyType="search"
        placeholderTextColor={c.fg3}
        {...input}
        value={value}
        onChangeText={onChangeText}
        style={styles.input}
      />
      {value ? (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          onPress={() => onChangeText("")}
          hitSlop={8}
          scaleTo={0.9}
          style={styles.clear}
        >
          <CloseIcon color={c.fg2} size={14} />
        </Tap>
      ) : null}
    </View>
  );
});

/** A filter chip: outlined, filled bone when on. */
export function Chip({
  label,
  on = false,
  onPress,
  icon,
  accessibilityLabel,
}: {
  label: string;
  on?: boolean;
  onPress: () => void;
  icon?: ReactNode;
  accessibilityLabel?: string;
}) {
  const styles = useStyles(sheet);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: on }}
      aria-selected={on}
      onPress={onPress}
      hitSlop={4}
      scaleTo={0.94}
      style={[styles.chip, on && styles.chipOn]}
    >
      {icon}
      <Text style={[styles.chipLabel, on && styles.chipLabelOn]} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

/** A row of chips that scrolls sideways (or wraps, with `wrap`). */
export function ChipRow({
  children,
  wrap = false,
  style,
  label,
}: {
  children: ReactNode;
  wrap?: boolean;
  style?: StyleProp<ViewStyle>;
  label?: string;
}) {
  const styles = useStyles(sheet);
  if (wrap) {
    return (
      <View accessibilityLabel={label} style={[styles.chips, styles.wrap, style]}>
        {children}
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      accessibilityLabel={label}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.chips, style]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

const sheet = themedStyles((c) => ({
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 50,
    paddingLeft: 16,
    paddingRight: 11,
    borderRadius: 16,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line2,
  },
  input: { ...type.body, fontSize: 16, flex: 1, minWidth: 0, height: "100%", color: c.fg },
  clear: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  chips: { flexDirection: "row", gap: 6, paddingHorizontal: 14 },
  wrap: { flexWrap: "wrap", rowGap: 6 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.line2,
  },
  chipOn: { backgroundColor: c.fg, borderColor: c.fg },
  chipLabel: { ...type.action, letterSpacing: 1.05, color: c.fg2 },
  chipLabelOn: { color: c.bg },
}));
