import { describe, expect, it } from "vitest";
import { dropPlace, moveBlock, orderBlocks, shiftExercise } from "../src/model/plan-order.ts";

const plan = (...groups: (number | null)[]) =>
  groups.map((supersetId, i) => ({ id: String.fromCharCode(97 + i), supersetId }));
const ids = (entries: { id: string }[]) => entries.map((entry) => entry.id).join("");

describe("the blocks a routine's exercises move in", () => {
  it("keeps neighbours in one superset together and everything else alone", () => {
    expect(orderBlocks([null, 4, 4, null, 7, 7, 7])).toEqual([[0], [1, 2], [3], [4, 5, 6]]);
    // A group of one is no superset, and members apart from each other move apart.
    expect(orderBlocks([2, null, 5, null, 5])).toEqual([[0], [1], [2], [3], [4]]);
    // Two groups side by side stay two blocks.
    expect(orderBlocks([1, 1, 2, 2])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(orderBlocks([])).toEqual([]);
  });

  it("moves a block to a new place, keeping its members' order", () => {
    const entries = plan(null, 4, 4, null);
    const blocks = orderBlocks(entries.map((e) => e.supersetId));
    expect(ids(moveBlock(entries, blocks, 1, 0))).toBe("bcad");
    expect(ids(moveBlock(entries, blocks, 1, 2))).toBe("adbc");
    expect(ids(moveBlock(entries, blocks, 0, 2))).toBe("bcda");
    expect(ids(moveBlock(entries, blocks, 2, 2))).toBe("abcd");
  });

  it("shifts an exercise by one block, its partners with it, and not past either end", () => {
    const entries = plan(null, 4, 4, null);
    expect(ids(shiftExercise(entries, "c", -1))).toBe("bcad");
    expect(ids(shiftExercise(entries, "b", 1))).toBe("adbc");
    expect(ids(shiftExercise(entries, "d", -1))).toBe("adbc");
    expect(ids(shiftExercise(entries, "a", 1))).toBe("bcad");
    expect(ids(shiftExercise(entries, "a", -1))).toBe("abcd");
    expect(ids(shiftExercise(entries, "d", 1))).toBe("abcd");
    expect(ids(shiftExercise(entries, "missing", 1))).toBe("abcd");
  });
});

describe("where a dragged block lands", () => {
  // Three rows of 64 points, the middle two a pair (128 points).
  const heights = [64, 128, 64];
  it("passes a block once its middle is past that block's middle", () => {
    // The first row's middle (32) has to pass the pair's (128).
    expect(dropPlace(heights, 0, 95)).toBe(0);
    expect(dropPlace(heights, 0, 97)).toBe(1);
    // And then the last row's middle (224).
    expect(dropPlace(heights, 0, 193)).toBe(2);
    // The pair's middle (128) going up past the first row's (32).
    expect(dropPlace(heights, 1, -97)).toBe(0);
    expect(dropPlace(heights, 1, -95)).toBe(1);
    // The last row up past the pair: its middle (224) to above 128.
    expect(dropPlace(heights, 2, -97)).toBe(1);
    expect(dropPlace(heights, 2, -400)).toBe(0);
    expect(dropPlace(heights, 1, 0)).toBe(1);
  });
});
