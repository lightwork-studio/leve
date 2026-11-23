import type { SetMetric } from "@leve/core";
import { type ReactNode, useEffect, useState } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Line } from "react-native-svg";
import { type Rest, restProgress } from "../../data/rest-timer.ts";
import { type PadKey, takesDecimal } from "../../model/inline-edit.ts";
import { font, numeral, radius, touch, type } from "../../theme.ts";
import {
  CheckIcon,
  CloseIcon,
  DeleteIcon,
  EditIcon,
  ForwardIcon,
  MinusIcon,
  PlusIcon,
} from "../icons.tsx";
import { Tap } from "../tap.tsx";
import { themedStyles, useColors, useStyles } from "../themed.ts";
import { clock, useTicker } from "../use-ticker.ts";

// The live workout's dock: the one place a set is typed and logged. It is a strip of steppers with
// the log button at its end, a number pad while a field is being typed, or, during rest, only the
// countdown.

/** The pad's last key: on to the next field (named), or done. */
export interface NextKey {
  /** Where Next goes ("reps", "set 3", "Squat · set 1"); nothing means this is the last field. */
  to: string | null;
}

/** A gym-sized number pad: digits, the field's ± step, delete, and Next. */
export function Keypad({
  metric,
  step,
  next,
  tall = false,
  onKey,
  onStep,
  onNext,
}: {
  metric: SetMetric;
  /** The ± step as shown ("2.5", "5 s"). */
  step: string;
  next: NextKey;
  tall?: boolean;
  onKey: (key: PadKey) => void;
  onStep: (direction: -1 | 1) => void;
  onNext: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const digit = (key: PadKey) => (
    <Tap
      key={key}
      accessibilityRole="button"
      accessibilityLabel={key}
      onPress={() => onKey(key)}
      scaleTo={0.95}
      style={[styles.key, tall && styles.keyTall]}
    >
      <Text style={styles.digit}>{key}</Text>
    </Tap>
  );
  const fn = (label: string, content: ReactNode, onPress: () => void) => (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      scaleTo={0.95}
      style={[styles.key, styles.fnKey, tall && styles.keyTall]}
    >
      {content}
    </Tap>
  );
  const stepText = (sign: string) => <Text style={styles.fnText}>{`${sign}${step}`}</Text>;
  return (
    <View role="group" aria-label="Number pad" style={styles.pad}>
      <View style={styles.padRow}>
        {digit("1")}
        {digit("2")}
        {digit("3")}
        {fn(`Step down ${step}`, stepText("−"), () => onStep(-1))}
      </View>
      <View style={styles.padRow}>
        {digit("4")}
        {digit("5")}
        {digit("6")}
        {fn(`Step up ${step}`, stepText("+"), () => onStep(1))}
      </View>
      <View style={styles.padRow}>
        {digit("7")}
        {digit("8")}
        {digit("9")}
        {fn("Delete", <DeleteIcon color={c.fg2} size={20} />, () => onKey("delete"))}
      </View>
      <View style={styles.padRow}>
        {takesDecimal(metric) ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Decimal point"
            onPress={() => onKey(".")}
            scaleTo={0.95}
            style={[styles.key, tall && styles.keyTall]}
          >
            <Text style={styles.digit}>.</Text>
          </Tap>
        ) : (
          <View style={[styles.key, styles.keyBlank, tall && styles.keyTall]} />
        )}
        {digit("0")}
        <Tap
          accessibilityRole="button"
          accessibilityLabel={next.to ? `Next: ${next.to}` : "Done"}
          onPress={onNext}
          scaleTo={0.97}
          style={[styles.key, styles.goKey, tall && styles.keyTall]}
        >
          <View style={styles.goLine}>
            <Text style={styles.goText}>{next.to ? "Next" : "Done"}</Text>
            {next.to ? (
              <ForwardIcon color={c.bg} size={16} />
            ) : (
              <CheckIcon color={c.bg} size={16} strokeWidth={2.4} />
            )}
          </View>
          {next.to ? (
            <Text style={styles.goTo} numberOfLines={1}>
              {next.to}
            </Text>
          ) : null}
        </Tap>
      </View>
    </View>
  );
}

