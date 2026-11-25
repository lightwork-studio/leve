import { expect, it } from "vitest";
import { pairGridCell } from "../src/ui/pair-grid.ts";

/** Lays the cells out and lists which row halves have a line under them. */
function linesBelow(count: number) {
  const below = new Set<string>();
  for (let i = 0; i < count; i++) {
    const cell = pairGridCell(i, count);
    if (!cell.top) continue;
    const row = Math.floor(i / 2) - 1;
    if (cell.wide) {
      below.add(`${row}:left`);
      below.add(`${row}:right`);
    } else below.add(`${row}:${i % 2 === 0 ? "left" : "right"}`);
  }
  return below;
}

it("gives an odd last record the whole row so every cell above it keeps its divider", () => {
  // Five records, as a weighted exercise has: the last one sits alone in the third row.
  expect(pairGridCell(4, 5)).toEqual({ wide: true, left: false, top: true });
  expect(linesBelow(5)).toEqual(new Set(["0:left", "0:right", "1:left", "1:right"]));
  expect(pairGridCell(3, 5)).toEqual({ wide: false, left: true, top: true });
});

it("keeps even grids in two columns", () => {
  for (let i = 0; i < 4; i++) expect(pairGridCell(i, 4).wide).toBe(false);
  expect(linesBelow(4)).toEqual(new Set(["0:left", "0:right"]));
  expect(pairGridCell(0, 2)).toEqual({ wide: false, left: false, top: false });
  expect(pairGridCell(1, 2)).toEqual({ wide: false, left: true, top: false });
});

it("lets a lone record fill the card without dividers", () => {
  expect(pairGridCell(0, 1)).toEqual({ wide: true, left: false, top: false });
  expect(pairGridCell(2, 3)).toEqual({ wide: true, left: false, top: true });
});
