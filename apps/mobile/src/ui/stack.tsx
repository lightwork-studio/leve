import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { palettes } from "../theme.ts";
import { useAppearance } from "./themed.ts";

/**
 * How a screen arrives: `push` slides in from the side (going deeper), `cover` rises from the
 * bottom (a task such as the live workout, dismissed downwards), `fade` cross-fades, and
 * `reveal` (a result) brings its own content in: phones cross-fade it, browsers show it at once.
 */
export type Transition = "push" | "cover" | "fade" | "reveal";

export interface StackScreen {
  name: string;
  transition: Transition;
  /** Whether a swipe can close it: on for pushed screens, off for covers and fades. */
  swipe?: boolean;
  /** Keep the previous route visible underneath a draggable sheet. */
  transparent?: boolean;
}

const ANIMATION = {
  push: "default",
  cover: "slide_from_bottom",
  fade: "fade",
  reveal: "fade",
} as const;

// Expo Router uses the navigation theme for the layer behind screens during native transitions.
const THEMES = {
  dark: { ...DarkTheme, colors: { ...DarkTheme.colors, background: palettes.dark.bg } },
  paper: { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: palettes.paper.bg } },
};

/** The app's screen stack on phones: the platform's native navigator and transitions. */
export function AppStack({ screens }: { screens: StackScreen[] }) {
  const theme = THEMES[useAppearance()];
  return (
    <ThemeProvider value={theme}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        {screens.map((screen) => (
          <Stack.Screen
            key={screen.name}
            name={screen.name}
            options={{
              ...(screen.transparent
                ? {
                    presentation: "transparentModal",
                    contentStyle: { backgroundColor: "transparent" },
                  }
                : // An opaque cover draws its own sheet. Without a presentation, one opened above
                  // the live workout's modal would become an iOS page sheet around that sheet.
                  screen.transition === "cover" && { presentation: "fullScreenModal" }),
              animation: ANIMATION[screen.transition],
              // A cover closes with its own button. A swipe down would have to start anywhere on it
              // (iOS has no edge swipe downwards) and so fight the scrolling list inside.
              gestureEnabled: screen.swipe ?? screen.transition === "push",
            }}
          />
        ))}
      </Stack>
    </ThemeProvider>
  );
}