/** The dock's heading while a set in the list is being typed: which set, which field, and Done. */
export function EditHeader({
  chip,
  logged,
  exercise,
  detail,
  announcement,
  onDone,
  onCancel,
}: {
  chip: string;
  logged: boolean;
  exercise: string;
  /** "Set 2 · weight · logged · last 80 × 8" */
  detail: string;
  /** What a screen reader says as the value changes. */
  announcement: string;
  /** Without it there is no Done here: the pad's own last key is the only one. */
  onDone?: () => void;
  /** A ✕ that closes the pad and keeps what was there before. */
  onCancel?: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <View style={styles.editHead}>
      <View
        accessible
        accessibilityLabel={announcement}
        accessibilityLiveRegion="polite"
        aria-live="polite"
        style={styles.editTarget}
      >
        <SetMarker label={chip} logged={logged} />
        <View style={styles.editText}>
          <Text style={styles.editExercise} numberOfLines={1}>
            {exercise}
          </Text>
          <Text style={styles.editDetail} numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </View>
      {onCancel && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Close without saving"
          hitSlop={4}
          onPress={onCancel}
          scaleTo={0.92}
          style={styles.cancel}
        >
          <CloseIcon color={c.fg2} size={15} />
        </Tap>
      )}
      {onDone && <DoneButton label="Done typing" onPress={onDone} />}
    </View>
  );
}

/** The small filled Done at the end of the dock's heading. */
export function DoneButton({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={styles.done}
    >
      <CheckIcon color={c.bg} size={14} strokeWidth={2.6} />
      <Text style={styles.doneText}>Done</Text>
    </Tap>
  );
}

/** The dashed chip that marks the set the dock is about (solid once that set is logged). */
export function SetMarker({ label, logged = false }: { label: string; logged?: boolean }) {
  const styles = useStyles(sheet);
  return (
    <View style={[styles.marker, logged && styles.markerLogged]}>
      <Text style={styles.markerText}>{label}</Text>
    </View>
  );
}

/** One field of the dock's strip. */
export interface StripField {
  metric: SetMetric;
  /** weight, reps, time… */
  name: string;
  text: string;
  /** Typed or accepted, rather than a suggestion. */
  firm: boolean;
  /** kg, reps, m:ss… */
  unit: string;
  /** The ± step as shown, next to the unit for weights. */
  step?: string;
  /** How many steps the value is from zero, to slide the ruler under it. */
  steps: number;
  editing: boolean;
  onStep: (direction: -1 | 1) => void;
  onEdit: () => void;
}

/** Three 44 pt targets and the field's 1 pt hairline. */
const FULL_FIELD = 3 * touch + 1;
/** The check that logs the set. */
const CHECK = 56;

/**
 * The strip's columns for its width (outer, with its 1 pt border) and the fields it shows. The
 * set's marker sits in the line above, so the fields share everything but the check. Beside a
 * weight, the other field gets room for three 44 pt targets and the weight takes the rest; where
 * there isn't room for that, every field gets the same share. A narrow phone (under 340 pt of
 * strip) draws slimmer steppers. `boxes` is each field's width with its hairline, empty until the
 * strip has been measured.
 */
export function stripLayout(width: number, metrics: readonly SetMetric[] = ["weight", "reps"]) {
  const compact = width > 0 && width < 340;
  const stepper = compact ? 30 : 34;
  if (width <= 0) return { compact, stepper, check: CHECK, boxes: [] as number[] };
  const room = Math.max(0, width - 2 - CHECK);
  const even = room / Math.max(1, metrics.length);
  const weight = metrics.indexOf("weight");
  const other = Math.min(FULL_FIELD, even);
  const boxes = metrics.map((_, i) =>
    weight === -1 || metrics.length === 1
      ? even
      : i === weight
        ? room - other * (metrics.length - 1)
        : other,
  );
  return { compact, stepper, check: CHECK, boxes };
}

