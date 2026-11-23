import type { WeightUnit } from "@leve/core";
import { useMemo, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { measurementClock } from "../model/measurement-clock.ts";
import { numeral, radius, space, touch, type } from "../theme.ts";
import { Button } from "./buttons.tsx";
import { FieldError, TextField } from "./field.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

interface LocalEntry {
  day: string;
  time: string;
  instant?: number;
}

/**
 * Entering a bodyweight: the value large in a readout cell, then (for a new one) when it was
 * measured: now, or an earlier date and 24-hour time typed in, with a choice of which time when
 * the clocks went back and it happened twice. In a sheet, the sheet's own Cancel closes it.
 */
export function BodyweightEditor({
  label,
  unit,
  initialText,
  onCancel,
  onSave,
  inSheet = false,
}: {
  label: string;
  unit: WeightUnit;
  initialText?: string;
  onCancel: () => void;
  onSave: (text: string, measuredAt?: Date) => void;
  inSheet?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [text, setText] = useState(initialText ?? "");
  const [earlier, setEarlier] = useState<LocalEntry | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = useMemo(() => measurementClock(zone), [zone]);
  const instants = earlier ? clock.choices(earlier.day, earlier.time) : [];
  const inputLabel = earlier ? "Bodyweight" : label;
  const [error, setError] = useState("");
  const submitted = useRef(false);
  const save = () => {
    if (submitted.current) return;
    submitted.current = true;
    try {
      if (initialText !== undefined && text === initialText) onCancel();
      else if (earlier) {
        if (!instants.length) throw new Error("Enter a valid local date and time.");
        const measured =
          instants.length === 1 ? instants[0] : instants.find(({ at }) => at === earlier.instant);
        if (!measured) throw new Error("Choose which occurrence of this time to record.");
        if (measured.at > Date.now()) throw new Error("Choose a measurement time in the past.");
        onSave(text, new Date(measured.at));
      } else onSave(text);
    } catch (problem) {
      submitted.current = false;
      setError(problem instanceof Error ? problem.message : "Couldn't save bodyweight.");
    }
  };
  return (
    <View style={styles.form}>
      <View style={styles.cell}>
        <Text style={styles.label}>
          {inputLabel} · {unit}
        </Text>
        <TextInput
          autoFocus
          selectTextOnFocus
          keyboardType="decimal-pad"
          accessibilityLabel={`${inputLabel} in ${unit}`}
          placeholder="0.0"
          placeholderTextColor={c.fg3}
          style={styles.value}
          value={text}
          onChangeText={(value) => {
            setText(value);
            setError("");
          }}
          returnKeyType="done"
          onSubmitEditing={save}
        />
      </View>
      {initialText === undefined && (
        <Tap
          accessibilityRole="button"
          accessibilityState={{ expanded: earlier !== null }}
          style={styles.timeButton}
          onPress={() => {
            const now = clock.localTimestamp(Date.now());
            setEarlier(earlier ? null : { day: now.slice(0, 10), time: now.slice(11, 16) });
            setError("");
          }}
        >
          <Text style={styles.timeAction}>
            {earlier ? "Use current time" : "Earlier measurement"}
          </Text>
        </Tap>
      )}
      {earlier && (
        <View style={styles.when}>
          <View style={styles.whenFields}>
            <TextField
              label="Date · YYYY-MM-DD"
              spokenLabel="Measurement date"
              accessibilityHint="Enter the year, month and day as YYYY-MM-DD."
              placeholder="YYYY-MM-DD"
              mono
              style={styles.date}
              value={earlier.day}
              onChangeText={(day) => {
                setEarlier({ day, time: earlier.time });
                setError("");
              }}
            />
            <TextField
              label="Time · 24 h"
              spokenLabel="Local measurement time"
              accessibilityHint="Enter hours and minutes using the 24-hour clock."
              placeholder="HH:mm"
              mono
              style={styles.time}
              value={earlier.time}
              onChangeText={(time) => {
                setEarlier({ day: earlier.day, time });
                setError("");
              }}
              returnKeyType="done"
              onSubmitEditing={save}
            />
          </View>
          {instants.length > 1 && (
            <View style={styles.repeated}>
              <Text style={styles.label}>Clocks went back. Which time did you measure?</Text>
              <View accessibilityRole="radiogroup" style={styles.choices}>
                {instants.map(({ at: instant, offset }, index) => {
                  const selected = earlier.instant === instant;
                  const option = `${index === 0 ? "First" : "Second"} time (${offset})`;
                  return (
                    <Tap
                      key={instant}
                      accessibilityRole="radio"
                      accessibilityLabel={option}
                      accessibilityState={{ checked: selected }}
                      style={[styles.choice, selected && styles.chosen]}
                      onPress={() => {
                        setEarlier({ ...earlier, instant });
                        setError("");
                      }}
                    >
                      <Text style={[styles.choiceLabel, selected && styles.chosenLabel]}>
                        {option}
                      </Text>
                    </Tap>
                  );
                })}
              </View>
            </View>
          )}
        </View>
      )}
      <FieldError message={error} />
      <View style={styles.actions}>
        {!inSheet && <Button rank="text" label="Cancel" onPress={onCancel} />}
        <Button rank="primary" label="Save" onPress={save} style={styles.save} />
      </View>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  form: { padding: space.lg, gap: space.md },
  cell: {
    backgroundColor: c.s2,
    borderWidth: 1.5,
    borderColor: c.fg,
    borderRadius: 18,
    paddingTop: 12,
    paddingBottom: 6,
    paddingHorizontal: 14,
    gap: 4,
  },
  label: { ...type.label, color: c.fg3 },
  value: { ...numeral(56), color: c.fg, paddingVertical: 4, minHeight: 64 },
  timeButton: { alignSelf: "flex-start", minHeight: touch, justifyContent: "center" },
  timeAction: { ...type.action, letterSpacing: 1.47, color: c.fg2 },
  when: { gap: space.md },
  whenFields: { flexDirection: "row", gap: 10 },
  date: { flex: 1.3 },
  time: { flex: 1 },
  repeated: { gap: 8 },
  choices: { flexDirection: "row", gap: 6 },
  choice: {
    flex: 1,
    minHeight: touch,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: space.sm,
    borderRadius: radius.input,
    borderColor: c.line2,
    borderWidth: 1,
    backgroundColor: c.s2,
  },
  chosen: { borderColor: c.fg, backgroundColor: c.fg },
  choiceLabel: { ...type.value, color: c.fg2 },
  chosenLabel: { color: c.bg },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.md,
  },
  save: { flex: 1 },
}));
