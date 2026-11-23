import { View } from "react-native";
import { themedStyles, useStyles } from "./themed.ts";

/** The brass diamond beside a personal record. Decoration only: say "record" in the label. */
export function RecordMark({ small = false }: { small?: boolean }) {
  const styles = useStyles(sheet);
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.mark, small && styles.small]}
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
}));
