import { useNavigation } from "expo-router";
import { useEffect, useState } from "react";

/**
 * False while the screen is still sliding in, then true. Work that isn't needed for the first
 * frame waits for it, so the transition doesn't stall. Without a transition (a screen opened
 * directly), it turns true after `fallbackMs`.
 */
export function useSettled(fallbackMs = 600): boolean {
  const navigation = useNavigation();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), fallbackMs);
    const stop = navigation.addListener("transitionEnd" as never, (event: never) => {
      const closing = (event as { data?: { closing?: boolean } }).data?.closing;
      if (!closing) setSettled(true);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [navigation, settled, fallbackMs]);
  return settled;
}
