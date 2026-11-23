import {
  type ImageStyle,
  StyleSheet,
  type TextStyle,
  useColorScheme,
  type ViewStyle,
} from "react-native";
import { useAppearanceSetting } from "../data/appearance-setting.ts";
import { type Appearance, appearanceFor, type Palette, palettes } from "../theme.ts";

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

/** Styles described for any palette, made for each palette when first used (see `useStyles`). */
export interface ThemedStyles<T> {
  build: (c: Palette) => T;
  made: Map<Palette, T>;
}

/**
 * The appearance on screen: light, dark, or matching the system. Changes apply without a restart.
 */
export function useAppearance(): Appearance {
  const scheme = useColorScheme();
  const setting = useAppearanceSetting();
  return appearanceFor(setting === "system" ? scheme : setting);
}

/**
 * The palette for what is on screen now. Every component that reads colours through it (or
 * through `useStyles`) draws again in the other palette when the appearance changes.
 */
export function useColors(): Palette {
  return palettes[useAppearance()];
}

/**
 * Styles written against a palette: `const sheet = themedStyles((c) => ({ card: { backgroundColor:
 * c.s1 } }))` beside the component, then `const styles = useStyles(sheet)` inside it.
 */
export function themedStyles<T extends NamedStyles<T>>(
  // The intersection keeps each style's literal values (a "row", an "absolute") rather than
  // widening them to strings, as StyleSheet.create does.
  build: (c: Palette) => T & NamedStyles<T>,
): ThemedStyles<T> {
  return { build, made: new Map() };
}

/** The styles for the palette on screen, created once per palette. */
export function useStyles<T>(sheet: ThemedStyles<T>): T {
  const c = useColors();
  const known = sheet.made.get(c);
  if (known) return known;
  const styles = StyleSheet.create(sheet.build(c) as NamedStyles<T>) as T;
  sheet.made.set(c, styles);
  return styles;
}
