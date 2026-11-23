/**
 * The system typefaces Leve draws with, per platform (fonts.android.ts and fonts.web.ts hold the
 * others). On iOS "System" is San Francisco, which picks its text or display cut by size.
 */
export const families = {
  /** Running text, titles and row labels. */
  text: "System",
  /** Big numbers: drawn thin with tabular figures, so digits line up and don't jump. */
  numeral: "System",
  /** Small caps labels, units and secondary details. */
  mono: "Menlo",
} as const;
