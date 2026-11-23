import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../../data/app-data.tsx";
import { restTimer, useRest } from "../../data/rest-timer.ts";
import { font, radius, type } from "../../theme.ts";
import { Enter } from "../enter.tsx";
import { haptic } from "../haptics.ts";
import { CheckIcon } from "../icons.tsx";
import { themedStyles, useColors, useStyles } from "../themed.ts";
import { RestSlab } from "./dock.tsx";

/** Mounted by the editor that owns the input, including inside a note's native modal. */
export function EditingRest({ workoutId, next }: { workoutId: string; next?: string }) {
  const { store, version } = useAppData();
  const rest = useRest(store, workoutId, version);
  const styles = useStyles(sheet);
  const c = useColors();
  const lastEnd = useRef<number | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (rest) {
      lastEnd.current = rest.endsAt;
      setDone(false);
      const end = setTimeout(
        () => {
          if (restTimer.expire(store, rest) && Date.now() - rest.endsAt < 2000) haptic.success();
        },
        Math.max(0, rest.endsAt - Date.now()),
      );
      return () => clearTimeout(end);
    }
    const elapsed = lastEnd.current === null ? -1 : Date.now() - lastEnd.current;
    lastEnd.current = null;
    // Skip (or undoing the logged set) dismisses immediately. Only a just-ended rest lingers.
    if (elapsed < 0 || elapsed >= 2000) {
      setDone(false);
      return;
    }
    setDone(true);
    const hide = setTimeout(() => setDone(false), 2000 - elapsed);
    return () => clearTimeout(hide);
  }, [rest, store]);

  if (rest)
    return (
      <RestSlab
        rest={rest}
        onAdjust={(seconds) => restTimer.adjust(store, rest, seconds)}
        onSkip={() => restTimer.skip(store, workoutId, rest.source)}
      />
    );
  if (!done) return null;
  return (
    <Enter leaves distance={4} accessibilityLiveRegion="polite" style={styles.done}>
      <CheckIcon color={c.rest.ink} size={20} />
      <View style={styles.detail}>
        <Text style={styles.title}>Rest done</Text>
        {next && (
          <Text style={styles.next} numberOfLines={1}>
            {next}
          </Text>
        )}
      </View>
    </Enter>
  );
}

const sheet = themedStyles((c) => ({
  done: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    borderRadius: radius.button,
    backgroundColor: c.rest.bg,
  },
  detail: { flex: 1 },
  title: { ...font.bodySemi, color: c.rest.ink },
  next: { ...type.meta, color: c.rest.ink2 },
}));
