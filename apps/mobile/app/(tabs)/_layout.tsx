import { Tabs, useSegments } from "expo-router";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { Easing, type Animated as RNAnimated, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useWeekBar } from "../../src/data/queries.ts";
import { gutter, space, touch, type } from "../../src/theme.ts";
import { haptic } from "../../src/ui/haptics.ts";
import { HistoryIcon, ProgressIcon, TrainIcon } from "../../src/ui/icons.tsx";
import { MiniPlayer } from "../../src/ui/live/mini-player.tsx";
import { MainActionProvider, MainActionSlot, useBarAction } from "../../src/ui/main-action.tsx";
import { spring } from "../../src/ui/motion.ts";
import { MainActionHeight } from "../../src/ui/screen.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { useToday } from "../../src/ui/use-now.ts";
import { WeekBar, type WeekBarMode } from "../../src/ui/week-bar.tsx";

const TABS: {
  name: string;
  title: string;
  Icon: ComponentType<{ color: string; size?: number }>;
}[] = [
  { name: "index", title: "Train", Icon: TrainIcon },
  { name: "history", title: "History", Icon: HistoryIcon },
  { name: "progress", title: "Progress", Icon: ProgressIcon },
];

export default function TabsLayout() {
  const styles = useStyles(sheet);
  const c = useColors();
  // The tab animation isn't Reanimated's, so it doesn't follow reduced motion on its own.
  const reduced = useReducedMotion();
  const [tabHeight, setTabHeight] = useState(0);
  const [slotHeight, setSlotHeight] = useState(0);
  // Which tab is arriving, so it can fade in differently from the one leaving (the scenes'
  // animation alone can't tell them apart). A tap sets it in the same update as the switch;
  // other ways of changing tabs (a link) catch up from the route a moment later.
  const segments: string[] = useSegments();
  const routeTab = segments[0] === "(tabs)" ? (segments[1] ?? "index") : null;
  const [focus, setFocus] = useState(routeTab ?? "index");
  const [seen, setSeen] = useState(routeTab);
  if (routeTab !== seen) {
    setSeen(routeTab);
    if (routeTab !== null) setFocus(routeTab);
  }
  return (
    <MainActionProvider>
      {/* Tab screens scroll clear of the floating tabs, and of the main action when there is one. */}
      <MainActionHeight.Provider value={tabHeight + (slotHeight > 0 ? slotHeight + space.sm : 0)}>
        <View style={styles.flex}>
          {/* One week over every tab: it stays put while the tabs change under it. */}
          <TabsWeekBar tab={focus} />
          <Tabs
            screenOptions={({ route }) => ({
              headerShown: false,
              sceneStyle: { backgroundColor: c.bg },
              // Tabs fade through (see fadeIn and fadeOut); reduced motion switches them without moving.
              ...(reduced
                ? { animation: "none" }
                : {
                    sceneStyleInterpolator: route.name === focus ? fadeIn : fadeOut,
                    transitionSpec: TAB_TRANSITION,
                  }),
            })}
            tabBar={({ state, descriptors, navigateToTab }) => (
              <TabBar
                onHeight={setTabHeight}
                active={state.routes[state.index]?.name}
                preload={(name) => {
                  const current = state.routes[state.index];
                  if (current) descriptors[current.key]?.navigation.preload(name);
                }}
                onSelect={(name) => {
                  const route = state.routes.find((r) => r.name === name);
                  if (!route || route.name === state.routes[state.index]?.name) return;
                  haptic.select();
                  setFocus(route.name);
                  navigateToTab(route.key);
                }}
              />
            )}
          >
            {TABS.map((tab) => (
              <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.title }} />
            ))}
          </Tabs>
          {tabHeight > 0 && (
            <View
              pointerEvents="box-none"
              style={[styles.slot, { bottom: tabHeight + space.sm }]}
              onLayout={(event) => setSlotHeight(event.nativeEvent.layout.height)}
            >
              {/* A running workout takes the place of whatever the tab offers. */}
              <MainActionSlot render={(offered) => <MiniPlayer fallback={offered} />} />
            </View>
          )}
        </View>
      </MainActionHeight.Provider>
    </MainActionProvider>
  );
}

const BAR_MODES: Record<string, WeekBarMode> = {
  index: "train",
  history: "history",
  progress: "progress",
};

/** The week bar, with the marks and the action of the tab on show. */
function TabsWeekBar({ tab }: { tab: string }) {
  const today = useToday();
  // Records read the whole history, so they join once the first screen is up.
  const [withRecords, setWithRecords] = useState(false);
  useEffect(() => whenIdle(() => setWithRecords(true)), []);
  const week = useWeekBar(today, withRecords);
  return <WeekBar week={week} mode={BAR_MODES[tab] ?? "train"} action={useBarAction()} />;
}

