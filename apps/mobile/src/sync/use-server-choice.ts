import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { readServerChoice, subscribeServerChoice } from "./own-server-store.ts";

function subscribe(listener: () => void) {
  const unsubscribe = subscribeServerChoice(listener);
  // A locked keychain can be read again when the app returns to the foreground.
  const watch = AppState.addEventListener("change", (state) => {
    if (state === "active") listener();
  });
  return () => {
    unsubscribe();
    watch.remove();
  };
}

export function useServerChoice(enabled = true) {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (enabled) return subscribe(() => setVersion((n) => n + 1));
  }, [enabled]);
  return enabled ? readServerChoice() : null;
}
