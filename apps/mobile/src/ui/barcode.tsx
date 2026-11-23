import { Fragment } from "react";
import { View } from "react-native";
import { type BarcodeSet, barcodeBars } from "../model/barcode.ts";
import { themedStyles, useStyles } from "./themed.ts";

/**
 * A workout's sets as a barcode: one bar per set, its height the set's size against the biggest in
 * its exercise, with a gap between exercises. Warm-ups are dim, records brass, skipped sets stubs.
 *
 * `compact` is a row's small mark. `compare` also outlines last time's matching set behind each
 * bar, so a session can be read against the one before. It is a picture of numbers said
 * elsewhere, so screen readers skip it.
 */
export function SetBarcode({
  exercises,
  variant = "compact",
  height,
}: {
  exercises: readonly (readonly BarcodeSet[])[];
  variant?: "compact" | "compare";
  height?: number;
}) {
  const styles = useStyles(sheet);
  const compare = variant === "compare";
  const tall = height ?? (compare ? 36 : 28);
  const bars = barcodeBars(exercises, tall, compare ? 3 : 4);
  const solid = {
    work: styles.workSolid,
    warmup: styles.warmupSolid,
    record: styles.recordSolid,
    skipped: styles.skippedSolid,
  };
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.row, compare && styles.compareRow, { height: tall }]}
    >
      {bars.map((sets, e) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: exercises keep their order; nothing moves.
        <Fragment key={e}>
          {e > 0 && <View style={compare ? styles.compareGap : styles.gap} />}
          {sets.map((bar, s) =>
            compare ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above.
              <View key={s} style={styles.slot}>
                {bar.ghost > 0 && <View style={[styles.ghost, { height: bar.ghost }]} />}
                <View style={[styles.solid, solid[bar.kind], { height: bar.height }]} />
              </View>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above.
              <View key={s} style={[styles.bar, styles[bar.kind], { height: bar.height }]} />
            ),
          )}
        </Fragment>
      ))}
    </View>
  );
}

const sheet = themedStyles((c) => ({
  row: { flexDirection: "row", alignItems: "flex-end", gap: 1.5 },
  compareRow: { gap: 3 },
  gap: { width: 4 },
  compareGap: { width: 7 },
  bar: { width: 2, borderTopLeftRadius: 1, borderTopRightRadius: 1 },
  work: { backgroundColor: c.fg2 },
  warmup: { backgroundColor: c.s3 },
  record: { backgroundColor: c.record },
  skipped: { backgroundColor: c.s3, opacity: 0.6 },
  slot: { width: 6, height: "100%", justifyContent: "flex-end" },
  ghost: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: c.fg3,
    borderTopLeftRadius: 1.5,
    borderTopRightRadius: 1.5,
  },
  solid: { marginHorizontal: 1.5, borderTopLeftRadius: 1.5, borderTopRightRadius: 1.5 },
  workSolid: { backgroundColor: c.fg },
  warmupSolid: { backgroundColor: c.fg3 },
  recordSolid: { backgroundColor: c.record },
  skippedSolid: { borderWidth: 1, borderColor: c.fg3, opacity: 0.5 },
}));
