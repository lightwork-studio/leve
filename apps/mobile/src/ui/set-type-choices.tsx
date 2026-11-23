import type { SetType } from "@leve/core";
import { Text, View } from "react-native";
import { font, radius, space } from "../theme.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useStyles } from "./themed.ts";

export const setTypeNames = {
  normal: "Working",
  warmup: "Warm-up",
  drop: "Drop",
  failure: "Failure",
} as const;

export function SetTypeChoices({
  value,
  onChange,
}: {
  value: SetType;
  onChange: (type: SetType) => void;
}) {
  const styles = useStyles(sheet);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Set type" style={styles.choices}>
      {(Object.keys(setTypeNames) as SetType[]).map((type) => (
        <Tap
          key={type}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === type }}
          onPress={() => onChange(type)}
          style={[styles.choice, value === type && styles.selected]}
        >
          <Text style={[styles.label, value === type && styles.selectedLabel]}>
            {setTypeNames[type]}
          </Text>
        </Tap>
      ))}
    </View>
  );
}
const sheet = themedStyles((c) => ({
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  choice: {
    backgroundColor: c.s2,
    borderRadius: radius.chip,
    padding: space.md,
    minHeight: 44,
  },
  selected: { backgroundColor: c.fg },
  selectedLabel: { color: c.bg },
  label: { ...font.bodySemi, fontSize: 16, color: c.fg },
}));
