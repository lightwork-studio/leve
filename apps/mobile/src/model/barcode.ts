/** One set as a barcode draws it. */
export interface BarcodeSet {
  /** How much the set did: see `setMagnitude`. */
  magnitude: number;
  /** Last time's matching set, drawn as an outline behind this one. */
  previous?: number | null;
  warmup?: boolean;
  /** A personal record. */
  record?: boolean;
  /** Planned but not done: drawn as a stub. */
  skipped?: boolean;
}

export type BarKind = "work" | "warmup" | "record" | "skipped";

export interface BarcodeBar {
  kind: BarKind;
  /** This time's bar, in points. */
  height: number;
  /** Last time's outline, in points, or 0 when there is none. */
  ghost: number;
}

/** The height of a skipped set's stub. */
export const SKIPPED_HEIGHT = 3;

/**
 * A set's size for its bar: weight × reps when it has both, otherwise its reps, its time or its
 * distance, so every kind of exercise draws.
 */
export function setMagnitude(set: {
  weightKg?: number | null;
  reps?: number | null;
  seconds?: number | null;
  meters?: number | null;
}): number {
  const { weightKg, reps, seconds, meters } = set;
  if (weightKg && reps) return weightKg * reps;
  return reps || seconds || meters || 0;
}

/**
 * Bar heights for each exercise's sets. Each exercise is scaled on its own, so its biggest set
 * (this time or last) is `height` tall, and a light exercise still shows its shape beside a heavy
 * one. Every done set is at least `minHeight`, so a small set is still seen.
 */
export function barcodeBars(
  exercises: readonly (readonly BarcodeSet[])[],
  height: number,
  minHeight = 4,
): BarcodeBar[][] {
  return exercises.map((sets) => {
    const most = Math.max(
      1,
      ...sets.map((set) => Math.max(positive(set.magnitude), positive(set.previous))),
    );
    return sets.map((set) => ({
      kind: set.skipped ? "skipped" : set.record ? "record" : set.warmup ? "warmup" : "work",
      height: set.skipped
        ? SKIPPED_HEIGHT
        : Math.max(minHeight, (positive(set.magnitude) / most) * height),
      ghost: positive(set.previous)
        ? Math.max(SKIPPED_HEIGHT, (positive(set.previous) / most) * height)
        : 0,
    }));
  });
}

const positive = (value: number | null | undefined) =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

/** A logged set's size for its bar (see `setMagnitude`), from the set as stored. */
export const storedSetMagnitude = (set: {
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
}) =>
  setMagnitude({
    weightKg: set.weightKg,
    reps: set.reps,
    seconds: set.durationSeconds,
    meters: set.distanceMeters,
  });
