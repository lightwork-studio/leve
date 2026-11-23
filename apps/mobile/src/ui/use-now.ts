import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { startOfDay } from "../model/train.ts";

/** The current time, refreshed every minute and when the app comes back, so "today" moves on. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") tick();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return now;
}

/** The longest wait between looks at the clock: a timer can drift, or the clock be changed. */
const LONGEST_WAIT = 60 * 60_000;

/**
 * The local start of today. It changes only when the day does (checked just after midnight, at
 * least hourly, and when the app comes back), so screens that show days don't render every minute.
 */
export function useToday(): number {
  const [today, setToday] = useState(() => startOfDay(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      const now = Date.now();
      // The same day again leaves the state as it is, so nothing renders.
      setToday(startOfDay(now));
      const d = new Date(now);
      const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      timer = setTimeout(check, Math.min(tomorrow - now + 1000, LONGEST_WAIT));
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, []);
  return today;
}
