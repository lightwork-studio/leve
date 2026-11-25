import { type ComponentRef, forwardRef, type ReactNode, useState } from "react";
import {
  type StyleProp,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { font, mix, type } from "../theme.ts";
import { WarnIcon } from "./icons.tsx";
import { Shake } from "./shake.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/**
 * What went wrong with a form, said once where it happened and read out as it appears: a mono line
 * in vermilion, the same as a field's helper line once it turns into an error. Every form shows its
 * problems through this one piece, so how they look can change in one place.
 */
export function FieldError({ message }: { message: string }) {
  const styles = useStyles(sheet);
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {message}
    </Text>
  );
}

/**
 * The quiet line under a field: a hint on the left, a count on the right. When a save is refused,
 * the hint gives way to the message in vermilion, read out as it appears. It is always there, even
 * when empty, so an error never pushes anything down.
 */
export function HelperLine({
  hint,
  count,
  over = false,
  error,
}: {
  hint?: string;
  /** "12 / 30": how much of the limit is used. */
  count?: string;
  /** The count is past the limit, so it turns vermilion too. */
  over?: boolean;
  error?: string;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.helper}>
      {error ? (
        <Text accessibilityRole="alert" style={[styles.helperText, styles.helperError]}>
          {error}
        </Text>
      ) : (
        <Text style={styles.helperText}>{hint ?? ""}</Text>
      )}
      {count ? <Text style={[styles.helperCount, over && styles.helperError]}>{count}</Text> : null}
    </View>
  );
}

/**
 * A problem with values shown in a card (a routine's exercises, say): a row of its own in the card,
 * a faintly tinted band with a vermilion rule at its edge and a warning mark.
 */
export function ErrorRow({ message, style }: { message: string; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(sheet);
  const c = useColors();
  if (!message) return null;
  return (
    <View accessibilityRole="alert" style={[styles.errorRow, style]}>
      <View style={styles.errorRule} />
      <WarnIcon color={c.alert} size={16} />
      <Text style={styles.errorRowText}>{message}</Text>
    </View>
  );
}

type FieldProps = Omit<TextInputProps, "style"> & {
  /** Small caps above the field. Without one, give it an `accessibilityLabel`. */
  label?: string;
  /** A quiet line under it: what the value is for. */
  hint?: string;
  /** Takes the hint's place, in vermilion, and rings the field; the field shakes once. */
  error?: string;
  /**
   * Counts refused saves, so refusing again with the same message shakes the field again. Without
   * it, the field shakes when the message changes.
   */
  attempt?: number;
  /** At the right of the helper line: "12 / 30". */
  count?: string;
  /** The count is past its limit. */
  over?: boolean;
  /** Mono text, for typed dates, times and numbers. */
  mono?: boolean;
  /** Something at the field's end, inside it (a unit, a count). */
  end?: ReactNode;
  /** What a screen reader calls the field when the visible label doesn't say it all. */
  spokenLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * A text field: a small caps label, a raised field with 16 pt text and a bone ring while typing,
 * then a helper line with a hint and a count. A refused save turns the helper line into the
 * message, rings the field in vermilion and shakes it once; nothing below moves.
 */
export const TextField = forwardRef<ComponentRef<typeof TextInput>, FieldProps>(function TextField(
  {
    label,
    hint,
    error,
    attempt,
    count,
    over = false,
    mono = false,
    end,
    spokenLabel,
    style,
    multiline,
    onFocus,
    onBlur,
    ...input
  },
  ref,
) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.field, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <Shake
        trigger={`${attempt ?? 0}:${error ?? ""}`}
        active={!!error}
        style={[
          styles.box,
          multiline && styles.area,
          focused && styles.focused,
          !!error && styles.invalid,
        ]}
      >
        <TextInput
          ref={ref}
          accessibilityLabel={spokenLabel ?? input.accessibilityLabel ?? label}
          aria-invalid={error ? true : undefined}
          placeholderTextColor={c.fg3}
          multiline={multiline}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          {...input}
          style={[styles.input, mono && styles.mono, multiline && styles.areaInput]}
        />
        {end}
        {focused || error ? (
          <View
            testID="field-ring"
            pointerEvents="none"
            style={[styles.ring, { borderColor: error ? c.alert : c.fg }]}
          />
        ) : null}
      </Shake>
      <HelperLine
        {...(hint ? { hint } : {})}
        {...(count ? { count } : {})}
        {...(error ? { error } : {})}
        over={over}
      />
    </View>
  );
});

