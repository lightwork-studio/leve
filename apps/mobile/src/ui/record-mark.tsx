import { View } from "react-native";
import { themedStyles, useStyles } from "./themed.ts";

/** The brass diamond beside a personal record. Decoration only: say "record" in the label. */
export function RecordMark({ small = false, tiny = false }: { small?: boolean; tiny?: boolean }) {
  const styles = useStyles(sheet);
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, small && styles.small, tiny && styles.tiny]}
    />
  );
}

const sheet = themedStyles((c) => ({
  mark: {
    width: 8,
    height: 8,
    borderRadius: 1,
    backgroundColor: c.record,
    transform: [{ rotate: "45deg" }],
  },
  small: { width: 6, height: 6 },
  tiny: { width: 4, height: 4, borderRadius: 0.5 },
}));
