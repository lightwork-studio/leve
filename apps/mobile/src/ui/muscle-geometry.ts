import shapes from "./muscle-paths.json";

/*
 * Where each muscle lies on the body figure, for taps. The figure's SVG paths are flattened once
 * into polygons, so a tap can be tested against them without the drawing itself.
 */

export type Side = "front" | "back";
export const SIDES: readonly Side[] = ["front", "back"];

/** The part of each side's drawing the figure shows: x, y, width and height in path units. */
export const FIGURE_VIEWBOX: Record<Side, readonly [number, number, number, number]> = {
  front: [40, 86, 650, 1276],
  back: [760, 86, 650, 1276],
};
/** Width over height of one side. */
export const FIGURE_ASPECT = 650 / 1276;

type Paths = Record<string, string>;
const sides = shapes as unknown as Record<Side, Paths>;

/** The muscles drawn on a side, in drawing order (the outline and neutral shapes left out). */
export function sideMuscles(side: Side): string[] {
  return Object.keys(sides[side]).filter((key) => key !== "outline" && key !== "neutral");
}

/** Every muscle the figure can show, front first. */
export const FIGURE_MUSCLES: readonly string[] = [
  ...new Set([...sideMuscles("front"), ...sideMuscles("back")]),
];

const BACK_FIRST = new Set([
  "traps",
  "triceps",
  "calves",
  "upper_back",
  "lats",
  "lower_back",
  "glutes",
  "hamstrings",
  "abductors",
]);

/** The side that shows a muscle best, for a figure that has room for only one. */
export function sideOf(muscle: string | undefined): Side {
  return muscle && BACK_FIRST.has(muscle) ? "back" : "front";
}

/** The path data for a muscle (or the outline) on a side, if it is drawn there. */
export function musclePath(side: Side, key: string): string | undefined {
  return sides[side][key];
}

interface Shape {
  /** Closed rings as flat x, y lists. */
  rings: number[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const CURVE_STEPS = 8;

/** Flattens SVG path data into rings of points (curves become short lines; arcs, a line). */
export function flattenPath(d: string): number[][] {
  const rings: number[][] = [];
  let ring: number[] = [];
  let at = 0;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let command = "";
  const skip = () => {
    while (at < d.length && /[\s,]/.test(d[at] as string)) at++;
  };
  const number = () => {
    skip();
    const found = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(at, at + 32));
    if (!found) throw new Error(`Unreadable path at ${at}`);
    at += found[0].length;
    return Number(found[0]);
  };
  // Arc flags are single digits and may run into what follows ("011.67" is 0, 1, 1.67).
  const flag = () => {
    skip();
    at++;
  };
  const close = () => {
    if (ring.length >= 6) rings.push(ring);
    ring = [];
  };
  const lineTo = (nx: number, ny: number) => {
    ring.push(nx, ny);
    x = nx;
    y = ny;
  };
  for (;;) {
    skip();
    if (at >= d.length) break;
    const char = d[at] as string;
    if (/[a-zA-Z]/.test(char)) {
      command = char;
      at++;
      if (command === "z" || command === "Z") {
        close();
        x = startX;
        y = startY;
        continue;
      }
    }
    const relative = command === command.toLowerCase();
    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    switch (command.toLowerCase()) {
      case "m": {
        close();
        x = ox + number();
        y = oy + number();
        startX = x;
        startY = y;
        ring.push(x, y);
        // Further pairs after a move are lines.
        command = relative ? "l" : "L";
        break;
      }
      case "l": {
        const nx = ox + number();
        lineTo(nx, oy + number());
        break;
      }
      case "h":
        lineTo(ox + number(), y);
        break;
      case "v":
        lineTo(x, oy + number());
        break;
      case "q": {
        const cx = ox + number();
        const cy = oy + number();
        const ex = ox + number();
        const ey = oy + number();
        const sx = x;
        const sy = y;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          lineTo(
            u * u * sx + 2 * u * t * cx + t * t * ex,
            u * u * sy + 2 * u * t * cy + t * t * ey,
          );
        }
        break;
      }
      case "c": {
        const c1x = ox + number();
        const c1y = oy + number();
        const c2x = ox + number();
        const c2y = oy + number();
        const ex = ox + number();
        const ey = oy + number();
        const sx = x;
        const sy = y;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          lineTo(
            u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
            u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
          );
        }
        break;
      }
      case "a": {
        // The arcs in these paths are tiny, so a line to their end will do.
        number();
        number();
        number();
        flag();
        flag();
        const nx = ox + number();
        lineTo(nx, oy + number());
        break;
      }
      default:
        throw new Error(`Unsupported path command ${command}`);
    }
  }
  close();
  return rings;
}