/**
 * How far a stepper's touch reaches into the value beside it (`value` pt wide as drawn): far
 * enough for a 44 pt target while the value keeps 44 pt of its own. A field too narrow for three
 * 44 pt targets is shared evenly between −, value and +, so the value can always be tapped.
 */
export function stepperReach(stepper: number, value: number): number {
  const field = value + 2 * stepper;
  return Math.max(0, Math.min(touch, field / 3) - stepper);
}

/**
 * The size a value is drawn at to fit `width`: `largest` when it fits, smaller for a long value in
 * a narrow column ("8–12" reps on a small phone), never under 11 pt. Thin tabular numerals are
 * about 0.6 em wide each.
 */
export function valueSize(text: string, width: number, largest: number): number {
  if (width <= 0) return largest;
  const fit = Math.floor(width / (Math.max(1, text.length) * 0.6));
  return Math.max(11, Math.min(largest, fit));
}

/**
 * The logging strip: a − value + stepper per field with a ruler under each value, and the
 * vermilion check at its end, which logs the set. The set's marker is in the line above it.
 */
export function SetStrip({
  fields,
  logLabel,
  canLog,
  onLog,
}: {
  fields: StripField[];
  logLabel: string;
  canLog: boolean;
  onLog: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [width, setWidth] = useState(0);
  const layout = stripLayout(
    width,
    fields.map((field) => field.metric),
  );
  return (
    <View style={styles.strip} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {fields.map((field, i) => (
        <StripSegment key={field.metric} field={field} layout={layout} box={layout.boxes[i]} />
      ))}
      <Tap
        accessibilityRole="button"
        accessibilityLabel={logLabel}
        accessibilityState={{ disabled: !canLog }}
        disabled={!canLog}
        onPress={onLog}
        scaleTo={0.94}
        style={[styles.check, { width: layout.check }, !canLog && styles.checkOff]}
      >
        <CheckIcon color={c.commitInk} size={26} strokeWidth={2.4} />
      </Tap>
    </View>
  );
}

/**
 * One field of the strip: − value +. Each stepper's touch reaches into the value beside it (and
 * sits above it), up to a 44 pt target where the value keeps room to be tapped too.
 */
function StripSegment({
  field,
  layout,
  box,
}: {
  field: StripField;
  layout: ReturnType<typeof stripLayout>;
  /** The field's width with its hairline; unknown until the strip has been measured. */
  box: number | undefined;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  // The value is drawn between the two steppers.
  const width = box === undefined ? 0 : Math.max(0, box - 1 - 2 * layout.stepper);
  const reach = stepperReach(layout.stepper, width);
  const size = valueSize(field.text, width, field.text.length > 4 ? 25 : 31);
  const stepper = [styles.stepper, { width: layout.stepper }];
  const step = field.step ? `, ${field.step} ${field.unit}` : "";
  return (
    <View
      style={[
        styles.segment,
        box !== undefined && { flex: 0, width: box },
        field.editing && styles.segmentOn,
      ]}
    >
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Less ${field.name}${step}`}
        hitSlop={{ right: reach }}
        onPress={() => field.onStep(-1)}
        scaleTo={0.9}
        style={stepper}
      >
        <MinusIcon color={c.fg2} size={17} strokeWidth={2} />
      </Tap>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Type ${field.name}`}
        accessibilityHint={`${field.text} ${field.unit}`}
        accessibilityState={{ selected: field.editing }}
        onPress={field.onEdit}
        scaleTo={1}
        style={styles.value}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.valueText,
            {
              fontSize: size,
              lineHeight: Math.min(31, Math.round(size * 1.04)),
              letterSpacing: -0.04 * size,
            },
            !field.firm && styles.valueHint,
          ]}
        >
          {field.text}
        </Text>
        <Text style={styles.valueUnit} numberOfLines={1}>
          {field.unit}
          {field.step && !layout.compact ? (
            <Text style={styles.valueStep}>{`  ±${field.step}`}</Text>
          ) : null}
        </Text>
        <Ruler steps={field.steps} />
      </Tap>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`More ${field.name}${step}`}
        hitSlop={{ left: reach }}
        onPress={() => field.onStep(1)}
        scaleTo={0.9}
        style={stepper}
      >
        <PlusIcon color={c.fg2} size={17} strokeWidth={2} />
      </Tap>
    </View>
  );
}

