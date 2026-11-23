// Builds Leve's logo files from JetBrains Mono ExtraBold. See README.md in this folder.
//
// Usage: node assets/brand/generate.mjs <deps-dir>
// <deps-dir> holds opentype.js@1.3.4, @resvg/resvg-js@2.6.2 and @fontsource/jetbrains-mono@5.3.0, e.g.
//   npm i --prefix /tmp/leve-brand --ignore-scripts opentype.js@1.3.4 @resvg/resvg-js@2.6.2 @fontsource/jetbrains-mono@5.3.0
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const deps = process.argv[2];
if (!deps) {
  console.error("usage: node assets/brand/generate.mjs <deps-dir>");
  process.exit(1);
}
const require = createRequire(path.join(path.resolve(deps), "package.json"));
const opentype = require("opentype.js");
const { Resvg } = require("@resvg/resvg-js");

const here = path.dirname(fileURLToPath(import.meta.url));
const font = opentype.loadSync(
  path.join(
    path.dirname(require.resolve("@fontsource/jetbrains-mono/package.json")),
    "files/jetbrains-mono-latin-800-normal.woff",
  ),
);

// The app's palette (graphite for dark, paper for light; the full stop is the commit vermilion).
const graphite = { ground: "#101217", ink: "#F3F1EC", stop: "#FF5A2C" };
const paper = { ground: "#EEEBE4", ink: "#15171C", stop: "#F24E1E" };

const capHeight = font.tables.os2.sCapHeight;
// Mono advances leave a wide gap before the full stop; close it to about one stem width.
const STOP_GAP = 0.12;

/** "text" then a full stop, set at a cap height of `cap`, with the baseline at y = 0. */
function setLine(text, cap) {
  const size = (cap / capHeight) * font.unitsPerEm;
  const word = font.getPath(text, 0, 0, size, { kerning: true });
  const stopAtZero = font.getPath(".", 0, 0, size).getBoundingBox();
  const stopX = word.getBoundingBox().x2 + STOP_GAP * cap - stopAtZero.x1;
  const stop = font.getPath(".", stopX, 0, size);
  const w = word.getBoundingBox();
  const s = stop.getBoundingBox();
  const box = {
    x1: Math.min(w.x1, s.x1),
    y1: Math.min(w.y1, s.y1),
    x2: Math.max(w.x2, s.x2),
    y2: Math.max(w.y2, s.y2),
  };
  return { word: word.toPathData(2), stop: stop.toPathData(2), box };
}

/** The given line's paths, centred on (cx, cy) and fitted so its diagonal is at most `diagonal`. */
function centred(text, cx, cy, cap, diagonal, ink, stop) {
  let line = setLine(text, cap);
  const { box } = line;
  const fit = Math.min(1, diagonal / Math.hypot(box.x2 - box.x1, box.y2 - box.y1));
  if (fit < 1) line = setLine(text, cap * fit);
  const b = line.box;
  const tx = (cx - (b.x1 + b.x2) / 2).toFixed(2);
  const ty = (cy - (b.y1 + b.y2) / 2).toFixed(2);
  return `<g transform="translate(${tx} ${ty})"><path d="${line.word}" fill="${ink}"/><path d="${line.stop}" fill="${stop}"/></g>`;
}

const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const square = (body, ground, rx = 0) =>
  svg(
    "0 0 1024 1024",
    `${ground ? `<rect width="1024" height="1024"${rx ? ` rx="${rx}"` : ""} fill="${ground}"/>` : ""}${body}`,
  );

/** The L. mark on a 1024 canvas. */
const mark = (c, opts = {}) =>
  centred("L", 512, 512, opts.cap ?? 500, opts.diagonal ?? Infinity, c.ink, opts.stop ?? c.stop);

/** "text." trimmed to its own bounds, for placing in layouts. */
function lockup(text, c) {
  const line = setLine(text, 100);
  const pad = 4;
  const { x1, y1, x2, y2 } = line.box;
  const viewBox = [x1 - pad, y1 - pad, x2 - x1 + 2 * pad, y2 - y1 + 2 * pad]
    .map((n) => n.toFixed(1))
    .join(" ");
  return svg(
    viewBox,
    `<path d="${line.word}" fill="${c.ink}"/><path d="${line.stop}" fill="${c.stop}"/>`,
  );
}

const out = (name, data) => {
  const file = path.join(here, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(path.relative(process.cwd(), file));
};
const png = (svgText, size) =>
  new Resvg(svgText, { fitTo: { mode: "width", value: size } }).render().asPng();

/** An opaque image as an RGB PNG with no alpha channel, which the App Store requires of icons. */
function opaquePng(svgText, size) {
  const image = new Resvg(svgText, { fitTo: { mode: "width", value: size } }).render();
  const { width, height, pixels } = image;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      if (pixels[from + 3] !== 255) throw new Error(`${svgText.slice(0, 40)}… is not opaque`);
      pixels.copy(raw, row + 1 + x * 3, from, from + 3);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Vector sources.
out("wordmark-on-dark.svg", lockup("Leve", graphite));
out("wordmark-on-light.svg", lockup("Leve", paper));
out("mark-on-dark.svg", lockup("L", graphite));
out("mark-on-light.svg", lockup("L", paper));
out("icon.svg", square(mark(graphite), graphite.ground, 228));
out("icon-light.svg", square(mark(paper), paper.ground, 228));
out("../icon.svg", square(mark(graphite), graphite.ground, 228));

// App icons, named as in apps/mobile/assets.
// iOS masks the corners itself and needs an opaque square.
out("png/icon.png", opaquePng(square(mark(graphite), graphite.ground), 1024));
// Android adaptive icons: keep the mark inside the 66/108 safe circle (626 px of 1024).
const safe = 0.95 * (66 / 108) * 1024;
out("png/android-icon-foreground.png", png(square(mark(graphite, { diagonal: safe })), 1024));
out("png/android-icon-background.png", opaquePng(square("", graphite.ground), 1024));
const white = { ink: "#FFFFFF", stop: "#FFFFFF" };
out("png/android-icon-monochrome.png", png(square(mark(white, { diagonal: safe })), 1024));
out("png/favicon.png", png(square(mark(graphite), graphite.ground, 228), 48));
// Splash: the mark alone on a transparent ground, for a graphite or paper splash colour.
out("png/splash-icon-on-dark.png", png(square(mark(graphite)), 1024));
out("png/splash-icon-on-light.png", png(square(mark(paper)), 1024));
