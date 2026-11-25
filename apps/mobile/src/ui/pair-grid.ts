/**
 * Where a cell sits in a two-column grid of `count` cells, and which dividers it draws. Cells
 * draw the line on their left and the line above them. An odd last cell spans the whole row, so
 * the line above it runs under both cells of the row before and no empty slot is left.
 */
export function pairGridCell(index: number, count: number) {
  const wide = count % 2 === 1 && index === count - 1;
  return { wide, left: index % 2 === 1, top: index >= 2 };
}
