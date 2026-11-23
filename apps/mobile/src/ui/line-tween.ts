// Moving a line chart from one line to another: the geometry, kept apart from drawing so it can be
// tested. The drawing functions are worklets, so they also run on the UI thread, frame by frame.

/**
 * A line as its vertices, in drawing coordinates. `t` says when each vertex is (increasing); it is
 * what matches two lines up, so the same moment moves from where it was to where it goes.
 */
export interface Polyline {
  t: number[];
  x: number[];
  y: number[];
}

export const NO_LINE: Polyline = { t: [], x: [], y: [] };

/**
 * Where a line is at moment `at`: between the vertices on either side of it, or at its first or last
 * vertex beyond them (so a line that is shorter simply stops there).
 */
export function pointAt(line: Polyline, at: number): [number, number] {
  const { t, x, y } = line;
  const last = t.length - 1;
  if (last < 0) return [0, 0];
  if (at <= (t[0] as number)) return [x[0] as number, y[0] as number];
  if (at >= (t[last] as number)) return [x[last] as number, y[last] as number];
  let i = 1;
  while ((t[i] as number) < at) i++;
  const t0 = t[i - 1] as number;
  const t1 = t[i] as number;
  const f = t1 === t0 ? 1 : (at - t0) / (t1 - t0);
  const x0 = x[i - 1] as number;
  const y0 = y[i - 1] as number;
  return [x0 + ((x[i] as number) - x0) * f, y0 + ((y[i] as number) - y0) * f];
}

/**
 * Two lines with the same vertices: each gets a vertex at every moment either has. Each still draws
 * exactly as before (the added vertices lie on its own segments, or on its ends), so moving every
 * vertex from one to the other changes the first line into the second. Null if either is empty.
 */
export function alignLines(a: Polyline, b: Polyline): [Polyline, Polyline] | null {
  if (a.t.length === 0 || b.t.length === 0) return null;
  const times: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.t.length || j < b.t.length) {
    const ta = i < a.t.length ? (a.t[i] as number) : Number.POSITIVE_INFINITY;
    const tb = j < b.t.length ? (b.t[j] as number) : Number.POSITIVE_INFINITY;
    const next = Math.min(ta, tb);
    times.push(next);
    if (ta === next) i++;
    if (tb === next) j++;
  }
  // One walk along each line as the moments go up, rather than a search from its start for each.
  const on = (line: Polyline): Polyline => {
    const { t } = line;
    const last = t.length - 1;
    const x: number[] = [];
    const y: number[] = [];
    let k = 0;
    for (const at of times) {
      if (at <= (t[0] as number) || at >= (t[last] as number)) {
        const end = at <= (t[0] as number) ? 0 : last;
        x.push(line.x[end] as number);
        y.push(line.y[end] as number);
        continue;
      }
      while ((t[k + 1] as number) < at) k++;
      const t0 = t[k] as number;
      const t1 = t[k + 1] as number;
      const f = t1 === t0 ? 1 : (at - t0) / (t1 - t0);
      const x0 = line.x[k] as number;
      const y0 = line.y[k] as number;
      x.push(x0 + ((line.x[k + 1] as number) - x0) * f);
      y.push(y0 + ((line.y[k + 1] as number) - y0) * f);
    }
    return { t: times, x, y };
  };
  return [on(a), on(b)];
}

/** The line part of the way (`p` from 0 to 1) from `a` to `b`, which have the same vertices. */
export function lerpLine(a: Polyline, b: Polyline, p: number): Polyline {
  "worklet";
  if (p >= 1 || a.t.length !== b.t.length) return b;
  if (p <= 0) return a;
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < b.t.length; i++) {
    const ax = a.x[i] as number;
    const ay = a.y[i] as number;
    x.push(ax + ((b.x[i] as number) - ax) * p);
    y.push(ay + ((b.y[i] as number) - ay) * p);
  }
  return { t: b.t, x, y };
}

/** An SVG path through a line's vertices. */
export function linePath(line: Polyline): string {
  "worklet";
  let d = "";
  for (let i = 0; i < line.t.length; i++) {
    d += `${i === 0 ? "M" : " L"}${line.x[i]},${line.y[i]}`;
  }
  return d;
}

/** The area under a line, down to `bottom`; empty for fewer than two vertices. */
export function areaPath(line: Polyline, bottom: number): string {
  "worklet";
  const last = line.t.length - 1;
  if (last < 1) return "";
  return `${linePath(line)} L${line.x[last]},${bottom} L${line.x[0]},${bottom} Z`;
}
