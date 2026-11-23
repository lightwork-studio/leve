import { type Href, router } from "expo-router";
import { BackButton } from "./screen.tsx";

/** "‹ Progress": back to the screen before, or to `fallback` when opened directly. */
export function BackLink({ label, fallback }: { label: string; fallback: Href }) {
  return (
    <BackButton
      label={label}
      accessibilityLabel={`Back to ${label}`}
      onPress={() => (router.canGoBack() ? router.back() : router.replace(fallback))}
    />
  );
}
