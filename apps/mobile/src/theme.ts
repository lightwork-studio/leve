import type { TextStyle } from "react-native";
import { graphite, sheet } from "../../../design/surface-colors";
// Without an extension, so each platform gets its own typefaces (fonts.web.ts in browsers).
import { families } from "./fonts";

/**
 * Leve's colours, as one palette per appearance. Every palette has the same roles, so a screen
 * that reads roles works in any of them:
 *
 * - Surfaces from the ground up: `bg` (the screen), `s1` (cards and groups), `s2` (raised controls
 *   on a card, a selected row), `s3` (tracks and empty bars). Hairlines are `line` between rows and
 *   cells and `line2` around controls.
 * - Ink in three levels: `fg` (bone in the dark, graphite on paper: values, titles, and the
 *   selection, drawn as `fg` with `bg` text on it), `fg2` (secondary text) and `fg3` (labels and
 *   hints; never on `s3`).
 * - `commit` (vermilion) only for actions that commit something: start, log, save. Text on it is
 *   `commitInk`.
 * - `record` (brass) only for personal records.
 * - `rest`: the rest timer's own colours (inverted bone; `restGraphite` is the quieter option).
 * - `alert` for warnings and errors.
 * - `danger` only for destructive actions: remove, delete, start again. Text on it is `dangerInk`.
 *   It is a cooler red than `commit`, so removing never looks like committing.
 */
export interface Palette {
  bg: string;
  s1: string;
  s2: string;
  s3: string;
  line: string;
  line2: string;
  fg: string;
  fg2: string;
  fg3: string;
  commit: string;
  commitInk: string;
  record: string;
  alert: string;
  danger: string;
  dangerInk: string;
  /** Chart bars and lines that aren't highlighted. */
  bar: string;
  /** Behind a sheet or dialog. */
  scrim: string;
  /** Floating things (the main action, sheets): a soft drop shadow. */
  shadow: string;
  rest: RestColors;
  /** The quieter rest timer, kept as an option. */
  restGraphite: RestColors;
  /**
   * The body figure: its silhouette, the parts that are not muscles, the ramp from untrained to
   * most trained, the silhouette's edge (null for none) and the quieter body of small figures.
   */
  muscle: {
    body: string;
    neutral: string;
    ramp: readonly [string, string, string, string, string];
    line: string | null;
    small: string;
  };
}

/** The rest timer: its ground, the part that drains, its ink, and its buttons. */
export interface RestColors {
  bg: string;
  fill: string;
  ink: string;
  ink2: string;
  button: string;
  skip: string;
  skipInk: string;
  /** The draining edge. */
  edge: string;
  /** Its outline, where it needs one. */
  line: string;
}

