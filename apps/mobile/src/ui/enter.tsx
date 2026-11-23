import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { StyleProp, ViewProps, ViewStyle } from "react-native";
import Animated, {
  type AnimatedProps,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { easeOut, enterDuration, fadeOut } from "./motion.ts";

/**
 * Whether the content around is still being shown for the first time, and whether its screen is
 * closing. Entrances inside `StillOnOpen` don't animate on that first showing, and exits don't play
 * when the whole screen closes; only what appears or goes while it stays open moves.
 */
interface Showing {
  opening: boolean;
  closing: boolean;
}
const OpeningContext = createContext<Showing>({ opening: false, closing: false });

/** Content shown when a screen opens is simply there; only later changes animate. */
export function StillOnOpen({ children }: { children: ReactNode }) {
  const showing = useRef<Showing>({ opening: true, closing: false }).current;
  useEffect(() => {
    showing.opening = false;
  }, [showing]);
  // React runs a parent's cleanup before its children unmount, so the exits below know in time.
  // (Set up again after a cleanup that wasn't an unmount, such as Fast Refresh, it reopens.)
  useLayoutEffect(() => {
    showing.closing = false;
    return () => {
      showing.closing = true;
    };
  }, [showing]);
  return (
    <OpeningContext.Provider value={showing}>
      {/* Reanimated's own entrances (pop, rise…) follow the same rule. When the whole screen
          closes, nothing inside plays its exit (phones skip them here; browsers ignore this, so
          Enter skips its own). */}
      <LayoutAnimationConfig skipEntering skipExiting>
        {children}
      </LayoutAnimationConfig>
    </OpeningContext.Provider>
  );
}

/**
 * An exit animation of this component's own, played when it is removed while its screen stays
 * open and skipped when the whole screen closes. Browsers ignore Reanimated's skipExiting and would
 * otherwise replay exits where things were, over the screen below. `make` builds a fresh one, so
 * switching it off never touches anyone else's.
 */
export function useExit<T extends { reduceMotion: (mode: ReduceMotion) => unknown }>(
  make: () => T,
): T {
  const showing = useContext(OpeningContext);
  const [exit] = useState(make);
  useLayoutEffect(() => {
    // Re-armed after a cleanup that wasn't the screen closing (StrictMode, a hidden-and-shown view).
    exit.reduceMotion(ReduceMotion.System);
    return () => {
      if (showing.closing) exit.reduceMotion(ReduceMotion.Always);
    };
  }, [showing, exit]);
  return exit;
}

type EnterProps = Omit<AnimatedProps<ViewProps>, "style" | "entering" | "exiting"> & {
  style?: StyleProp<ViewStyle>;
  /** Milliseconds before it starts, to follow something else in. */
  delay?: number;
  /** How far it rises into place; negative values drop it down into place. */
  distance?: number;
  /** Whether it also fades in. Off for opaque surfaces, which should arrive whole. */
  fadeIn?: boolean;
  /** Fades out when removed while its screen stays open (not when the whole screen closes). */
  leaves?: boolean;
  duration?: number;
};

/**
 * Fades something in as it rises a few points into place. It animates its own style rather than
 * using a layout animation, so it behaves the same on phones and in browsers and leaves nothing
 * behind once done. Reduced motion shows it at once.
 */
export function Enter({
  delay = 0,
  distance = 8,
  duration = enterDuration,
  fadeIn = true,
  leaves = false,
  style,
  children,
  ...props
}: EnterProps) {
  const showing = useContext(OpeningContext);
  const reduced = useReducedMotion();
  // Decided once, at mount: content that was there when the screen opened doesn't animate.
  const [still] = useState(() => showing.opening || reduced);
  // Its own exit, so it can be switched off just for this one when the screen closes.
  const ownExit = useExit(fadeOut);
  const exiting = leaves ? ownExit : undefined;
  const shown = useSharedValue(still ? 1 : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an entrance runs once, at mount.
  useEffect(() => {
    if (still) return;
    shown.value = withDelay(delay, withTiming(1, { duration, easing: easeOut }));
  }, []);
  const animated = useAnimatedStyle(() => ({
    opacity: fadeIn ? shown.value : 1,
    transform: [{ translateY: (1 - shown.value) * distance }],
  }));
  const entering = (
    <Animated.View {...props} style={[style, animated]}>
      {children}
    </Animated.View>
  );
  // An exit animation also sets opacity, so it goes on a wrapper of its own.
  return exiting ? <Animated.View exiting={exiting}>{entering}</Animated.View> : entering;
}

/**
 * Whether this component arrived after its screen first showed (and motion is allowed): for
 * moments that should only play when something changes, not when the screen opens. Decided once,
 * at mount.
 */
export function useArrivedLater(): boolean {
  const showing = useContext(OpeningContext);
  const reduced = useReducedMotion();
  const [later] = useState(() => !showing.opening && !reduced);
  return later;
}