function TabBar({
  active: activeName,
  onHeight,
  preload,
  onSelect,
}: {
  active: string | undefined;
  onHeight: (height: number) => void;
  preload: (name: string) => void;
  onSelect: (name: string) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const insets = useSafeAreaInsets();
  // Once the app is idle, the other tabs are built out of sight, so the first switch to one only
  // has to slide it in.
  const latest = useRef({ preload, activeName });
  latest.current = { preload, activeName };
  useEffect(
    () =>
      whenIdle(() => {
        const { preload, activeName } = latest.current;
        for (const tab of TABS) if (tab.name !== activeName) preload(tab.name);
      }),
    [],
  );
  const index = Math.max(
    0,
    TABS.findIndex((tab) => tab.name === activeName),
  );
  // One bone tile that slides to the chosen tab, like a switch, rather than one per tab switching
  // on and off. Its width is a tab's: the switch's inside, less its padding, in thirds.
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const tabWidth = Math.max(0, width - 2 * SWITCH_BORDER - 2 * SWITCH_PAD) / TABS.length;
  const target = index * tabWidth;
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (width === 0) return;
    // The first position is set, not animated: the highlight starts where it belongs.
    if (!placed) {
      x.value = target;
      setPlaced(true);
    } else x.value = withSpring(target, spring);
  }, [width, target, placed, x]);
  const highlight = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={[styles.bar, { paddingBottom: Math.max(insets.bottom - 4, 12) }]}
    >
      {/* The tabs float over the screen, which fades out behind them rather than stopping at an edge. */}
      <Svg
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        width="100%"
        height="100%"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        <Defs>
          <LinearGradient id="tab-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.bg} stopOpacity={0} />
            <Stop offset="0.36" stopColor={c.bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="1" height="1" fill="url(#tab-fade)" />
      </Svg>
      <View
        accessibilityRole="tablist"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={styles.switch}
      >
        {placed && (
          <Animated.View
            pointerEvents="none"
            style={[styles.highlight, { width: tabWidth }, highlight]}
          />
        )}
        {TABS.map((tab) => {
          const active = tab.name === activeName;
          return (
            <Tap
              key={tab.name}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tab.title}
              onPress={() => onSelect(tab.name)}
              style={[styles.tab, active && !placed && styles.tabActive]}
            >
              <tab.Icon color={active ? c.bg : c.fg2} size={17} />
              <Text style={[styles.label, active && styles.labelActive]}>{tab.title}</Text>
            </Tap>
          );
        })}
      </View>
    </View>
  );
}

/** Runs `fn` when the app is idle (or after a moment where that can't be told); returns a cancel. */
function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(fn, { timeout: 2500 });
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(fn, 1200);
  return () => clearTimeout(timer);
}

/*
 * Tabs fade through: the old tab fades out where it is over the first third of the change, then
 * the new one fades in over the rest, easing out as it settles a few points into place from just
 * smaller. The two overlap for a moment, so the screen never goes blank between them.
 *
 * Each tab's progress runs from -1 or 1 (out of sight, to one side) to 0 (shown). The leaving tab
 * goes from 0 outwards, the arriving one from its side to 0, both on linear time, so where the
 * progress is says how far through the change it is.
 */

/** How far (as progress) the old tab has to go before it is gone: about the first third. */
const OUT_BY = 0.33;
/** How far from the end the new tab starts to show: just before the old one has gone. */
const IN_FROM = 0.7;
/** Moments through the new tab's fade-in, sampled, so the native driver can ease it. */
const IN_STEPS = [0, 0.08, 0.16, 0.25, 0.35, 0.5, 0.65, 0.8, 1];

type SceneProps = { current: { progress: RNAnimated.Value } };

/**
 * The arriving tab's values along its progress, from both sides. `at(eased, side)` gives the value
 * at an eased moment (0 hidden, 1 in place) for a tab coming from the left (-1) or right (1).
 */
function arriving(at: (eased: number, side: -1 | 1) => number) {
  // Ease-out cubic, the curve of the app's easeOut.
  const ease = (s: number) => 1 - (1 - s) ** 3;
  const left = IN_STEPS.map((s) => ({ input: -IN_FROM * (1 - s), output: at(ease(s), -1) }));
  const right = [...IN_STEPS]
    .reverse()
    .slice(1)
    .map((s) => ({ input: IN_FROM * (1 - s), output: at(ease(s), 1) }));
  const points = [
    { input: -1, output: at(0, -1) },
    ...left,
    ...right,
    { input: 1, output: at(0, 1) },
  ];
  return { inputRange: points.map((p) => p.input), outputRange: points.map((p) => p.output) };
}

const IN_OPACITY = arriving((eased) => eased);
const IN_SHIFT = arriving((eased, side) => side * 8 * (1 - eased));
const IN_SCALE = arriving((eased) => 0.98 + 0.02 * eased);

function fadeIn({ current }: SceneProps) {
  return {
    sceneStyle: {
      opacity: current.progress.interpolate(IN_OPACITY),
      transform: [
        { translateX: current.progress.interpolate(IN_SHIFT) },
        { scale: current.progress.interpolate(IN_SCALE) },
      ],
    },
  };
}

function fadeOut({ current }: SceneProps) {
  return {
    sceneStyle: {
      opacity: current.progress.interpolate({
        inputRange: [-1, -OUT_BY, 0, OUT_BY, 1],
        outputRange: [0, 0, 1, 0, 0],
      }),
    },
  };
}

// Linear time, so each tab's part of the change happens when its progress says; the arriving
// tab's ease is in its own curve.
const TAB_TRANSITION = {
  animation: "timing",
  config: { duration: 260, easing: Easing.linear },
} as const;

/** The tab switch's outline and the space inside it, around the sliding tile. */
const SWITCH_BORDER = 1;
const SWITCH_PAD = 4;

const sheet = themedStyles((c) => ({
  flex: { flex: 1 },
  slot: { position: "absolute", left: gutter.group, right: gutter.group },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 10,
    paddingHorizontal: gutter.group,
  },
  switch: {
    flexDirection: "row",
    height: 56,
    padding: SWITCH_PAD,
    borderRadius: 19,
    backgroundColor: c.s1,
    borderWidth: SWITCH_BORDER,
    borderColor: c.line,
  },
  highlight: {
    position: "absolute",
    top: SWITCH_PAD,
    bottom: SWITCH_PAD,
    left: SWITCH_PAD,
    borderRadius: 15,
    backgroundColor: c.fg,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: touch,
    borderRadius: 15,
  },
  tabActive: { backgroundColor: c.fg },
  label: { ...type.action, color: c.fg2 },
  labelActive: { color: c.bg },
}));