/** `a` mixed with `b`, `amount` of the way to `a` (both #RRGGBB). */
export function mix(a: string, b: string, amount: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) =>
    Math.round(channel(a, i) * amount + channel(b, i) * (1 - amount))
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${out.join("").toUpperCase()}`;
}

/** Graphite surfaces with bone ink: the dark appearance. */
export const dark: Palette = {
  ...graphite,
  record: "#E3B341",
  alert: graphite.commit,
  // A rose red, as bright as vermilion but cooler, so neither outshouts the other.
  danger: "#FF5C7A",
  dangerInk: "#1A0509",
  bar: "#4C525E",
  scrim: "rgba(0, 0, 0, 0.6)",
  shadow: "0px 16px 36px -8px rgba(0, 0, 0, 0.7)",
  rest: {
    bg: mix(graphite.fg, graphite.bg, 0.7),
    fill: graphite.fg,
    ink: graphite.bg,
    // Dark enough for its small labels to read on the bone ground.
    ink2: mix(graphite.bg, graphite.fg, 0.82),
    button: "rgba(16, 18, 23, 0.13)",
    skip: graphite.bg,
    skipInk: graphite.fg,
    edge: graphite.bg,
    line: "transparent",
  },
  restGraphite: {
    bg: graphite.s1,
    fill: graphite.s3,
    ink: graphite.fg,
    ink2: graphite.fg2,
    button: graphite.s2,
    skip: graphite.fg,
    skipInk: graphite.bg,
    edge: graphite.fg,
    line: graphite.line2,
  },
  muscle: {
    body: mix(graphite.fg, graphite.s2, 0.04),
    neutral: mix(graphite.fg, graphite.s2, 0.07),
    ramp: [
      graphite.s3,
      mix(graphite.fg, graphite.s3, 0.28),
      mix(graphite.fg, graphite.s3, 0.5),
      mix(graphite.fg, graphite.s3, 0.74),
      graphite.fg,
    ],
    line: null,
    small: mix(graphite.fg, graphite.s2, 0.03),
  },
};

/**
 * Warm paper with graphite ink: the light appearance. Surfaces get lighter as they rise (the
 * ground, then cards, then white controls); tracks (`s3`) are pressed in, darker than the ground.
 */
export const paper: Palette = {
  ...sheet,
  // Brass deep enough for its numbers to read on the ground as well as on cards.
  record: "#8A6205",
  // Warnings are text on paper, so they take a deeper red than the commit colour.
  alert: "#BF3B14",
  // A deep crimson: darker than paper's light vermilion as well as a different hue.
  danger: "#B8204A",
  dangerInk: "#FFFFFF",
  bar: "#BDB8AE",
  scrim: "rgba(20, 20, 24, 0.34)",
  shadow: "0px 16px 34px -10px rgba(50, 40, 20, 0.28)",
  rest: {
    // Inverted: graphite ink as the ground, paper as the type.
    bg: mix(sheet.fg, sheet.bg, 0.7),
    fill: sheet.fg,
    ink: sheet.bg,
    // Light enough for its small labels to read on the graphite ground.
    ink2: mix(sheet.bg, sheet.fg, 0.88),
    button: "rgba(238, 235, 228, 0.13)",
    skip: sheet.bg,
    skipInk: sheet.fg,
    edge: sheet.bg,
    line: "transparent",
  },
  restGraphite: {
    bg: sheet.s1,
    fill: sheet.s3,
    ink: sheet.fg,
    ink2: sheet.fg2,
    button: sheet.s2,
    skip: sheet.fg,
    skipInk: sheet.bg,
    edge: sheet.fg,
    line: sheet.line2,
  },
  // The figure is printed darker than the paper, with a hairline at its edge, so each step of the
  // ramp stands out from the card as much as it does in the dark appearance.
  muscle: {
    body: "#E3DED4",
    neutral: "#D9D3C7",
    ramp: ["#BEB7A9", "#8B877F", "#666460", "#414141", "#15171C"],
    line: "#8E877A",
    small: "#E3DED4",
  },
};

/** Every appearance Leve has, all with the same roles. */
export const palettes = { dark, paper } as const satisfies Record<string, Palette>;
export type Appearance = keyof typeof palettes;

/**
 * The appearance for the system's colour scheme: paper in light mode, graphite otherwise (and
 * when the system doesn't say).
 */
export function appearanceFor(scheme: string | null | undefined): Appearance {
  return scheme === "light" ? "paper" : "dark";
}

const tabular: TextStyle["fontVariant"] = ["tabular-nums"];

/**
 * Typeface and weight, to spread into a text style (`...font.bodySemi`). Colour and size stay
 * with the style, so these work in any appearance.
 */
export const font = {
  body: { fontFamily: families.text, fontWeight: "400" },
  bodyMedium: { fontFamily: families.text, fontWeight: "500" },
  bodySemi: { fontFamily: families.text, fontWeight: "600" },
  bodyBold: { fontFamily: families.text, fontWeight: "700" },
  mono: { fontFamily: families.mono, fontWeight: "500", fontVariant: tabular },
  monoSemi: { fontFamily: families.mono, fontWeight: "600", fontVariant: tabular },
  monoBold: { fontFamily: families.mono, fontWeight: "700", fontVariant: tabular },
  numeral: { fontFamily: families.numeral, fontWeight: "200", fontVariant: tabular },
} as const satisfies Record<string, TextStyle>;

/**
 * A number drawn as a gauge reads it: thin, tabular and tightly set. Big numbers are thinnest;
 * smaller ones (under 40) are a step heavier so they stay crisp.
 */
export function numeral(size: number, weight?: "200" | "300" | "400"): TextStyle {
  return {
    ...font.numeral,
    fontWeight: weight ?? (size >= 40 ? "200" : "300"),
    fontSize: size,
    lineHeight: Math.round(size * 1.04),
    letterSpacing: -0.04 * size,
  };
}

/** Small monospaced capitals with open tracking: labels, units, tab and button text. */
function caps(size: number, weight: "mono" | "monoSemi" | "monoBold", tracking: number) {
  return {
    ...font[weight],
    fontSize: size,
    lineHeight: Math.round(size * 1.3),
    letterSpacing: tracking * size,
    textTransform: "uppercase",
  } as const satisfies TextStyle;
}

/** The type scale. Sizes step clearly rather than by a point here and there. */
export const type = {
  /** A screen's large title. */
  title: { ...font.bodyBold, fontSize: 32, lineHeight: 34, letterSpacing: -0.8 },
  /** A section heading inside a screen. */
  heading: { ...font.bodyBold, fontSize: 21, lineHeight: 24, letterSpacing: -0.3 },
  /** A card's or sheet's title. */
  cardTitle: { ...font.bodyBold, fontSize: 17, lineHeight: 21, letterSpacing: -0.17 },
  /** A row's main line. */
  rowTitle: { ...font.bodySemi, fontSize: 15.5, lineHeight: 19 },
  body: { ...font.body, fontSize: 15, lineHeight: 21 },
  /** Notes under a group, and other small running text. */
  caption: { ...font.body, fontSize: 12.5, lineHeight: 18 },
  /** A row's secondary line, values and counts. */
  meta: { ...font.mono, fontSize: 11, lineHeight: 15 },
  /** A value at the end of a row. */
  value: { ...font.mono, fontSize: 12, lineHeight: 16 },
  /** The small capitals above a readout, group or field. */
  label: caps(10.5, "mono", 0.14),
  /** Column heads and tags. */
  labelSmall: caps(9.5, "monoSemi", 0.14),
  /** Text on buttons, tabs and segmented controls. */
  action: caps(10.5, "monoSemi", 0.13),
  /** Text on a commit button. */
  commit: caps(11, "monoBold", 0.16),
  /** A unit after a number (kg, reps). */
  unit: { ...font.mono, fontSize: 10.5, letterSpacing: 0.4 },
} as const satisfies Record<string, TextStyle>;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;

/** Corners: small chips, controls (buttons, fields), cards and groups, and sheets. */
export const radius = { chip: 10, input: 13, button: 16, card: 22, hero: 30, pill: 999 } as const;

/** Smallest comfortable touch target. */
export const touch = 44;

/** The space at the screen's side, and the inset of grouped cards. */
export const gutter = { screen: 20, group: 14 } as const;
