import { useState } from "react";
import { Text, View } from "react-native";
import { font, numeral, radius } from "../../theme.ts";
import { Segmented } from "../chart-controls.tsx";
import { Dialog } from "../dialog.tsx";
import { DeleteIcon } from "../icons.tsx";
import { Tap } from "../tap.tsx";
import { themedStyles, useColors, useStyles } from "../themed.ts";
import { clock } from "../use-ticker.ts";

/** Rest lengths offered at a tap for an exercise, in seconds. Off follows them. */
export const REST_PRESETS = [45, 60, 90, 120, 150, 180, 240, 300] as const;
/** The longest rest an exercise can have (see parseRestSeconds). */
const MAX_REST = 3600;
/** The grid's width, in cells. */
const COLUMNS = 4;

const restText = (seconds: number) => (seconds === 0 ? "Off" : clock(seconds));

/** Typed digits as seconds: the last two digits are seconds (130 is 1:30), at most 59 of them. */
export function typedRest(digits: string): number {
  const n = Number(digits || "0");
  return Math.min(MAX_REST, Math.floor(n / 100) * 60 + Math.min(59, n % 100));
}

/** Cells laid out in rows of four columns; a wide cell takes two. */
export function gridRows<T extends { wide?: boolean }>(cells: readonly T[]): (T | null)[][] {
  const rows: (T | null)[][] = [];
  let row: (T | null)[] = [];
  let used = 0;
  // Empty places keep a short row's cells the width of the ones in a full row.
  const close = () => {
    for (; used < COLUMNS; used++) row.push(null);
    rows.push(row);
    row = [];
    used = 0;
  };
  for (const cell of cells) {
    const span = cell.wide ? 2 : 1;
    if (used + span > COLUMNS) close();
    row.push(cell);
    used += span;
  }
  if (row.length) close();
  return rows;
}

interface Cell {
  key: string;
  wide?: boolean;
  label: string;
  /** Text that isn't a number: Off, and the delete key. */
  word?: boolean;
  checked?: boolean;
  onPress: () => void;
}

/**
 * A small dialog for a rest length: pick a common length, Off among them, or type one as minutes
 * and seconds, nudge it by 15 seconds, then Set. Off turns the rest timer off.
 */
