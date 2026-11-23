import { type ReactNode, useRef, useState } from "react";
import {
  type HostInstance,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { radius, touch, type } from "../theme.ts";
import { Enter } from "./enter.tsx";
import { haptic } from "./haptics.ts";
import { CheckIcon, MoreIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

/** Where on the screen the menu's tile or row is. */
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One row of a menu: an action, or (with `checked`) one choice of several. */
export interface MenuItem {
  label: string;
  onPress: () => void;
  /** A short value or hint on the right, in mono: "2:00". */
  value?: string;
  /** An icon on the right, drawn in the row's ink. */
  icon?: (color: string) => ReactNode;
  /** For a choice: whether it is the one chosen (a check on the right). */
  checked?: boolean;
  /** Red text, and listed last: it should lead to an action sheet, never act on its own. */
  destructive?: boolean;
  disabled?: boolean;
}

const MENU_WIDTH = 290;
const ROW_HEIGHT = 50;
const HEAD_HEIGHT = 62;
const EDGE = 12;

/**
 * Where a menu sits: under its anchor, right edges aligned, or above it when it would run off the
 * bottom of the screen. Kept on screen either way.
 */
export function menuPlacement(
  anchor: Anchor,
  screen: { width: number; height: number },
  menuHeight: number,
): {
  top?: number;
  bottom?: number;
  right: number;
  width: number;
  up: boolean;
  /** How tall its list of rows can be before it scrolls. */
  maxHeight: number;
} {
  const width = Math.min(MENU_WIDTH, screen.width - EDGE * 2);
  const maxHeight = screen.height - EDGE * 2 - HEAD_HEIGHT;
  const right = Math.max(EDGE, screen.width - (anchor.x + anchor.width));
  const below = anchor.y + anchor.height + 6;
  const fitsBelow = below + menuHeight <= screen.height - EDGE;
  const fitsAbove = anchor.y - 6 - menuHeight >= EDGE;
  if (fitsBelow || !fitsAbove) {
    return {
      top: Math.max(EDGE, Math.min(below, screen.height - EDGE - menuHeight)),
      right,
      width,
      up: false,
      maxHeight,
    };
  }
  return { bottom: screen.height - anchor.y + 6, right, width, up: true, maxHeight };
}

/** A ref for a menu's tile or row, and a way to find where it is when it is tapped. */
export function useAnchor() {
  const ref = useRef<HostInstance>(null);
  const measure = (then: (anchor: Anchor) => void) => {
    const node = ref.current as (HostInstance & { measureInWindow?: unknown }) | null;
    if (!node || typeof node.measureInWindow !== "function") {
      return then({ x: 0, y: 0, width: 0, height: 0 });
    }
    node.measureInWindow((x, y, width, height) => then({ x, y, width, height }));
  };
  return { ref, measure };
}

/**
 * A menu of actions growing from the tile or row that opened it: a header naming the thing, one
 * row per action with its value or icon on the right, and a destructive action last in red. It
 * dims the screen lightly; tapping outside, Escape or Android's back button closes it.
 */
export function PopoverMenu({
  anchor,
  title,
  meta,
  items,
  onClose,
  label,
}: {
  anchor: Anchor;
  title?: string;
  meta?: string;
  items: readonly MenuItem[];
  onClose: () => void;
  /** What a screen reader calls the menu, when it has no title. */
  label?: string;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const screen = useWindowDimensions();
  const ordered = [...items.filter((i) => !i.destructive), ...items.filter((i) => i.destructive)];
  const height = (title ? HEAD_HEIGHT : 0) + ordered.length * ROW_HEIGHT;
  const place = menuPlacement(anchor, screen, height);
  const choosing = ordered.some((item) => item.checked !== undefined);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} aria-label={title ?? label}>
      <View style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <Enter
          distance={place.up ? -6 : 6}
          role="menu"
          aria-label={title ?? label}
          accessibilityViewIsModal
          style={[
            styles.menu,
            {
              width: place.width,
              right: place.right,
              ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
            },
          ]}
        >
          {title ? (
            <View style={styles.head}>
              <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {meta ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {meta}
                </Text>
              ) : null}
            </View>
          ) : null}
          <ScrollView style={{ maxHeight: place.maxHeight }} bounces={false}>
            {ordered.map((item, i) => {
              const ink = item.destructive ? c.danger : c.fg;
              return (
                <Tap
                  key={item.label}
                  accessibilityRole={choosing ? "radio" : "menuitem"}
                  accessibilityState={{
                    disabled: !!item.disabled,
                    ...(choosing ? { checked: !!item.checked } : {}),
                  }}
                  {...(choosing ? { "aria-checked": !!item.checked } : {})}
                  accessibilityLabel={[item.label, item.value].filter(Boolean).join(", ")}
                  disabled={item.disabled}
                  onPress={() => {
                    haptic.select();
                    onClose();
                    // iOS can't show another sheet while this one is still closing.
                    if (Platform.OS === "ios") setTimeout(item.onPress, 320);
                    else item.onPress();
                  }}
                  scaleTo={0.99}
                  style={[
                    styles.item,
                    (i > 0 || title) && styles.divider,
                    item.disabled && styles.off,
                  ]}
                >
                  <Text style={[styles.itemLabel, { color: ink }]} numberOfLines={1}>
                    {item.label}
                  </Text>
                  <View style={styles.end}>
                    {item.value ? <Text style={styles.value}>{item.value}</Text> : null}
                    {item.icon?.(item.destructive ? c.danger : c.fg2)}
                    {item.checked ? <CheckIcon color={c.fg} size={18} strokeWidth={2.4} /> : null}
                  </View>
                </Tap>
              );
            })}
          </ScrollView>
        </Enter>
      </View>
    </Modal>
  );
}

