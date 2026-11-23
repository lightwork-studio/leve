/** Browser font stacks shared by the site and the web build of the app. */
const text =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif';
const numeral =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif';
const mono =
  'ui-monospace, "SF Mono", SFMono-Regular, "Roboto Mono", "Cascadia Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';

export const families = { text, numeral, mono } as const;
