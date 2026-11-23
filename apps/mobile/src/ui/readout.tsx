import { Text, View } from "react-native";
import { numeral, type } from "../theme.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

/** One gauge in a row of readouts: a small caps label over a thin number and its unit. */
export interface Readout {
  label: string;
  value: string;
  unit?: string;
  /** A personal record: the number is brass. */
  record?: boolean;
  /** Its share of the row's width (1 by default), so a long value gets more room. */
  width?: number;
  /** Makes the cell a button, e.g. to edit the value. */
  onPress?: () => void;
  /** What a screen reader says, when the label, value and unit alone don't say it. */
  accessibilityLabel?: string;
}

/**
 * Readouts side by side in hairline cells, like an instrument panel. `divided` draws a hairline
 * above them, for a row under other content in the same card.
 */
export function Readouts({
  cells,
  divided = false,
  size = 28,
}: {
  cells: readonly Readout[];
  divided?: boolean;
  /** The numbers' size. */
  size?: number;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={[styles.row, divided && styles.divided]}>
      {cells.map((cell, i) => {
        const spoken =
          cell.accessibilityLabel ?? [cell.label, cell.value, cell.unit].filter(Boolean).join(" ");
        const body = (
          <>
            <Text style={styles.label} numberOfLines={1}>
              {cell.label}
            </Text>
            <Text
              style={[styles.value, numeral(size), cell.record && styles.record]}
              numberOfLines={1}
            >
              {cell.value}
              {cell.unit ? <Text style={styles.unit}> {cell.unit}</Text> : null}
            </Text>
          </>
        );
        const style = [styles.cell, i > 0 && styles.cellDivider, { flex: cell.width ?? 1 }];
        return cell.onPress ? (
          <Tap
            key={cell.label}
            accessibilityRole="button"
            accessibilityLabel={spoken}
            onPress={cell.onPress}
            scaleTo={0.98}
            style={style}
          >
            {body}
          </Tap>
        ) : (
          <View key={cell.label} accessible accessibilityLabel={spoken} style={style}>
            {body}
          </View>
        );
      })}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  row: { flexDirection: "row" },
  divided: { borderTopWidth: 1, borderTopColor: c.line },
  cell: { minWidth: 0, paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 10 },
  cellDivider: { borderLeftWidth: 1, borderLeftColor: c.line },
  label: { ...type.label, color: c.fg3 },
  value: { color: c.fg, marginTop: 9 },
  record: { color: c.record },
  unit: { ...type.unit, color: c.fg3 },
}));
