import {
  CardStyleInterpolators,
  Stack,
  type StackCardInterpolationProps,
  type StackNavigationOptions,
  TransitionPresets,
} from "expo-router/js-stack";
import { Easing } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { radius, space } from "../theme.ts";
import type { ScreenLayout, StackScreen, Transition } from "./stack.tsx";
import { useColors } from "./themed.ts";

/** How narrow a cover is at the bottom edge: about as wide as the running-workout bar. */
/**
 * A cover: an opaque card that rises from the bottom edge over the screen below, which dims a
 * little. (The stack's own bottom-slide on the web fades the card in, so both screens show at once.)
 * Near the bottom edge it narrows and rounds its corners to the shape of the running-workout bar,
 * so going down it seems to tuck into the bar that rises there, and Resume grows out of it.
 */
function forCover({ current, layouts }: StackCardInterpolationProps) {
  // The bar's width on this screen (it sits `space.lg` in from each side), as a share of the card's.
  const width = layouts.screen.width;
  const tuck = width > 0 ? Math.max(0.5, (width - 2 * space.lg) / width) : 1;
  return {
    cardStyle: {
      overflow: "hidden" as const,
      borderTopLeftRadius: current.progress.interpolate({
        inputRange: [0, 0.75, 1],
        outputRange: [radius.card / tuck, radius.card / tuck, 0],
        extrapolate: "clamp",
      }),
      borderTopRightRadius: current.progress.interpolate({
        inputRange: [0, 0.75, 1],
        outputRange: [radius.card / tuck, radius.card / tuck, 0],
        extrapolate: "clamp",
      }),
      transform: [
        {
          translateY: current.progress.interpolate({
            inputRange: [0, 1],
            outputRange: [layouts.screen.height, 0],
            extrapolate: "clamp",
          }),
        },
        {
          scale: current.progress.interpolate({
            // Narrowed only over the last stretch to the bottom edge; full width above it.
            inputRange: [0, 0.4, 1],
            outputRange: [tuck, 1, 1],
            extrapolate: "clamp",
          }),
        },
      ],
    },
    overlayStyle: {
      opacity: current.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 0.25],
        extrapolate: "clamp",
      }),
    },
  };
}

/**
 * A pushed screen slides in from the right over the screen below, which dims a little, with a soft
 * shadow along its leading edge so it reads as a layer on top.
 */
function forPush(props: StackCardInterpolationProps) {
  const base = CardStyleInterpolators.forHorizontalIOS(props);
  return {
    ...base,
    cardStyle: [base.cardStyle, { boxShadow: "-4px 0 12px rgba(0, 0, 0, 0.15)" }],
    overlayStyle: {
      opacity: props.current.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 0.08],
        extrapolate: "clamp",
      }),
    },
  };
}

const OPTIONS: Record<Transition, StackNavigationOptions> = {
  // `animation` must be set: without it the stack doesn't animate in browsers at all.
  push: {
    ...TransitionPresets.SlideFromRightIOS,
    animation: "slide_from_right",
    cardStyleInterpolator: forPush,
    cardOverlayEnabled: true,
  },
  cover: {
    animation: "default",
    cardStyleInterpolator: forCover,
    cardOverlayEnabled: true,
    gestureDirection: "vertical",
    transitionSpec: {
      // Rises quickly and settles softly; leaves faster than it came.
      open: {
        animation: "timing",
        config: { duration: 380, easing: Easing.bezier(0.32, 0.72, 0, 1) },
      },
      close: {
        animation: "timing",
        config: { duration: 280, easing: Easing.bezier(0.4, 0, 1, 1) },
      },
    },
  },
  fade: { animation: "fade" },
  // The screen is simply there (the ground colour over itself) and brings its own content in: a
  // cross-fade would wash its dark header through grey on the way.
  reveal: { animation: "none" },
};

/**
 * The app's screen stack in browsers. The native navigator doesn't animate there, so the web build
 * uses the JavaScript stack with the same kinds of transition as phones. Browsers have no swipe to
 * close. Under reduced motion, screens change without moving.
 */
export function AppStack({ screens, layout }: { screens: StackScreen[]; layout?: ScreenLayout }) {
  const reduced = useReducedMotion();
  const c = useColors();
  return (
    <Stack
      {...(layout ? { screenLayout: layout } : {})}
      screenOptions={{
        headerShown: false,
        // A card fills the window and scrolls inside: the page itself never scrolls, so anything
        // pinned to a screen's bottom edge (the rest timer, a footer) stays on screen.
        cardStyle: { backgroundColor: c.bg, flex: 1, overflow: "hidden" },
      }}
    >
      {screens.map((screen) => (
        <Stack.Screen
          key={screen.name}
          name={screen.name}
          options={{
            ...(reduced ? { animation: "none" as const } : OPTIONS[screen.transition]),
            ...(screen.transparent && {
              presentation: "transparentModal",
              detachPreviousScreen: false,
              cardStyle: { backgroundColor: "transparent", flex: 1 },
              cardOverlayEnabled: false,
            }),
          }}
        />
      ))}
    </Stack>
  );
}
