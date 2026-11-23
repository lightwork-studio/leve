import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { numeral, touch, type } from "../theme.ts";
import { ChevronIcon, MinusIcon, PlusIcon } from "./icons.tsx";
import { fade } from "./motion.ts";
import { type Anchor, type MenuItem, PopoverMenu, useAnchor } from "./popover-menu.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";
import { Toggle } from "./toggle.tsx";

/** A row's text: its label with an optional mono hint under it. */
function RowText({
  label,
  hint,
  danger = false,
}: {
  label: string;
  hint?: string;
  danger?: boolean;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.text}>
      <Text style={[styles.label, danger && styles.danger]}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * A settings-style row (54 pt): a label and optional hint on the left, and on the right whatever
 * sets it, such as a small segmented control. Rows after the first in a card get a `divider`.
 */
export function SettingRow({
  label,
  hint,
  divider = false,
  children,
}: {
  label: string;
  hint?: string;
  divider?: boolean;
  children: ReactNode;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={[styles.row, divider && styles.divider]}>
      <RowText label={label} {...(hint ? { hint } : {})} />
      {children}
    </View>
  );
}

/**
 * A row for one choice out of a longer list: the current value and a chevron, opening a menu of
 * the choices with the current one checked. Picking one calls `onChoose` with its value.
 */
export function ChoiceRow<V>({
  label,
  hint,
  value,
  choices,
  onChoose,
  divider = false,
}: {
  label: string;
  hint?: string;
  value: V;
  choices: readonly { value: V; label: string }[];
  onChoose: (value: V) => void;
  divider?: boolean;
}) {
  const current = choices.find((choice) => choice.value === value)?.label ?? String(value);
  return (
    <MenuRow
      label={label}
      {...(hint ? { hint } : {})}
      value={current}
      divider={divider}
      menu={{
        title: label,
        items: choices.map((choice) => ({
          label: choice.label,
          checked: choice.value === value,
          onPress: () => {
            if (choice.value !== value) onChoose(choice.value);
          },
        })),
      }}
    />
  );
}

/** A row showing a value and a chevron that opens a menu (see ChoiceRow). */
export function MenuRow({
  label,
  hint,
  value,
  menu,
  divider = false,
}: {
  label: string;
  hint?: string;
  value: string;
  menu: { title?: string; meta?: string; items: readonly MenuItem[] };
  divider?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const anchor = useAnchor();
  const [open, setOpen] = useState<Anchor | null>(null);
  return (
    <>
      <Tap
        ref={anchor.ref}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value}`}
        accessibilityHint={hint}
        accessibilityState={{ expanded: open !== null }}
        onPress={() => anchor.measure(setOpen)}
        scaleTo={0.98}
        style={[styles.row, divider && styles.divider]}
      >
        <RowText label={label} {...(hint ? { hint } : {})} />
        {/* A new value fades in, so the change is seen. */}
        <Animated.Text key={value} entering={fade} style={styles.value}>
          {value}
        </Animated.Text>
        <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
      </Tap>
      {open && (
        <PopoverMenu
          anchor={open}
          {...(menu.title ? { title: menu.title } : {})}
          {...(menu.meta ? { meta: menu.meta } : {})}
          label={label}
          items={menu.items}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** An on/off row: the whole row is the switch, drawn with the app's toggle. */
export function ToggleRow({
  label,
  hint,
  on,
  onChange,
  divider = false,
  disabled = false,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  divider?: boolean;
  disabled?: boolean;
}) {
  const styles = useStyles(sheet);
  return (
    <Tap
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: on, disabled }}
      aria-checked={on}
      disabled={disabled}
      onPress={() => onChange(!on)}
      scaleTo={0.98}
      style={[styles.row, divider && styles.divider, disabled && styles.off]}
    >
      <RowText label={label} {...(hint ? { hint } : {})} />
      <Toggle on={on} />
    </Tap>
  );
}

/** A row that does one thing when tapped, such as a destructive action in red. */
export function ActionRow({
  label,
  hint,
  onPress,
  danger = false,
  divider = false,
  accessibilityHint,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  danger?: boolean;
  divider?: boolean;
  accessibilityHint?: string;
}) {
  const styles = useStyles(sheet);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint ?? hint}
      onPress={onPress}
      scaleTo={0.98}
      style={[styles.row, divider && styles.divider]}
    >
      <RowText label={label} {...(hint ? { hint } : {})} danger={danger} />
    </Tap>
  );
}

/**
 * A number set by steps: − and + tiles around the value. Tapping the value does `onPressValue`
 * (to type it, or pick from a list) when given.
 */
export function Stepper({
  value,
  label,
  onStep,
  canDecrease = true,
  canIncrease = true,
  onPressValue,
  valueHint,
  compact = false,
}: {
  value: string;
  /** What is being stepped, for screen readers: "Default rest". */
  label: string;
  onStep: (direction: -1 | 1) => void;
  canDecrease?: boolean;
  canIncrease?: boolean;
  onPressValue?: () => void;
  valueHint?: string;
  compact?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const tile = [styles.step, compact && styles.stepCompact];
  return (
    <View style={styles.stepper}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Less ${label.toLowerCase()}`}
        accessibilityState={{ disabled: !canDecrease }}
        disabled={!canDecrease}
        onPress={() => onStep(-1)}
        scaleTo={0.92}
        style={[tile, !canDecrease && styles.off]}
      >
        <MinusIcon color={c.fg} size={17} strokeWidth={2} />
      </Tap>
      {onPressValue ? (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${value}`}
          accessibilityHint={valueHint}
          onPress={onPressValue}
          scaleTo={0.96}
          style={[styles.stepValue, styles.stepValueTap]}
        >
          <Text style={[styles.stepNumber, compact && styles.stepNumberCompact]}>{value}</Text>
        </Tap>
      ) : (
        <View accessible accessibilityLabel={`${label}, ${value}`} style={styles.stepValue}>
          <Text style={[styles.stepNumber, compact && styles.stepNumberCompact]}>{value}</Text>
        </View>
      )}
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`More ${label.toLowerCase()}`}
        accessibilityState={{ disabled: !canIncrease }}
        disabled={!canIncrease}
        onPress={() => onStep(1)}
        scaleTo={0.92}
        style={[tile, !canIncrease && styles.off]}
      >
        <PlusIcon color={c.fg} size={17} strokeWidth={2} />
      </Tap>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 54,
    paddingVertical: 9,
    paddingLeft: 16,
    paddingRight: 14,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  off: { opacity: 0.35 },
  text: { flex: 1, minWidth: 0 },
  label: { ...type.body, fontSize: 14.5, lineHeight: 19, color: c.fg },
  danger: { color: c.danger },
  hint: { ...type.meta, fontSize: 10, lineHeight: 14, color: c.fg3, marginTop: 2 },
  value: { ...type.value, fontSize: 12.5, color: c.fg2 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  step: {
    width: touch,
    height: touch,
    borderRadius: 13,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  stepCompact: { width: 40, height: 40, borderRadius: 12 },
  stepValue: { minWidth: 70, minHeight: touch, alignItems: "center", justifyContent: "center" },
  stepValueTap: { borderBottomWidth: 1.5, borderBottomColor: c.line2 },
  stepNumber: { ...numeral(32, "300"), color: c.fg, textAlign: "center" },
  stepNumberCompact: { ...numeral(28, "300") },
}));
