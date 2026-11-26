import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
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
 * can't be put off: each is settled before the app goes on (but never during a workout logged on
 * this phone; see SyncHost). When this phone's version can't be kept yet (a server that needs an
 * update, a change it refused), pausing sync is the other way out: it keeps this phone's version
 * here, and every screen says sync is paused until it is resumed.
 */
export function ConflictPrompt({
  items,
  onReview,
  onPause,
}: {
  items: Conflict[];
  /** Opens the screen a conflict is reviewed on (see Conflict.review). */
  onReview: (item: Conflict) => void;
  /** Pauses sync, for a conflict whose phone version can't be kept yet. */
  onPause: () => void;
}) {
  const styles = useStyles(sheet);
  const { change, exportData } = useAppData();
  const [picked, setPicked] = useState<Side | null>(null);
  /** The picked side loses work kept nowhere else: its warning is showing, asking once more. */
  const [warned, setWarned] = useState(false);
  const [copy, setCopy] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [settled, setSettled] = useState(0);
  const { height } = useWindowDimensions();
  const current = items[0];
  // A new conflict, or the same one changed while shown, starts with nothing chosen.
  const shown = current ? JSON.stringify(current) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when what's shown changes
  useEffect(() => {
    setPicked(null);
    setWarned(false);
  }, [shown]);
  // Why a choice was refused stays until the next conflict, so it's seen with the fresh view.
  const key = current?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only for another conflict
  useEffect(() => {
    setProblem(null);
    setCopy("idle");
  }, [key]);
  /** When the warning came up: a press right after (a double tap) doesn't count as the second. */
  const warnedAt = useRef(0);
  if (!current) return null;

  const keep = () => {
    if (!picked) return;
    // Work kept nowhere else: say so and offer a copy before it goes.
    if (current[picked].warning && !warned) {
      warnedAt.current = Date.now();
      setWarned(true);
      return;
    }
    if (warned && Date.now() - warnedAt.current < 600) return;
    if (copy === "busy") return;
    try {
      change((store) => settleConflict(store, current, picked));
      haptic.success();
      setSettled((count) => count + 1);
    } catch (error) {
      haptic.warning();
      // Look again before choosing: nothing stays picked, and the latest versions are shown.
      setPicked(null);
      setProblem((error as Error).message);
      change(() => undefined);
    }
  };
  const saveCopy = async () => {
    if (copy === "busy") return;
    setCopy("busy");
    try {
      await exportData();
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  };
  const warning = picked && warned ? current[picked].warning : undefined;
  const confirm = picked
    ? warning
      ? `${current[picked].confirm} for good`
      : current[picked].confirm
    : "Choose a version";
  // This phone's version can't be kept now, or only tried again: keeping it on the phone means
  // pausing sync.
  const stuck = !current.phone.choosable || !!current.phone.retry;
  if (current.review) {
    // Settled on the workout's own review: the popup says what happened and leads there.
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
          {[current.subtitle, current.review.message].filter(Boolean).join(" · ")}
        </Text>
        <Button
          rank="primary"
          label="Review it"
          onPress={() => onReview(current)}
          style={styles.confirm}
        />
      </Dialog>
    );
  }
  return (
    <Dialog
      eyebrow="Changed in two places"
      label={`${current.title}: changed in two places`}
      aside={
        <Text style={styles.count}>
          {settled + 1} of {settled + items.length}
        </Text>
      }
      footer={
        stuck ? (
          <View style={styles.pause}>
            <Text style={styles.pauseText}>
              Or keep this phone's version here for now: pausing sync stops all syncing until you
              resume it.
            </Text>
            <Button rank="text" label="Pause sync" onPress={onPause} />
          </View>
        ) : undefined
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
      {/* A big workout can hold many lines: they scroll, and the confirm stays in reach. */}
      <ScrollView
        style={{ maxHeight: Math.round(height * 0.5) }}
        contentContainerStyle={styles.choices}
        accessibilityRole="radiogroup"
      >
        <Choice
          label="On this phone"
          side={current.phone}
          selected={picked === "phone"}
          onPress={() => {
            setPicked("phone");
            setWarned(false);
          }}
        />
        <Choice
          label="In your account"
          side={current.account}
          selected={picked === "account"}
          onPress={() => {
            setPicked("account");
            setWarned(false);
          }}
        />
      </ScrollView>
      {problem ? (
        <Text accessibilityRole="alert" style={styles.problem}>
          {problem}
        </Text>
      ) : null}
      {warning ? (
        <View style={styles.warning}>
          <Text accessibilityRole="alert" style={styles.problem}>
            {warning}
          </Text>
          <Button
            rank="text"
            label={copy === "busy" ? "Saving a copy…" : "Save a copy first"}
            busy={copy === "busy"}
            onPress={saveCopy}
          />
          {copy === "done" || copy === "failed" ? (
            <Text style={styles.pauseText}>
              {copy === "done" ? "A copy is saved." : "The copy wasn't saved. Try again."}
            </Text>
          ) : null}
        </View>
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
}: {
  label: string;
  side: ConflictSide;
  selected: boolean;
  onPress: () => void;
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
      {!enabled && side.why ? <Text style={styles.refused}>{side.why}</Text> : null}
      {enabled && side.retry ? <Text style={styles.refused}>{side.retry}</Text> : null}
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
  choices: { gap: space.sm, paddingTop: space.md, marginRight: 4 },
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
  pause: { alignItems: "center", gap: 2 },
  warning: { alignItems: "center", gap: 2 },
  pauseText: {
    ...type.body,
    fontSize: 13,
    lineHeight: 18,
    color: c.fg3,
    textAlign: "center",
    marginTop: space.xs,
  },
}));
