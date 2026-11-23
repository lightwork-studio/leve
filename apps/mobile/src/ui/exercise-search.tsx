import { type ReactNode, useState } from "react";
import { choiceLabel } from "../data/custom-exercises.ts";
import { Chip, ChipRow, SearchField } from "./search-field.tsx";

/** Searching exercises by name (or muscle, in the picker), with ✕ to clear. */
export function ExerciseSearch({
  value,
  onChange,
  placeholder = "Search exercises",
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <SearchField
      label="Search exercises"
      clearLabel="Clear exercise search"
      placeholder={placeholder}
      value={value}
      onChangeText={onChange}
    />
  );
}

export function ExerciseFilters({
  value,
  onChange,
  searching,
  muscle,
  children,
}: {
  searching: boolean;
  muscle: string;
  children: ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <ChipRow label="Exercise filters">
        {searching && (
          <Chip
            label={muscle ? choiceLabel(muscle) : "Muscles"}
            accessibilityLabel={"Muscle filter, " + (muscle ? choiceLabel(muscle) : "All muscles")}
            on={!!muscle || expanded}
            onPress={() => setExpanded(!expanded)}
          />
        )}
        {["Cable", "Dumbbell", "Machine"].map((label) => (
          <Chip
            key={label}
            label={label}
            accessibilityLabel={"Filter by " + label.toLowerCase()}
            on={value === label}
            onPress={() => onChange(value === label ? "" : label)}
          />
        ))}
      </ChipRow>
      {(!searching || expanded) && children}
    </>
  );
}
