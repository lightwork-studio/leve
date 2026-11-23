import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { graphite, sheet } from "../../design/surface-colors.ts";
import { families } from "../../design/web-fonts.ts";

const source = import.meta.dirname;
const brand = join(source, "../../assets/brand");
const assets = {
  "index.html": join(source, "index.html"),
  "style.css": join(source, "style.css"),
  "screen-rest.png": join(source, "shots/rest.png"),
  "screen-notes.png": join(source, "shots/notes.png"),
  "screen-history.png": join(source, "shots/history.png"),
  "screen-records.png": join(source, "shots/history-list.png"),
  "screen-exercise.png": join(source, "shots/exercise.png"),
  "wordmark-on-dark.svg": join(brand, "wordmark-on-dark.svg"),
  "wordmark-on-light.svg": join(brand, "wordmark-on-light.svg"),
  "favicon.png": join(brand, "png/favicon.png"),
};

type Surface = Record<keyof typeof graphite, string>;

/** The app's palette roles as CSS variables (commitInk becomes --commit-ink). */
function tokens(surface: Surface, indent: string) {
  return Object.entries(surface)
    .map(
      ([role, value]) =>
        `${indent}--${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`,
    )
    .join("\n");
}

/** Graphite by default, as in the app; paper when the system is in light mode. */
export function themeCss() {
  return `:root {
  color-scheme: dark light;
  --font-text: ${families.text};
  --font-numeral: ${families.numeral};
  --font-mono: ${families.mono};
${tokens(graphite, "  ")}
}

@media (prefers-color-scheme: light) {
  :root {
${tokens(sheet, "    ")}
  }
}
`;
}

export async function buildSite(output = join(source, "dist")) {
  // Start empty, so a renamed or removed asset can't linger in the output.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await Promise.all([
    ...Object.entries(assets).map(([name, path]) => copyFile(path, join(output, name))),
    writeFile(join(output, "theme.css"), themeCss()),
  ]);
}

if (import.meta.main) await buildSite();