export function RestDialog({
  title,
  note,
  initialSeconds,
  left,
  presets = REST_PRESETS,
  onSet,
  onClose,
}: {
  /** What the rest is for: the exercise's name, or "Default rest". */
  title: string;
  /** What Set changes, in a few words. */
  note: string;
  initialSeconds: number;
  /** For a running rest, the time it has left. */
  left?: string;
  /** The lengths offered at a tap, shortest first. Off always follows them. */
  presets?: readonly number[];
  onSet: (seconds: number) => void;
  onClose: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [seconds, setSeconds] = useState(initialSeconds);
  const [mode, setMode] = useState<"pick" | "type">("pick");
  const [digits, setDigits] = useState<string | null>(null);
  const shown = mode === "type" && digits ? clock(typedRest(digits)) : restText(seconds);
  const type = (key: string) => {
    let next = digits ?? "";
    if (key === "del") next = next.slice(0, -1);
    else if (next.length < 4) next = `${next}${key}`.replace(/^0+/, "");
    else return;
    setDigits(next);
    setSeconds(typedRest(next));
  };
  const nudge = (by: number) => {
    setSeconds((s) => Math.max(0, Math.min(MAX_REST, s + by)));
    setDigits(null);
  };
  const cells: Cell[] =
    mode === "pick"
      ? [
          ...presets.map((preset) => ({
            key: String(preset),
            label: clock(preset),
            checked: preset === seconds,
            onPress: () => setSeconds(preset),
          })),
          {
            key: "off",
            wide: true,
            word: true,
            label: "Off",
            checked: seconds === 0,
            onPress: () => setSeconds(0),
          },
        ]
      : [
          ...[..."1234567890"].map((key) => ({ key, label: key, onPress: () => type(key) })),
          { key: "del", wide: true, word: true, label: "Delete", onPress: () => type("del") },
        ];
  return (
    <Dialog
      eyebrow={`Rest timer · ${title}`}
      label="Rest time"
      onClose={onClose}
      aside={
        <View style={styles.modes}>
          <Segmented
            kind="choice"
            label="Choose or type"
            value={mode}
            onChange={(next) => {
              setMode(next);
              setDigits(null);
            }}
            options={[
              { value: "pick", label: "Pick" },
              { value: "type", label: "Type" },
            ]}
          />
        </View>
      }
      confirm={{
        label: `Set ${restText(seconds)}`,
        accessibilityLabel: `Set rest to ${restText(seconds)}`,
        onPress: () => onSet(seconds),
      }}
    >
      <View style={styles.readRow}>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="15 seconds less"
          onPress={() => nudge(-15)}
          style={styles.nudge}
        >
          <Text style={styles.nudgeText}>−15</Text>
        </Tap>
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`Rest ${shown}. Type a time`}
          onPress={() => {
            setMode("type");
            setDigits(null);
          }}
          scaleTo={1}
          style={[styles.value, mode === "type" && styles.valueOn]}
        >
          <Text style={styles.valueText} accessibilityLiveRegion="polite">
            {shown}
          </Text>
          <Text style={styles.eyebrow}>{mode === "type" ? "type m:ss" : "m:ss"}</Text>
        </Tap>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="15 seconds more"
          onPress={() => nudge(15)}
          style={styles.nudge}
        >
          <Text style={styles.nudgeText}>+15</Text>
        </Tap>
      </View>
      <Text style={styles.note}>
        {left ? `${left} left · ` : ""}
        {note}
      </Text>
      <View accessibilityRole={mode === "pick" ? "radiogroup" : undefined} style={styles.grid}>
        {gridRows(cells).map((row) => (
          <View key={row.map((cell, i) => cell?.key ?? `gap${i}`).join()} style={styles.gridRow}>
            {row.map((cell, i) =>
              cell ? (
                <Tap
                  key={cell.key}
                  accessibilityRole={mode === "pick" ? "radio" : "button"}
                  accessibilityLabel={cell.label}
                  {...(mode === "pick" ? { accessibilityState: { checked: !!cell.checked } } : {})}
                  onPress={cell.onPress}
                  style={[styles.cell, cell.wide && styles.cellWide, cell.checked && styles.cellOn]}
                >
                  {cell.key === "del" ? (
                    <DeleteIcon color={c.fg2} size={18} />
                  ) : (
                    <Text
                      style={[
                        cell.word ? styles.wordText : styles.cellText,
                        cell.checked && styles.cellTextOn,
                      ]}
                    >
                      {cell.label}
                    </Text>
                  )}
                </Tap>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: empty places only hold the row's width.
                <View key={`gap${i}`} style={styles.gap} />
              ),
            )}
          </View>
        ))}
      </View>
    </Dialog>
  );
}

const sheet = themedStyles((c) => ({
  modes: { width: 132 },
  eyebrow: { ...font.mono, fontSize: 10.5, letterSpacing: 1.47, color: c.fg3 },
  readRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: -6,
    paddingTop: 14,
    paddingBottom: 6,
  },
  nudge: {
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  nudgeText: { ...font.monoSemi, fontSize: 12, color: c.fg },
  value: {
    flex: 1,
    minWidth: 0,
    height: 96,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  valueOn: { backgroundColor: c.bg, borderWidth: 1.5, borderColor: c.fg },
  valueText: { ...numeral(66), lineHeight: 64, color: c.fg },
  note: {
    ...font.mono,
    fontSize: 11,
    lineHeight: 15,
    color: c.fg2,
    textAlign: "center",
    paddingTop: 2,
    paddingBottom: 12,
  },
  grid: { gap: 6, marginLeft: -6 },
  gridRow: { flexDirection: "row", gap: 6 },
  cell: {
    flexGrow: 1,
    flexBasis: 0,
    height: 48,
    borderRadius: radius.input,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  // Two cells and the gap between them.
  cellWide: { flexGrow: 2, flexBasis: 6 },
  gap: { flexGrow: 1, flexBasis: 0 },
  cellOn: { backgroundColor: c.fg, borderColor: c.fg },
  cellText: { ...numeral(21, "300"), color: c.fg },
  wordText: { ...font.monoSemi, fontSize: 11, letterSpacing: 1.1, color: c.fg2 },
  cellTextOn: { color: c.bg },
}));
