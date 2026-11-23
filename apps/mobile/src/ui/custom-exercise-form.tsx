import {
  EQUIPMENT,
  type Equipment,
  EXERCISE_TYPES,
  type ExerciseType,
  isRepBased,
  MUSCLE_GROUPS,
  type MuscleGroup,
} from "@leve/core";
import { useRef, useState } from "react";
import { View } from "react-native";
import { type CustomExerciseDraft, choiceLabel } from "../data/custom-exercises.ts";
import { space } from "../theme.ts";
import { Button } from "./buttons.tsx";
import { ChoiceRow, ToggleRow } from "./choice-row.tsx";
import { TYPE_NAMES } from "./exercise-metrics.ts";
import { FieldError, TextField } from "./field.tsx";
import { Group } from "./group.tsx";
import { CheckIcon } from "./icons.tsx";
import { Chip, ChipRow } from "./search-field.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * A new exercise of the user's own: its name, then its type (fixed once created), equipment and
 * primary muscle as rows that open their lists, whether its volume counts the full bodyweight, and
 * its secondary muscles as chips.
 */
export function CustomExerciseForm({
  initialName,
  onSave,
}: {
  initialName: string;
  onSave: (draft: CustomExerciseDraft) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const submitted = useRef(false);
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<ExerciseType>("weight_reps");
  const [equipment, setEquipment] = useState<Equipment>("none");
  const [primary, setPrimary] = useState<MuscleGroup>("other");
  const [secondary, setSecondary] = useState<MuscleGroup[]>([]);
  const [usesBodyweight, setUsesBodyweight] = useState(false);
  const [error, setError] = useState("");
  const options = <T extends string>(values: readonly T[], nameOf: (value: T) => string) =>
    values.map((value) => ({ value, label: nameOf(value) }));
  return (
    <View style={styles.form}>
      <View style={styles.name}>
        <TextField label="Exercise name" value={name} onChangeText={setName} />
      </View>
      <Group>
        <ChoiceRow
          label="Exercise type"
          hint="Fixed after creation"
          value={type}
          choices={options(EXERCISE_TYPES, (v) => TYPE_NAMES[v])}
          onChoose={setType}
        />
        <ChoiceRow
          label="Equipment"
          value={equipment}
          choices={options(EQUIPMENT, choiceLabel)}
          onChoose={setEquipment}
          divider
        />
        <ChoiceRow
          label="Primary muscle"
          value={primary}
          choices={options(MUSCLE_GROUPS, choiceLabel)}
          onChoose={(v) => {
            setPrimary(v);
            setSecondary(secondary.filter((m) => m !== v));
          }}
          divider
        />
        {isRepBased(type) && (
          <ToggleRow
            label="Count full bodyweight in volume"
            on={usesBodyweight}
            onChange={setUsesBodyweight}
            divider
          />
        )}
      </Group>
      <Group label="Secondary muscles" aside={String(secondary.length)} style={styles.chipsGroup}>
        <View style={styles.chips}>
          <ChipRow wrap label="Secondary muscles" style={styles.chipRow}>
            {MUSCLE_GROUPS.filter((m) => m !== primary).map((muscle) => (
              <Chip
                key={muscle}
                label={choiceLabel(muscle)}
                on={secondary.includes(muscle)}
                onPress={() =>
                  setSecondary(
                    secondary.includes(muscle)
                      ? secondary.filter((m) => m !== muscle)
                      : [...secondary, muscle],
                  )
                }
              />
            ))}
          </ChipRow>
        </View>
      </Group>
      <View style={styles.foot}>
        <FieldError message={error} />
        <Button
          rank="primary"
          label="Create exercise"
          icon={<CheckIcon color={c.bg} size={16} strokeWidth={2.4} />}
          onPress={() => {
            if (submitted.current) return;
            submitted.current = true;
            try {
              onSave({
                name,
                type,
                equipment,
                primaryMuscle: primary,
                secondaryMuscles: secondary,
                usesBodyweight: isRepBased(type) && usesBodyweight,
              });
            } catch (e) {
              submitted.current = false;
              setError(e instanceof Error ? e.message : "Could not save the exercise.");
            }
          }}
        />
      </View>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  form: { paddingTop: space.xs, paddingBottom: space.xl },
  name: { paddingHorizontal: space.xl, paddingBottom: space.lg },
  chipsGroup: { marginHorizontal: 0 },
  chips: { paddingVertical: 12, backgroundColor: c.s1 },
  chipRow: { paddingHorizontal: 12 },
  foot: { paddingHorizontal: 14, gap: space.sm },
}));
