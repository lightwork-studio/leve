import { useEffect, useRef, useState } from "react";
import { type StyleProp, Text, type TextStyle } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

/** Eases out: fast at first, settling on the final value. */
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** How long a count-up takes: short, so a screen's figures land together rather than trickle in. */
export const COUNT_UP_MS = 500;

/**
 * A number that counts up from zero to `value` once, after `delay` ms. Reduced motion gets the
 * final value at once.
 */
export function useCountUp(value: number, delay = 0, duration = COUNT_UP_MS): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced) return setShown(value);
    let frame = 0;
    let start: number | null = null;
    const step = (time: number) => {
      start ??= time + delay;
      const t = Math.min(1, Math.max(0, (time - start) / duration));
      setShown(value * easeOut(t));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, delay, duration, reduced]);
  return shown;
}

/**
 * A number that counts up from zero to `value` once (see useCountUp), written by `format`. Screen
 * readers get the final value at once.
 */
export function CountUp({
  value,
  format,
  delay = 0,
  duration = COUNT_UP_MS,
  style,
}: {
  value: number;
  format: (value: number) => string;
  delay?: number;
  duration?: number;
  style?: StyleProp<TextStyle>;
}) {
  const shown = useCountUp(value, delay, duration);
  return (
    <Text accessibilityLabel={format(value)} style={style}>
      {format(shown)}
    </Text>
  );
}

/**
 * A number that rolls from its last value to a new one over `duration` ms, rather than jumping:
 * for figures that change in front of the user (a workout's volume as sets are logged, a chart's
 * headline as the chart redraws). It starts at its first value without moving. Reduced motion
 * jumps straight to the new value.
 */
export function useRolling(value: number, duration = 400, key: unknown = null): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const current = useRef({ value, key });
  // A different quantity (`key`: a chart's measure, say) is shown at once: rolling there would pass
  // through numbers that mean nothing in its unit. Decided during render, so not even one frame of
  // the old number with the new unit is drawn; reduced motion takes the same path.
  const jump = reduced || current.current.key !== key;
  useEffect(() => {
    if (jump || current.current.value === value) {
      current.current = { value, key };
      setShown(value);
      return;
    }
    const from = current.current.value;
    let frame = 0;
    let start: number | null = null;
    const step = (time: number) => {
      start ??= time;
      const t = Math.min(1, (time - start) / duration);
      current.current = { value: from + (value - from) * easeOut(t), key };
      setShown(current.current.value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration, jump, key]);
  return jump ? value : shown;
}