function shapeOf(d: string): Shape {
  const rings = flattenPath(d);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k += 2) {
      const px = ring[k] as number;
      const py = ring[k + 1] as number;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  return { rings, minX, minY, maxX, maxY };
}

const cache = new Map<Side, [string, Shape][]>();

function sideShapes(side: Side): [string, Shape][] {
  let known = cache.get(side);
  if (!known) {
    known = sideMuscles(side).map((group) => [group, shapeOf(sides[side][group] as string)]);
    cache.set(side, known);
  }
  return known;
}

/** Whether a point is inside a shape, by the SVG default (non-zero) fill rule. */
function inside(shape: Shape, px: number, py: number): boolean {
  if (px < shape.minX || px > shape.maxX || py < shape.minY || py > shape.maxY) return false;
  let winding = 0;
  for (const ring of shape.rings) {
    const n = ring.length;
    for (let k = 0; k < n; k += 2) {
      const ax = ring[k] as number;
      const ay = ring[k + 1] as number;
      const bx = ring[(k + 2) % n] as number;
      const by = ring[(k + 3) % n] as number;
      const side = (bx - ax) * (py - ay) - (px - ax) * (by - ay);
      if (ay <= py) {
        if (by > py && side > 0) winding++;
      } else if (by <= py && side < 0) winding--;
    }
  }
  return winding !== 0;
}

/** The muscle drawn at a point in path units, the topmost when shapes overlap. */
export function muscleAt(side: Side, px: number, py: number): string | null {
  const list = sideShapes(side);
  for (let k = list.length - 1; k >= 0; k--) {
    const [group, shape] = list[k] as [string, Shape];
    if (inside(shape, px, py)) return group;
  }
  return null;
}

/** Rings around a tap that miss, in points: the nearest ring that lands on a muscle decides. */
const RINGS = [5, 9, 14, 20];
const SAMPLES = 16;

/**
 * The muscle a tap means: the one under it, or else the one most of the nearest ring of samples
 * around it lands on, up to about 20 points away, so small muscles and the gaps between them
 * stay easy to hit. `unitsPerPoint` is how many path units one screen point covers.
 */
export function nearestMuscle(
  side: Side,
  px: number,
  py: number,
  unitsPerPoint: number,
): string | null {
  const direct = muscleAt(side, px, py);
  if (direct) return direct;
  for (const radius of RINGS) {
    const votes = new Map<string, number>();
    for (let k = 0; k < SAMPLES; k++) {
      const angle = (k / SAMPLES) * 2 * Math.PI;
      const group = muscleAt(
        side,
        px + radius * unitsPerPoint * Math.cos(angle),
        py + radius * unitsPerPoint * Math.sin(angle),
      );
      if (group) votes.set(group, (votes.get(group) ?? 0) + 1);
    }
    let best: string | null = null;
    let most = 0;
    for (const [group, count] of votes) {
      if (count > most) {
        best = group;
        most = count;
      }
    }
    if (best) return best;
  }
  return null;
}

/** A point in a figure of `height` points mapped to path units on its side. */
export function toPathUnits(side: Side, height: number, x: number, y: number) {
  const [left, top, , tall] = FIGURE_VIEWBOX[side];
  const scale = tall / height;
  return { px: left + x * scale, py: top + y * scale, unitsPerPoint: scale };
}
