import { router, useSegments } from "expo-router";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { restProgress, restTimer } from "../../data/rest-timer.ts";
import { font, numeral, type } from "../../theme.ts";
import { Enter } from "../enter.tsx";
import { CheckIcon, ForwardIcon, SkipIcon } from "../icons.tsx";
import { Tap } from "../tap.tsx";
import { themedStyles, useColors, useStyles } from "../themed.ts";
import { clock, useTicker } from "../use-ticker.ts";
import { useWorkoutPlayer } from "./use-workout-player.ts";

const DISC = 66;
const RING = 24;
const RING_LENGTH = 2 * Math.PI * RING;

/**
 * The minimised workout, above the tabs on every tab: a disc whose ring fills as sets are logged
 * (and, during rest, drains as the countdown), the workout's name, time and next set, and one
 * action: log that set, skip the rest, or finish. Tapping it opens the workout again. Otherwise
 * `fallback` (what the tab on show offers for the main-action slot) is shown.
 */
export function MiniPlayer({ fallback = null }: { fallback?: ReactNode }) {
  // Hidden while the workout itself is open (live, finishing, saved), so it appears when the
  // lifter returns to the tabs. Other pushed screens (a workout from History) leave it in place,
  // so the tabs' content doesn't jump.
  const segments: string[] = useSegments();
  const onTabs = !(
    segments[0] === "workout" && ["active", "finish", "done"].includes(segments[1] ?? "")
  );
  if (!onTabs) return null;
  return <VisibleMiniPlayer fallback={fallback} />;
}

function VisibleMiniPlayer({ fallback }: { fallback: ReactNode }) {
  const styles = useStyles(sheet);
  const c = useColors();
  const player = useWorkoutPlayer();
  const now = useTicker(!!player);
  if (!player) return fallback;
  const { store, tree, rest, target, name, title, setName, values, progress, resume, log } = player;
  const elapsed = clock((now - Date.parse(tree.workout.content.startedAt)) / 1000);
  const left = rest ? restProgress(rest, now).left : 0;
  const resting = rest !== null && left > 0;
  const restFraction = resting ? left / (rest.totalSeconds * 1000) : 0;
  return (
    // Fades in at its final position so its targets stay clear of the tabs.
    <Enter distance={0} duration={180} style={styles.mini}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Resume ${title}`}
        accessibilityHint={
          resting
            ? `Rest, ${clock(left / 1000)} left`
            : `${progress.done} of ${progress.total} sets logged`
        }
        onPress={resume}
        scaleTo={0.98}
        style={styles.resume}
      >
        <View style={[styles.disc, resting && styles.discRest]}>
          <Svg width={DISC} height={DISC} style={styles.ring}>
            {resting ? (
              // A pie of bone that drains as the rest runs out.
              <Circle
                cx={DISC / 2}
                cy={DISC / 2}
                r={DISC / 4}
                fill="none"
                stroke={c.rest.fill}
                strokeWidth={DISC / 2}
                strokeDasharray={`${restFraction * Math.PI * (DISC / 2)} ${Math.PI * (DISC / 2)}`}
              />
            ) : (
              <>
                <Circle
                  cx={DISC / 2}
                  cy={DISC / 2}
                  r={RING}
                  fill="none"
                  stroke={c.s3}
                  strokeWidth={3}
                />
                <Circle
                  cx={DISC / 2}
                  cy={DISC / 2}
                  r={RING}
                  fill="none"
                  stroke={c.fg}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={`${RING_LENGTH} ${RING_LENGTH}`}
                  strokeDashoffset={
                    RING_LENGTH * (1 - (progress.total ? progress.done / progress.total : 0))
                  }
                />
              </>
            )}
          </Svg>
          {resting ? (
            <View style={styles.discText}>
              <Text style={styles.restWord}>Rest</Text>
              <Text style={styles.restClock}>{clock(left / 1000)}</Text>
            </View>
          ) : (
            <Text style={styles.count}>{`${progress.done}/${progress.total}`}</Text>
          )}
        </View>
        <View style={styles.capsule}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
            <Text style={styles.elapsed}>{`  ${elapsed}`}</Text>
          </Text>
          <Text style={styles.next} numberOfLines={1}>
            {resting && name ? "Up next · " : ""}
            {name ? <Text style={styles.nextName}>{name}</Text> : "All sets logged"}
            {values ? ` · ${values}` : ""}
          </Text>
        </View>
      </Tap>
      <View style={styles.actionSlot}>
        {resting && rest ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Skip rest"
            onPress={() => restTimer.skip(store, tree.workout.id, rest.source)}
            style={[styles.action, styles.skip]}
          >
            <SkipIcon color={c.rest.skipInk} size={20} />
          </Tap>
        ) : target ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Log ${setName} of ${name}`}
            onPress={() => log()}
            style={[styles.action, styles.log]}
          >
            <CheckIcon color={c.commitInk} size={22} strokeWidth={2.4} />
          </Tap>
        ) : (
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Finish workout"
            onPress={() => router.push("/workout/finish")}
            style={[styles.action, styles.log]}
          >
            <ForwardIcon color={c.commitInk} size={22} />
          </Tap>
        )}
      </View>
    </Enter>
  );
}

const sheet = themedStyles((c) => ({
  mini: { height: DISC },
  resume: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  disc: {
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    boxShadow: c.shadow,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  discRest: { backgroundColor: c.rest.bg, borderColor: c.rest.line },
  // Drawn from the top, going round clockwise.
  ring: { position: "absolute", left: -1, top: -1, transform: [{ rotate: "-90deg" }] },
  count: { ...font.monoSemi, fontSize: 11, color: c.fg },
  discText: { alignItems: "center", gap: 3 },
  restWord: { ...type.labelSmall, fontSize: 8.5, color: c.rest.ink2 },
  restClock: { ...numeral(19, "300"), lineHeight: 19, color: c.rest.ink },
  capsule: {
    flex: 1,
    minWidth: 0,
    height: DISC,
    borderRadius: DISC / 2,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    boxShadow: c.shadow,
    justifyContent: "center",
    paddingLeft: 18,
    // Room for the action on top of its right end.
    paddingRight: 66,
  },
  title: { ...font.bodySemi, fontSize: 15, lineHeight: 18, color: c.fg },
  elapsed: { ...font.mono, fontSize: 11.5, color: c.fg2 },
  next: { ...type.meta, color: c.fg3, marginTop: 5 },
  nextName: { color: c.fg2 },
  actionSlot: { position: "absolute", right: 8, top: 8 },
  action: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  log: { backgroundColor: c.commit },
  skip: { backgroundColor: c.rest.skip },
}));
