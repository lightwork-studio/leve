import { useIsFocused } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { weekFolded } from "../model/week-bar.ts";

/** What the tabs share with the week bar floating over them. */
export interface WeekBarFold {
  /** The bar's full height, status bar included: where a tab's content starts. */
  height: number;
  /** How much of the tab the bar still covers once folded: what to keep clear when scrolling to something. */
  covered: number;
  /** Folds or opens the bar, for the tab on show. */
  setFolded: (folded: boolean) => void;
}

export const WeekBarFoldContext = createContext<WeekBarFold>({
  height: 0,
  covered: 0,
  setFolded: () => {},
});

/**
 * A tab's side of the week bar: where its content starts, and a scroll handler that folds the bar
 * once the tab scrolls and opens it again at the top. Each tab remembers its own state, so the bar
 * follows whichever tab is on show: a tab scrolled down keeps it folded, one at the top opens it.
 */
export function useWeekBarFold() {
  const { height, setFolded } = useContext(WeekBarFoldContext);
  const focused = useIsFocused();
  const folded = useRef(false);
  // Coming into view, the tab puts the bar the way it left it.
  useEffect(() => {
    if (focused) setFolded(folded.current);
  }, [focused, setFolded]);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = weekFolded(event.nativeEvent.contentOffset.y, folded.current);
      if (next === folded.current) return;
      folded.current = next;
      if (focused) setFolded(next);
    },
    [focused, setFolded],
  );
  return { height, onScroll };
}