/** A text field for a few lines: notes, a description, a reply. */
export const TextArea = forwardRef<ComponentRef<typeof TextInput>, Omit<FieldProps, "multiline">>(
  function TextArea(props, ref) {
    return <TextField ref={ref} multiline {...props} />;
  },
);

/**
 * A title typed straight onto the page: large sans text over an underline that turns bone while
 * typing. For a workout's or routine's name at the top of a form.
 */
export const TitleField = forwardRef<
  ComponentRef<typeof TextInput>,
  Omit<TextInputProps, "style"> & { label?: string; style?: StyleProp<ViewStyle> }
>(function TitleField({ label, style, onFocus, onBlur, ...input }, ref) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <View style={style}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        ref={ref}
        accessibilityLabel={input.accessibilityLabel ?? label}
        placeholderTextColor={c.fg3}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        {...input}
        style={[styles.title, focused && styles.titleFocused]}
      />
    </View>
  );
});

/** A field box's corner radius, which its ring follows. */
const BOX_RADIUS = 15;

const sheet = themedStyles((c) => ({
  field: { gap: 8 },
  label: { ...type.label, color: c.fg3, paddingHorizontal: 2 },
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 14,
    borderRadius: BOX_RADIUS,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line2,
  },
  // While the ring shows, the box's own border steps aside so the two don't stack at the corners.
  focused: { borderColor: "transparent" },
  invalid: { borderColor: "transparent" },
  // The ring while typing or refused: a real border laid over the box's own, so it stays even
  // around the corners (a half-point inset shadow drew them brighter than the straight edges) and
  // nothing inside moves.
  ring: {
    position: "absolute",
    top: -1,
    left: -1,
    right: -1,
    bottom: -1,
    borderRadius: BOX_RADIUS,
    borderWidth: 1.5,
  },
  area: { alignItems: "flex-start", minHeight: 92 },
  input: { ...type.body, fontSize: 16, flex: 1, minWidth: 0, color: c.fg, minHeight: 50 },
  mono: { ...font.mono, fontSize: 15, letterSpacing: 0.3 },
  areaInput: { minHeight: 90, paddingVertical: 13, lineHeight: 22, textAlignVertical: "top" },
  helper: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 16,
    paddingHorizontal: 2,
  },
  helperText: { ...font.mono, fontSize: 11, lineHeight: 16, color: c.fg3, flex: 1, minWidth: 0 },
  helperCount: { ...font.mono, fontSize: 11, lineHeight: 16, color: c.fg3, flexShrink: 0 },
  helperError: { color: c.alert },
  error: { ...font.mono, fontSize: 11, lineHeight: 16, color: c.alert, paddingHorizontal: 2 },
  errorRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingTop: 11,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: c.line,
    backgroundColor: mix(c.alert, c.s1, 0.07),
  },
  errorRule: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: c.alert,
  },
  errorRowText: { ...type.body, fontSize: 13, lineHeight: 19, color: c.fg, flex: 1, minWidth: 0 },
  title: {
    ...font.bodyBold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.5,
    color: c.fg,
    paddingTop: 6,
    paddingBottom: 10,
    marginTop: 8,
    borderBottomWidth: 1.5,
    borderBottomColor: c.line2,
  },
  titleFocused: { borderBottomColor: c.fg },
}));