const TICK = 7;
const MAJOR = 5;

/** Ruler ticks under a value, slid by the value so a step reads as movement. */
function Ruler({ steps }: { steps: number }) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [width, setWidth] = useState(0);
  const mid = width / 2;
  const reach = Math.ceil(mid / TICK);
  const first = Math.floor(steps) - reach;
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.ruler}
    >
      {width > 0 && (
        <Svg width={width} height={8}>
          {Array.from({ length: reach * 2 + 2 }, (_, i) => {
            // Tick n stands for n steps; the value sits under the centre mark.
            const n = first + i;
            const x = mid + (n - steps) * TICK;
            if (x < 0 || x > width) return null;
            const major = ((n % MAJOR) + MAJOR) % MAJOR === 0;
            // Fades towards both ends.
            const fade = Math.max(0, 1 - Math.abs(x - mid) / mid);
            return (
              <Line
                key={n}
                x1={x}
                x2={x}
                y1={major ? 0 : 3}
                y2={8}
                stroke={major ? c.fg2 : c.fg3}
                strokeWidth={major ? 1.5 : 1}
                opacity={0.7 * fade}
              />
            );
          })}
          <Line x1={mid} x2={mid} y1={0} y2={8} stroke={c.fg} strokeWidth={2} />
        </Svg>
      )}
    </View>
  );
}

/**
 * The rest countdown as the whole dock: the time left over a bone fill that drains, the rest's
 * length (tap to change it), −15 / +15 and Skip. A `band` (reps in reserve to pick) sits on top,
 * in the same panel and over the same fill, with a hairline under it.
 */
