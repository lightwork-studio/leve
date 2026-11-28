import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { graphite, sheet } from "../../design/surface-colors.ts";
import { families } from "../../design/web-fonts.ts";

const source = import.meta.dirname;
const brand = join(source, "../../assets/brand");
const expoExport = join(source, "../mobile/dist/demo");
const requireMobile = createRequire(new URL("../mobile/package.json", import.meta.url));
const sqlJs = dirname(dirname(requireMobile.resolve("sql.js")));
const assets = {
  _redirects: join(source, "_redirects"),
  "demo.js": join(source, "demo.js"),
  "sql.js-LICENSE.txt": join(sqlJs, "LICENSE"),
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

/** The site's pages. Links to the source on GitHub point at the deployed revision. */
export const pages = ["index.html", "privacy.html", "support.html", "impressum.html"];

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

export async function buildSite(
  output = join(source, "dist"),
  demo = expoExport,
  revision = process.env.LEVE_SITE_SOURCE_REVISION ?? "main",
) {
  if (revision !== "main" && !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Expected a full source commit SHA for the landing page");
  }
  const html = await Promise.all(
    pages.map(async (page) => ({
      page,
      contents: (await readFile(join(source, page), "utf8")).replace(
        /https:\/\/github\.com\/lightwork-studio\/leve\/(tree|blob)\/main/g,
        (_url, kind) => `https://github.com/lightwork-studio/leve/${kind}/${revision}`,
      ),
    })),
  );
  const demoFiles = await Promise.all(
    ["_expo", "assets"].map((name) => readdir(join(demo, name), { recursive: true })),
  );
  const skipped = demoFiles
    .flat()
    .find((path) =>
      path.split(sep).some((entry) => entry.startsWith(".") || entry === "node_modules"),
    );
  if (skipped) throw new Error(`The site deployment would skip a demo asset path: ${skipped}`);

  // Start empty, so a renamed or removed asset can't linger in the output.
  await rm(output, { recursive: true, force: true });
  const demoOutput = join(output, "demo");
  await mkdir(demoOutput, { recursive: true });
  await Promise.all([
    ...Object.entries(assets).map(([name, path]) => copyFile(path, join(output, name))),
    ...["index.html", "favicon.ico", "_expo", "assets"].map((name) =>
      cp(join(demo, name), join(demoOutput, name), { recursive: true }),
    ),
    writeFile(join(output, "theme.css"), themeCss()),
    ...html.map(({ page, contents }) => writeFile(join(output, page), contents)),
  ]);
}

if (import.meta.main) await buildSite();
