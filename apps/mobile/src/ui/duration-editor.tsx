import { useState } from "react";
import { View } from "react-native";
import { durationEnd } from "../data/workout-actions.ts";
import { parseTyped } from "../model/log-values.ts";
import { space } from "../theme.ts";
import { BottomSheet } from "./bottom-sheet.tsx";
import { Button } from "./buttons.tsx";
import { FieldError, TextField } from "./field.tsx";
import { durationLabel } from "./format.ts";
import { CheckIcon } from "./icons.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** A workout's duration as typed, in seconds, or an error saying how to type it. */
export function parseWorkoutDuration(text: string): number {
  const seconds = parseTyped("duration", text, "kg");
  if (seconds === null || seconds === "invalid")
    throw new Error("Enter a duration in minutes:seconds or hours:minutes:seconds.");
  return seconds;
}

/** The field a workout's duration is typed in, wherever it can be changed. */
export function DurationField({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (text: string) => void;
}) {
  return (
    <TextField
      label="Duration · h:mm:ss or m:ss"
      spokenLabel="Workout duration"
      mono
      maxLength={14}
      value={value}
      onChangeText={onChangeText}
    />
  );
}

/**
 * Sets how long a workout that is still running will have lasted when it is saved. It follows
 * the same rules as a saved workout's duration: it can't end before the start or after now.
 */
export function DurationSheet({
  startedAt,
  seconds,
  onSet,
  onClose,
}: {
  startedAt: string;
  /** What the field starts with. */
  seconds: number;
  onSet: (seconds: number) => void;
  onClose: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [text, setText] = useState(() => durationLabel(seconds));
  const [error, setError] = useState("");
  const set = () => {
    try {
      const typed = parseWorkoutDuration(text);
      durationEnd(startedAt, typed);
      onSet(typed);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <BottomSheet
      title="Duration"
      eyebrow="This workout"
      onClose={onClose}
      footer={
        <>
          <FieldError message={error} />
          <Button
            rank="primary"
            label="Set duration"
            icon={<CheckIcon color={c.bg} size={16} strokeWidth={2.4} />}
            onPress={set}
          />
        </>
      }
    >
      <View style={styles.content}>
        <DurationField
          value={text}
          onChangeText={(value) => {
            setText(value);
            setError("");
          }}
        />
      </View>
    </BottomSheet>
  );
}

const sheet = themedStyles(() => ({
  content: { paddingHorizontal: space.lg, paddingTop: space.xs },
}));
