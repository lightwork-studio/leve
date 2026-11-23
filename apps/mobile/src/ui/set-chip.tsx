import { Text, View } from "react-native";
import { setLabel } from "../model/live.ts";
import type { WorkoutSet } from "../model/types.ts";
import { font } from "../theme.ts";
import { themedStyles, useStyles } from "./themed.ts";

export { setLabel, setNumbers } from "../model/live.ts";

export function SetChip({
  type,
  number,
  highlighted = false,
}: {
  type: WorkoutSet["type"];
  number: number;
  highlighted?: boolean;
}) {
  const styles = useStyles(sheet);
  const label = setLabel(type, number);
  return (
    <View
      style={[
        styles.chip,
        highlighted && styles.highlighted,
        type === "warmup" && styles.chipWarmup,
        type === "drop" && styles.chipDrop,
      ]}
    >
      <Text
        style={[
          styles.chipText,
          type === "warmup" && styles.chipWarmupText,
          type === "drop" && styles.chipDropText,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  chip: {
    width: 32,
    height: 28,
    borderRadius: 8,
    backgroundColor: c.s2,
    alignItems: "center",
    justifyContent: "center",
  },
  highlighted: { backgroundColor: c.bg },
  chipWarmup: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.line2,
  },
  chipText: { ...font.bodySemi, fontSize: 13, color: c.fg },
  chipWarmupText: { color: c.fg2 },
  chipDrop: { backgroundColor: c.s1, borderWidth: 1.5, borderColor: c.fg },
  chipDropText: { color: c.fg },
}));