/**
 * The ⋯ tile that opens a menu, sized like the other header tiles. `items` is read when it is
 * tapped, so it can depend on the latest data.
 */
export function MoreButton({
  label,
  title,
  meta,
  items,
  small = false,
}: {
  /** What it is for, for screen readers: "Workout options". */
  label: string;
  title?: string;
  meta?: string;
  items: readonly MenuItem[];
  /** A 36 pt tile, for a row or a folder heading (it still takes a 44 pt tap). */
  small?: boolean;
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
        accessibilityLabel={label}
        accessibilityState={{ expanded: open !== null }}
        hitSlop={small ? 4 : 0}
        onPress={() => anchor.measure(setOpen)}
        scaleTo={0.92}
        style={[styles.tile, small && styles.small]}
      >
        <MoreIcon color={c.fg2} size={small ? 18 : 20} />
      </Tap>
      {open && (
        <PopoverMenu
          anchor={open}
          {...(title ? { title } : {})}
          {...(meta ? { meta } : {})}
          label={label}
          items={items}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

const sheet = themedStyles((c) => ({
  overlay: { flex: 1, backgroundColor: `${c.bg}59` },
  menu: {
    position: "absolute",
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line2,
    borderRadius: 20,
    overflow: "hidden",
    boxShadow: c.shadow,
  },
  head: { paddingTop: 13, paddingBottom: 11, paddingHorizontal: 16, gap: 5 },
  title: { ...type.rowTitle, fontSize: 15.5, color: c.fg },
  meta: { ...type.label, color: c.fg3 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: ROW_HEIGHT,
    paddingLeft: 16,
    paddingRight: 14,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  off: { opacity: 0.35 },
  itemLabel: { ...type.body, flex: 1, minWidth: 0 },
  end: { flexDirection: "row", alignItems: "center", gap: 8 },
  value: { ...type.value, color: c.fg2 },
  tile: {
    width: touch,
    height: touch,
    borderRadius: radius.input,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  small: { width: 36, height: 36, borderRadius: 12 },
}));
