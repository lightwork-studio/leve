import { supersetMemberships } from "./supersets.ts";

/**
 * A routine's exercises as the blocks they move in: exercises next to each other in one superset
 * move together, and every other exercise moves alone. Each block lists its exercises' places.
 */
export function orderBlocks(groupIds: readonly (number | null | undefined)[]): number[][] {
  const members = supersetMemberships(groupIds);
  const blocks: number[][] = [];
  groupIds.forEach((group, index) => {
    const last = blocks.at(-1);
    const joined =
      last !== undefined &&
      members[index] !== undefined &&
      members[index - 1] !== undefined &&
      groupIds[index - 1] === group;
    if (joined) last.push(index);
    else blocks.push([index]);
  });
  return blocks;
}

/** The exercises with one block taken from its place and put back at another, `to` counting blocks. */
export function moveBlock<T>(
  entries: readonly T[],
  blocks: readonly number[][],
  from: number,
  to: number,
): T[] {
  const order = blocks.slice();
  const [moved] = order.splice(from, 1);
  if (!moved) return entries.slice();
  order.splice(Math.max(0, Math.min(to, order.length)), 0, moved);
  return order.flat().map((index) => entries[index] as T);
}

/**
 * Moves the block holding the exercise with this id one block up or down, its superset partners
 * with it. The same list when it is already at that end.
 */
export function shiftExercise<T extends { id: string; supersetId?: number | null }>(
  entries: readonly T[],
  id: string,
  direction: -1 | 1,
): T[] {
  const blocks = orderBlocks(entries.map((entry) => entry.supersetId));
  const from = blocks.findIndex((block) => block.some((index) => entries[index]?.id === id));
  const to = from + direction;
  if (from < 0 || to < 0 || to >= blocks.length) return entries.slice();
  return moveBlock(entries, blocks, from, to);
}

/**
 * Where a dragged block lands: the number of other blocks whose middle it has passed. `heights`
 * are the blocks' heights in their order before the drag, and `dy` how far it was dragged.
 */
export function dropPlace(heights: readonly number[], from: number, dy: number): number {
  const tops: number[] = [];
  let top = 0;
  for (const height of heights) {
    tops.push(top);
    top += height;
  }
  const middle = (tops[from] ?? 0) + dy + (heights[from] ?? 0) / 2;
  let place = 0;
  heights.forEach((height, index) => {
    if (index !== from && (tops[index] ?? 0) + height / 2 < middle) place += 1;
  });
  return place;
}
