import { Text, View } from "react-native";
import { radius, type } from "../theme.ts";
import { CommitButton } from "./commit-button.tsx";
import { ForwardIcon, PlusIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** A routine offered as the one to do next. */
export interface SuggestedRoutine {
  id: string;
  title: string;
}

/**
 * Train's main action: start a workout. Without a suggested routine it starts an empty workout.
 * With one, the vermilion button starts that routine and a small tile beside it starts an empty
 * workout instead.
 */
export function StartActions({
  suggested,
  onStart,
}: {
  suggested?: SuggestedRoutine | null;
  onStart: (routineId?: string) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const arrow = <ForwardIcon color={c.commitInk} size={26} />;
  if (!suggested) {
    return (
      <CommitButton
        variant="slot"
        label="Start"
        title="Empty workout"
        accessibilityLabel="Start empty workout"
        icon={arrow}
        onPress={() => onStart()}
      />
    );
  }
  return (
    <View style={styles.row}>
      <View style={styles.main}>
        <CommitButton
          variant="slot"
          label="Start · up next"
          title={suggested.title}
          accessibilityLabel={`Start ${suggested.title}, up next`}
          icon={arrow}
          onPress={() => onStart(suggested.id)}
        />
      </View>
      <Tap
        accessibilityRole="button"
        accessibilityLabel="Start empty workout"
        onPress={() => onStart()}
        scaleTo={0.96}
        style={styles.empty}
      >
        <PlusIcon color={c.fg} size={20} />
        <Text style={styles.emptyLabel}>Empty</Text>
      </Tap>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  row: { flexDirection: "row", gap: 10 },
  main: { flex: 1, minWidth: 0 },
  empty: {
    width: 70,
    height: 70,
    borderRadius: radius.card,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    boxShadow: c.shadow,
  },
  emptyLabel: { ...type.labelSmall, color: c.fg2 },
}));