export function RestSlab({
  rest,
  band,
  onTime,
  onAdjust,
  onSkip,
}: {
  rest: Rest;
  band?: ReactNode;
  /** Omit in the compact bar above an editor. */
  onTime?: () => void;
  onAdjust: (seconds: number) => void;
  onSkip: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const now = useTicker();
  const remaining = Math.ceil(restProgress(rest, now).left / 1000);
  const fill = useSharedValue(1);
  useEffect(() => {
    const { left } = restProgress(rest, Date.now());
    fill.value = left / (rest.totalSeconds * 1000);
    // It shows time passing, so it keeps moving even when the system asks for less motion.
    fill.value = withTiming(0, {
      duration: left,
      easing: Easing.linear,
      reduceMotion: ReduceMotion.Never,
    });
  }, [rest, fill]);
  // Scaled rather than resized, so moving every frame for minutes never relayouts.
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  const label = `Rest · ${clock(rest.totalSeconds)}`;
  return (
    <View style={[styles.restPanel, !onTime && styles.compactPanel]}>
      <Animated.View pointerEvents="none" style={[styles.restFill, fillStyle]} />
      {band ? (
        <View style={styles.restBand}>
          {band}
          <View style={styles.restBandRule} />
        </View>
      ) : null}
      <View style={[styles.rest, !onTime && styles.compactRest]}>
        {onTime ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Rest, ${clock(remaining)} left of ${clock(rest.totalSeconds)}. Change the rest time`}
            onPress={onTime}
            scaleTo={0.98}
            style={styles.restTime}
          >
            <View style={styles.restLabelRow}>
              <Text style={styles.restLabel}>{label}</Text>
              <EditIcon color={c.rest.ink2} size={12} />
            </View>
            <Text accessibilityRole="timer" style={styles.restClock}>
              {clock(remaining)}
            </Text>
          </Tap>
        ) : (
          <View
            accessible
            accessibilityRole="timer"
            accessibilityLabel={`Rest, ${clock(remaining)} left of ${clock(rest.totalSeconds)}`}
            style={styles.compactTime}
          >
            <Text numberOfLines={1} adjustsFontSizeToFit style={styles.compactClock}>
              {clock(remaining)}
            </Text>
            <Text numberOfLines={1} style={[styles.restLabel, styles.compactLabel]}>
              {label}
            </Text>
          </View>
        )}
        <View style={styles.restButtons}>
          <Tap
            accessibilityRole="button"
            accessibilityLabel="15 seconds less"
            onPress={() => onAdjust(-15)}
            style={[styles.restButton, !onTime && styles.compactButton]}
          >
            <Text style={styles.restButtonText}>−15</Text>
          </Tap>
          <Tap
            accessibilityRole="button"
            accessibilityLabel="15 seconds more"
            onPress={() => onAdjust(15)}
            style={[styles.restButton, !onTime && styles.compactButton]}
          >
            <Text style={styles.restButtonText}>+15</Text>
          </Tap>
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Skip rest"
            onPress={onSkip}
            style={[
              styles.restButton,
              styles.skip,
              !onTime && styles.compactButton,
              !onTime && styles.compactSkip,
            ]}
          >
            <Text style={styles.skipText}>Skip</Text>
          </Tap>
        </View>
      </View>
    </View>
  );
}

/** The set a DockLine is about: its marker, which opens that set's editor. */
export interface LineMarker {
  label: string;
  onPress: () => void;
}

/**
 * The line marker's touch around its 20 pt chip: 44 pt across and 44 pt high, reaching up into the
 * dock's top padding and down only as far as the line's own padding, so it never covers the strip.
 */
export const MARKER_SLOP = { top: 15, bottom: 9, left: 12, right: 12 } as const;

/**
 * A line over the dock: something on the left (bold parts in bone), something on the right, and
 * optionally the set's marker before it all.
 */
export function DockLine({
  left,
  right,
  marker,
}: {
  left: ReactNode;
  right?: ReactNode;
  marker?: LineMarker;
}) {
  const styles = useStyles(sheet);
  const text = (
    <Text style={styles.lineLeft} numberOfLines={1}>
      {left}
    </Text>
  );
  return (
    <View style={[styles.line, marker && styles.lineMarked]}>
      {marker ? (
        <View style={styles.lineLead}>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Set ${marker.label}`}
            accessibilityHint="Its type, or remove it"
            hitSlop={MARKER_SLOP}
            onPress={marker.onPress}
            scaleTo={0.92}
            style={styles.lineMarker}
          >
            <Text style={styles.lineMarkerText}>{marker.label}</Text>
          </Tap>
          {text}
        </View>
      ) : (
        text
      )}
      {right ? (
        <Text style={styles.lineRight} numberOfLines={1}>
          {right}
        </Text>
      ) : null}
    </View>
  );
}

/** Bold text inside a DockLine. */
export function Strong({ children }: { children: string }) {
  const styles = useStyles(sheet);
  return <Text style={styles.strong}>{children}</Text>;
}

