import { Text, View } from "react-native";
import { RIR_PICKS } from "../../model/rir.ts";
import { numeral, radius, type } from "../../theme.ts";
import { Tap } from "../tap.tsx";
import { themedStyles, useStyles } from "../themed.ts";

/**
 * Reps in reserve as one strip of whole numbers, 0 to 4 and 5+. A number records it; 5+ opens the
 * pad on the set's RIR (5 when it has none) for anything up to 10, recorded only on Done. `bone`
 * draws it as the top band of the rest timer, in the timer's ink over its draining fill; `plain` is
 * a joined strip on the dock or under a row.
 */
export function RirPicks({
  tone,
  label,
  value,
  onPick,
  onMore,
}: {
  tone: "bone" | "plain";
  /** "Reps in reserve for set 2" */
  label: string;
  /** The set's RIR now, to show which pick it is. */
  value: number | null;
  onPick: (value: number) => void;
  onMore: () => void;
}) {
  const styles = useStyles(sheet);
  const bone = tone === "bone";
  const chosen = value === null ? null : Math.min(value, 5);
  return (
    <View
      role="group"
      aria-label={label}
      accessibilityLabel={label}
      style={bone ? styles.band : styles.strip}
    >
      {RIR_PICKS.map((pick, i) => {
        const more = pick === 5;
        const on = chosen === pick;
        return (
          <Tap
            key={pick}
            accessibilityRole="button"
            accessibilityLabel={
              more ? "5 or more: opens the number pad" : `${pick} reps in reserve`
            }
            accessibilityState={{ selected: on }}
            onPress={() => (more ? onMore() : onPick(pick))}
            scaleTo={0.94}
            style={[styles.pick, on && !bone && styles.pickOn]}
          >
            {i > 0 && <View style={[styles.divider, bone ? styles.dividerBone : null]} />}
            <Text style={[styles.number, bone ? styles.numberBone : null, on && styles.numberOn]}>
              {pick}
              {more ? <Text style={[styles.plus, bone ? styles.plusBone : null]}>+</Text> : null}
            </Text>
          </Tap>
        );
      })}
    </View>
  );
}

/** The line over the picks: what is asked, about which set, and Skip, which records nothing. */
export function RirQuestion({ about, onSkip }: { about: string; onSkip: () => void }) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.question}>
      <Text style={styles.asked} numberOfLines={1}>
        <Text style={styles.askedStrong}>RIR</Text>
        {` · ${about}`}
      </Text>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Skip, no reps in reserve for ${about.split(" · ")[0]}`}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 8 }}
        onPress={onSkip}
        style={styles.skip}
      >
        <Text style={styles.skipText}>Skip</Text>
      </Tap>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  band: { flexDirection: "row", height: 46 },
  strip: {
    flexDirection: "row",
    height: 44,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: c.line2,
    overflow: "hidden",
  },
  pick: { flex: 1, alignItems: "center", justifyContent: "center" },
  pickOn: { backgroundColor: c.s3 },
  divider: {
    position: "absolute",
    left: 0,
    top: 10,
    bottom: 10,
    width: 1,
    backgroundColor: c.line2,
  },
  dividerBone: { top: 13, bottom: 13, backgroundColor: c.rest.ink, opacity: 0.18 },
  number: { ...numeral(20, "300"), color: c.fg },
  numberBone: { color: c.rest.ink },
  numberOn: { fontWeight: "400" },
  plus: { fontSize: 13, color: c.fg2 },
  plusBone: { color: c.rest.ink, opacity: 0.8 },
  question: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    minHeight: 20,
    paddingHorizontal: 4,
    paddingBottom: 9,
  },
  asked: { ...type.label, color: c.fg2, flexShrink: 1 },
  askedStrong: { color: c.fg, fontWeight: "600" },
  skip: {
    minHeight: 20,
    justifyContent: "center",
    paddingHorizontal: 2,
    borderRadius: radius.chip,
  },
  skipText: { ...type.action, fontSize: 10, letterSpacing: 1.4, color: c.fg2 },
}));
