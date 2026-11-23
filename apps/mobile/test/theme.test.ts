import { expect, it } from "vitest";
import { appearanceFor, dark, mix, numeral, type Palette, palettes, paper } from "../src/theme.ts";

function luminance(hex: string) {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Text drawn at an opacity, as the colour it shows on its background. */
const dimmed = (ink: string, on: string, opacity: number) => mix(ink, on, opacity);

/** Every key of a palette, nested ones as `rest.ink`, with the kind of value it holds. */
function shape(value: unknown, at = ""): string[] {
  if (value === null || typeof value !== "object")
    return [`${at}: ${value === null ? "none" : typeof value}`];
  return Object.entries(value).flatMap(([key, inner]) => shape(inner, at ? `${at}.${key}` : key));
}

it("gives the paper palette every colour the dark one has", () => {
  // The edge of the body figure is the one colour a palette may leave out.
  const kinds = (p: Palette) =>
    shape(p).map((line) => line.replace(/^muscle\.line: .*/, "muscle.line"));
  expect(kinds(paper)).toEqual(kinds(dark));
  for (const p of Object.values(palettes)) {
    for (const line of shape(p).filter((l) => !l.startsWith("muscle.line"))) {
      expect(line).toMatch(/: string$/);
    }
  }
});

it("follows the system: paper in light mode, graphite in dark mode or when it doesn't say", () => {
  expect(appearanceFor("light")).toBe("paper");
  expect(appearanceFor("dark")).toBe("dark");
  expect(appearanceFor(null)).toBe("dark");
  expect(appearanceFor(undefined)).toBe("dark");
  expect(appearanceFor("unspecified")).toBe("dark");
});

it.each(Object.entries(palettes))("%s keeps every text pairing readable", (_, c) => {
  const ink: [string, string][] = [
    ["values", c.fg],
    ["secondary text", c.fg2],
    ["labels", c.fg3],
  ];
  const surfaces: [string, string][] = [
    ["the ground", c.bg],
    ["cards", c.s1],
    ["raised controls", c.s2],
  ];
  const pairs: [string, string, string][] = [
    ...ink.flatMap(([text, fg]) =>
      surfaces.map(([on, bg]): [string, string, string] => [`${text} on ${on}`, fg, bg]),
    ),
    // The quieter segmented control: its chosen option is a track with ink on it.
    ["values on tracks", c.fg, c.s3],
    ["secondary text on tracks", c.fg2, c.s3],
    ["a selection (ground-coloured text on ink)", c.bg, c.fg],
    ["commit button text", c.commitInk, c.commit],
    ["a commit button's quieter line", dimmed(c.commitInk, c.commit, 0.85), c.commit],
    ["records on the ground", c.record, c.bg],
    ["records on cards", c.record, c.s1],
    ["records on raised controls", c.record, c.s2],
    ["warnings on the ground", c.alert, c.bg],
    ["warnings on cards", c.alert, c.s1],
    ["destructive actions on the ground", c.danger, c.bg],
    ["destructive actions on cards", c.danger, c.s1],
    ["destructive actions on raised controls", c.danger, c.s2],
    ["a destructive button's ink", c.dangerInk, c.danger],
    ["the save problem banner", c.bg, c.alert],
    ["the rest countdown", c.rest.ink, c.rest.bg],
    ["the rest timer's labels", c.rest.ink2, c.rest.bg],
    ["the rest timer's skip", c.rest.skipInk, c.rest.skip],
    ["the quieter rest countdown", c.restGraphite.ink, c.restGraphite.bg],
    ["the quieter rest timer's labels", c.restGraphite.ink2, c.restGraphite.bg],
    ["the quieter rest timer's skip", c.restGraphite.skipInk, c.restGraphite.skip],
  ];
  for (const [what, foreground, background] of pairs) {
    const ratio = Math.floor(contrast(foreground, background) * 100) / 100;
    expect({ what, aa: ratio >= 4.5 }).toEqual({ what, aa: true });
  }
});

it.each(Object.entries(palettes))(
  "%s keeps vermilion for commits, brass for records and the rest timer to itself",
  (_, c) => {
    const ink = [c.fg, c.fg2, c.fg3];
    expect(new Set([c.commit, c.record, ...ink]).size).toBe(5);
    // Records are a warm brass, not a grey: more red and green than blue.
    const channel = (i: number) => Number.parseInt(c.record.slice(1 + i * 2, 3 + i * 2), 16);
    expect(channel(0) > channel(2) && channel(1) > channel(2)).toBe(true);
    // The rest timer stands apart from every surface.
    expect([c.bg, c.s1, c.s2, c.s3]).not.toContain(c.rest.bg);
  },
);

it("raises surfaces away from the ground and runs the muscle ramp away from the card", () => {
  for (const c of Object.values(palettes)) {
    // Each step up (ground, card, raised control) sits further from the ground.
    const rise = [c.bg, c.s1, c.s2].map((s) => contrast(s, c.bg));
    expect(rise).toEqual([...rise].sort((a, b) => a - b));
    expect(new Set(rise).size).toBe(3);
    // Tracks are distinct from cards, so an empty bar shows.
    expect(contrast(c.s3, c.s1)).toBeGreaterThan(1.15);
    // Each step of training stands out from the card more than the last.
    const ramp = c.muscle.ramp.map((step) => contrast(step, c.s1));
    expect(ramp).toEqual([...ramp].sort((a, b) => a - b));
    expect(new Set(c.muscle.ramp).size).toBe(c.muscle.ramp.length);
  }
});

it("prints the paper body figure darker than the paper, with an edge", () => {
  expect(luminance(paper.muscle.body)).toBeLessThan(luminance(paper.s1));
  expect(luminance(paper.muscle.neutral)).toBeLessThan(luminance(paper.muscle.body));
  expect(paper.muscle.line).not.toBeNull();
  expect(dark.muscle.line).toBeNull();
});

it("mixes colours by the amount of the first", () => {
  expect(mix("#FFFFFF", "#000000", 1)).toBe("#FFFFFF");
  expect(mix("#FFFFFF", "#000000", 0)).toBe("#000000");
  expect(mix("#F3F1EC", "#101217", 0.7)).toBe("#AFAEAC");
});

it("draws big numbers thin and tabular, and smaller ones a step heavier", () => {
  expect(numeral(64)).toMatchObject({ fontSize: 64, fontWeight: "200" });
  expect(numeral(28)).toMatchObject({ fontSize: 28, fontWeight: "300" });
  expect(numeral(28).fontVariant).toEqual(["tabular-nums"]);
  // Tight tracking that grows with the size.
  expect(numeral(64).letterSpacing).toBeLessThan(numeral(28).letterSpacing ?? 0);
});