const sheet = themedStyles((c) => ({
  pad: { gap: 6, marginTop: 10 },
  padRow: { flexDirection: "row", gap: 6 },
  key: {
    flexGrow: 1,
    flexBasis: 0,
    height: 48,
    borderRadius: radius.input,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  keyTall: { height: 52 },
  keyBlank: { backgroundColor: "transparent", borderColor: "transparent" },
  fnKey: { backgroundColor: c.s2, borderColor: c.line2 },
  digit: { ...numeral(25, "300"), color: c.fg },
  fnText: { ...font.monoSemi, fontSize: 12, letterSpacing: 0.6, color: c.fg2 },
  // Twice a key's width and the gap between: see the row's gap.
  goKey: { flexGrow: 2, flexBasis: 6, backgroundColor: c.fg, borderColor: c.fg, gap: 3 },
  goLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  goText: { ...type.action, fontSize: 10.5, letterSpacing: 1.5, color: c.bg },
  goTo: { ...font.mono, fontSize: 9.5, color: c.bg, opacity: 0.72, maxWidth: "92%" },
  editHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 4,
  },
  editTarget: { flexDirection: "row", alignItems: "center", gap: 9, flex: 1, minWidth: 0 },
  editText: { flex: 1, minWidth: 0, gap: 4 },
  editExercise: { ...font.bodySemi, fontSize: 14.5, lineHeight: 17, color: c.fg },
  editDetail: { ...type.label, color: c.fg3 },
  done: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 11,
    backgroundColor: c.fg,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  doneText: { ...type.action, fontSize: 10, letterSpacing: 1.4, color: c.bg },
  // 36 pt drawn, 44 pt to touch (see its hitSlop), the same height as Done.
  cancel: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  marker: {
    height: 30,
    minWidth: 30,
    paddingHorizontal: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.fg3,
    alignItems: "center",
    justifyContent: "center",
  },
  markerLogged: { borderStyle: "solid", borderColor: c.s3, backgroundColor: c.s3 },
  markerText: { ...font.monoSemi, fontSize: 12, color: c.fg },
  strip: {
    flexDirection: "row",
    height: 72,
    borderRadius: radius.card,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    overflow: "hidden",
  },
  segment: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    borderLeftWidth: 1,
    borderLeftColor: c.line,
  },
  segmentOn: { backgroundColor: c.s2, borderWidth: 1.5, borderColor: c.fg },
  // Above the value, so the touch each reaches into it with is theirs.
  stepper: { alignItems: "center", justifyContent: "center", zIndex: 1 },
  value: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    overflow: "hidden",
  },
  valueText: { ...numeral(31, "200"), lineHeight: 31, color: c.fg },
  valueHint: { color: c.fg2 },
  valueUnit: { ...type.label, fontSize: 9.5, color: c.fg2 },
  valueStep: { color: c.fg2, letterSpacing: 0.4 },
  ruler: { width: "80%", height: 8 },
  check: { alignItems: "center", justifyContent: "center", backgroundColor: c.commit },
  checkOff: { opacity: 0.35 },
  restPanel: {
    borderRadius: radius.card,
    backgroundColor: c.rest.bg,
    borderWidth: 1,
    borderColor: c.rest.line,
    overflow: "hidden",
  },
  compactPanel: { borderRadius: radius.button },
  compactRest: { height: 54, gap: 6 },
  compactTime: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 4,
  },
  compactClock: { ...numeral(30), color: c.rest.ink, maxWidth: "100%" },
  compactLabel: { flexShrink: 1 },
  compactButton: { height: touch, minWidth: 46, borderRadius: 12 },
  compactSkip: { minWidth: 58 },
  restBand: { height: 46 },
  restBandRule: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: c.rest.ink,
    opacity: 0.2,
  },
  rest: {
    height: 92,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 8,
    paddingRight: 10,
  },
  restFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "100%",
    backgroundColor: c.rest.fill,
    transformOrigin: "left",
  },
  restTime: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    justifyContent: "center",
    paddingLeft: 10,
    borderRadius: radius.button,
  },
  restLabelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  restLabel: { ...type.label, color: c.rest.ink2 },
  restClock: { ...numeral(50, "200"), lineHeight: 50, color: c.rest.ink, marginTop: 6 },
  restButtons: { flexDirection: "row", gap: 6 },
  restButton: {
    height: 56,
    minWidth: 50,
    paddingHorizontal: 9,
    borderRadius: radius.button,
    backgroundColor: c.rest.button,
    alignItems: "center",
    justifyContent: "center",
  },
  restButtonText: { ...font.monoSemi, fontSize: 11, letterSpacing: 0.6, color: c.rest.ink },
  skip: { backgroundColor: c.rest.skip, minWidth: 64 },
  skipText: { ...type.action, fontSize: 11, color: c.rest.skipInk },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    paddingHorizontal: 4,
    paddingBottom: 9,
  },
  lineMarked: { alignItems: "center" },
  lineLead: { flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1, minWidth: 0 },
  lineMarker: {
    height: 20,
    minWidth: 20,
    paddingHorizontal: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.fg3,
    alignItems: "center",
    justifyContent: "center",
  },
  lineMarkerText: { ...font.monoSemi, fontSize: 10.5, color: c.fg },
  lineLeft: { ...type.label, color: c.fg2, flexShrink: 1 },
  lineRight: { ...type.label, color: c.fg3, flexShrink: 0 },
  strong: { color: c.fg, fontWeight: "600" },
}));
