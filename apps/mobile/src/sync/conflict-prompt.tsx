import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { type Conflict, type ConflictSide, type Side, settleConflict } from "../data/conflicts.ts";
import { space, type } from "../theme.ts";
import { Button } from "../ui/buttons.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { haptic } from "../ui/haptics.ts";
import { Tap } from "../ui/tap.tsx";
import { themedStyles, useStyles } from "../ui/themed.ts";

/**
 * Goes through conflicts one at a time: the same thing changed on this phone and in the account
 * before they synced. It shows only what differs on each side, nothing chosen in advance, and
 * can't be put off: each is settled before the app goes on (but never during a workout; see
 * SyncHost).
 */
export function ConflictPrompt({ items }: { items: Conflict[] }) {
  const styles = useStyles(sheet);
  const { change } = useAppData();
  const [picked, setPicked] = useState<Side | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [settled, setSettled] = useState(0);
  const current = items[0];
  const key = current?.key;
  // A new conflict starts with nothing chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the conflict changes
  useEffect(() => {
    setPicked(null);
    setProblem(null);
  }, [key]);
  if (!current) return null;

  const keep = () => {
    if (!picked) return;
    try {
      change((store) => settleConflict(store, current, picked));
      haptic.success();
      setSettled((count) => count + 1);
    } catch (error) {
      haptic.warning();
      setProblem((error as Error).message);
    }
  };
  const confirm = picked ? current[picked].confirm : "Choose a version";
  return (
    <Dialog
      eyebrow="Changed in two places"
      label={`${current.title}: changed in two places`}
      aside={
        <Text style={styles.count}>
          {settled + 1} of {settled + items.length}
        </Text>
      }
    >
      <Text accessibilityRole="header" style={styles.title}>
        {current.title}
      </Text>
      <Text style={styles.subtitle}>
        {[current.subtitle, "Changed on this phone and in your account. Which should stay?"]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <View accessibilityRole="radiogroup" style={styles.choices}>
        <Choice
          label="On this phone"
          side={current.phone}
          selected={picked === "phone"}
          onPress={() => setPicked("phone")}
          refused="This phone's change couldn't be saved in your account."
        />
        <Choice
          label="In your account"
          side={current.account}
          selected={picked === "account"}
          onPress={() => setPicked("account")}
        />
      </View>
      {problem ? (
        <Text accessibilityRole="alert" style={styles.problem}>
          {problem}
        </Text>
      ) : null}
      <Button
        rank="primary"
        label={confirm}
        disabled={!picked}
        onPress={keep}
        style={styles.confirm}
      />
    </Dialog>
  );
}

function Choice({
  label,
  side,
  selected,
  onPress,
  refused,
}: {
  label: string;
  side: ConflictSide;
  selected: boolean;
  onPress: () => void;
  refused?: string;
}) {
  const styles = useStyles(sheet);
  const enabled = side.choosable;
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityLabel={`${label}: ${side.lines.map((line) => `${line.label} ${line.value}`).join(", ")}`}
      accessibilityState={{ checked: selected, disabled: !enabled }}
      disabled={!enabled}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      scaleTo={0.98}
      style={[styles.choice, selected && styles.choiceOn, !enabled && styles.choiceOff]}
    >
      <View style={styles.who}>
        <Text style={styles.whoText}>{label}</Text>
        {enabled ? (
          <View style={[styles.radio, selected && styles.radioOn]}>
            {selected ? <View style={styles.dot} /> : null}
          </View>
        ) : null}
      </View>
      {side.lines.map((line, index) => (
        // Lines can repeat their label (two sets of one exercise), so the index keeps them apart.
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for this conflict
        <View key={index} style={styles.line}>
          <Text style={styles.lineLabel} numberOfLines={2}>
            {line.label}
          </Text>
          <Text style={styles.lineValue} numberOfLines={3}>
            {line.value}
          </Text>
        </View>
      ))}
      {!enabled && refused ? <Text style={styles.refused}>{refused}</Text> : null}
    </Tap>
  );
}

const sheet = themedStyles((c) => ({
  count: { ...type.label, color: c.fg3 },
  title: { ...type.heading, color: c.fg, marginTop: space.sm, marginRight: 4 },
  subtitle: {
    ...type.body,
    fontSize: 14,
    lineHeight: 20,
    color: c.fg2,
    marginTop: 2,
    marginRight: 4,
  },
  choices: { gap: space.sm, marginTop: space.md, marginRight: 4 },
  choice: {
    backgroundColor: c.s2,
    borderWidth: 1.5,
    borderColor: c.line2,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 7,
  },
  choiceOn: { borderColor: c.fg },
  choiceOff: { opacity: 0.6 },
  who: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  whoText: { ...type.label, color: c.fg3 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { borderColor: c.fg },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.fg },
  line: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  lineLabel: { ...type.body, fontSize: 15, lineHeight: 20, color: c.fg2, flexShrink: 1 },
  lineValue: {
    ...type.body,
    fontSize: 15,
    lineHeight: 20,
    color: c.fg,
    textAlign: "right",
    flexShrink: 1,
  },
  refused: { ...type.body, fontSize: 13, lineHeight: 18, color: c.fg3 },
  problem: { ...type.body, fontSize: 14, lineHeight: 20, color: c.alert, marginTop: space.sm },
  confirm: { marginTop: space.md, marginRight: -4 },
}));
