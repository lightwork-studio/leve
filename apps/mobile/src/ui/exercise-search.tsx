import { type MouseEvent, type ReactNode, useState } from "react";
import { type BlurEvent, Platform } from "react-native";
import { choiceLabel } from "../data/custom-exercises.ts";
import { Chip, ChipRow, SearchField } from "./search-field.tsx";

// React Native Web supplies a DOM focus event. Native blur has no related target.
function staysInExerciseSearch(event: object | undefined) {
  return (
    event &&
    "relatedTarget" in event &&
    typeof Element !== "undefined" &&
    event.relatedTarget instanceof Element &&
    event.relatedTarget.closest("[data-exercise-search]")
  );
}

export function keepExerciseSearchFocused(focused: boolean, setFocused: (value: boolean) => void) {
  if (!focused || Platform.OS !== "web") return {};
  return {
    dataSet: { exerciseSearch: true },
    onBlur(event: BlurEvent) {
      if (!staysInExerciseSearch(event)) setFocused(false);
    },
    // A pointer press blurs the input before the click, which can move the control being tapped.
    onMouseDown(event: MouseEvent) {
      if (
        event.button === 0 &&
        event.target instanceof Element &&
        event.target.closest("button, a, [role=button], [role=checkbox], [role=radio], [role=img]")
      ) {
        event.preventDefault();
      }
    },
  };
}

/** Searching exercises by name (or muscle, in the picker), with ✕ to clear. */
export function ExerciseSearch({
  value,
  onChange,
  onFocusChange,
  placeholder = "Search exercises",
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  return (
    <SearchField
      label="Search exercises"
      clearLabel="Clear exercise search"
      placeholder={placeholder}
      value={value}
      onChangeText={onChange}
      onFocus={() => onFocusChange(true)}
      onBlur={(event) => {
        if (!staysInExerciseSearch(event)) onFocusChange(false);
      }}
    />
  );
}

const equipmentFilters = ["Cable", "Dumbbell", "Machine"];

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
  // Keep the active filters together at the start of the horizontal row on short, narrow screens.
  const equipment =
    searching && value
      ? [value, ...equipmentFilters.filter((label) => label !== value)]
      : equipmentFilters;
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
        {equipment.map((label) => (
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
