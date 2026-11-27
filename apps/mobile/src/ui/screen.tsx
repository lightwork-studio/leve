import { type ComponentRef, createContext, type ReactNode, type Ref, useContext } from "react";
import { ScrollView, Text, View } from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, space, touch, type } from "../theme.ts";
import { StillOnOpen } from "./enter.tsx";
import { ChevronIcon } from "./icons.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";
import { useWeekBarFold } from "./week-bar-fold.ts";

/** A tab screen's large title, with an optional small caps line above it and an action beside it. */
export function TabTitle({
  title,
  eyebrow,
  action,
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.header}>
      <View style={styles.titles}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      </View>
      {action}
    </View>
  );
}

/** A small square button for a header: an icon on a card-coloured tile. */
export function HeaderButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const styles = useStyles(sheet);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      scaleTo={0.92}
      style={styles.headerButton}
    >
      {children}
    </Tap>
  );
}

/**
 * The week bar's action: a bare icon, no tile, so the bar stays quiet. It is drawn smaller than a
 * touch target and reaches out to one past its edges.
 */
export function BarButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const styles = useStyles(sheet);
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      scaleTo={0.9}
      hitSlop={BAR_BUTTON_SLOP}
      style={styles.barButton}
    >
      {children}
    </Tap>
  );
}

/** Reaches the bar button's 36 × 32 out to 48 × 44. */
const BAR_BUTTON_SLOP = 6;

/** The way back from a pushed screen: a chevron and the name of where it goes. */
export function BackButton({
  label,
  onPress,
  accessibilityLabel,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      scaleTo={0.96}
      style={styles.back}
    >
      <ChevronIcon direction="left" color={c.fg2} size={18} strokeWidth={2} />
      <Text style={styles.backLabel} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

/**
 * The header of a pushed screen: a back button on the left, the title centred, and an optional
 * action on the right (or space the back button's width, so the title stays centred).
 */
export function ScreenHeader({
  title,
  back,
  backLabel,
  backAccessibilityLabel,
  action,
}: {
  title: string;
  back: () => void;
  backLabel: string;
  backAccessibilityLabel?: string;
  action?: ReactNode;
}) {
  const styles = useStyles(sheet);
  return (
    <View style={styles.screenHeader}>
      <View style={styles.side}>
        <BackButton
          label={backLabel}
          onPress={back}
          {...(backAccessibilityLabel ? { accessibilityLabel: backAccessibilityLabel } : {})}
        />
      </View>
      <Text accessibilityRole="header" style={styles.screenTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={[styles.side, styles.sideEnd]}>{action}</View>
    </View>
  );
}

/** How much of a tab screen's bottom the floating tabs and the main action above them cover. */
export const MainActionHeight = createContext(0);

/** Padding for a tab screen's scrolling content, for screens that scroll a list of their own. */
export function useTabBottomPadding() {
  return space.xxl + useContext(MainActionHeight);
}

export const tabContentStyle = { paddingHorizontal: space.lg, paddingBottom: space.xxl } as const;

/** The space above a tab's content, under the week bar (which keeps clear of the status bar). */
export const tabTopPadding = space.lg;

/**
 * For a tab's scrolling list: content that starts under the week bar floating over it, and the
 * scroll handler that folds the bar as the list moves.
 */
export function useTabScroll() {
  const { height, onScroll } = useWeekBarFold();
  return {
    paddingTop: height + tabTopPadding,
    scrollProps: { onScroll, scrollEventThrottle: 16, scrollIndicatorInsets: { top: height } },
  };
}

/**
 * A screen's scrolling content under a large title with an optional action beside it. Without a
 * title it is a tab under the week bar, which leads it instead.
 */
export function TabScreen({
  title,
  eyebrow,
  action,
  children,
  hasTextInput = false,
  scrollEnabled = true,
  scrollRef,
}: {
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  hasTextInput?: boolean;
  /** Off while a drag grip is held, so the page stays still under the finger. */
  scrollEnabled?: boolean;
  scrollRef?: Ref<ComponentRef<typeof ScrollView>>;
}) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  const paddingBottom = useTabBottomPadding();
  const tab = useTabScroll();
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      {...(title === undefined ? tab.scrollProps : {})}
      scrollEnabled={scrollEnabled}
      automaticallyAdjustKeyboardInsets={hasTextInput}
      keyboardShouldPersistTaps={hasTextInput ? "handled" : "never"}
      contentContainerStyle={[
        styles.content,
        { paddingTop: title === undefined ? tab.paddingTop : insets.top + 20, paddingBottom },
      ]}
    >
      {title !== undefined && <TabTitle title={title} eyebrow={eyebrow} action={action} />}
      {/* Content shown on opening is simply there; only later changes animate. */}
      <StillOnOpen>{children}</StillOnOpen>
    </ScrollView>
  );
}

const sheet = themedStyles((c) => ({
  screenHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  side: { flexDirection: "row", alignItems: "center", minWidth: 96, minHeight: touch },
  sideEnd: { justifyContent: "flex-end" },
  // Text, not a tile: the chevron and the parent's name in the small capitals the app's other
  // text controls use. The target stays 44 pt tall and runs on past the last letter.
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: touch,
    minWidth: touch,
    maxWidth: 200,
    paddingLeft: 2,
    paddingRight: 12,
    borderRadius: 12,
  },
  backLabel: { ...type.action, letterSpacing: 1.26, color: c.fg2, flexShrink: 1 },
  screenTitle: { flex: 1, textAlign: "center", ...type.rowTitle, fontSize: 15, color: c.fg },
  barButton: {
    width: 36,
    height: 32,
    marginRight: -4,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButton: {
    width: touch,
    height: touch,
    borderRadius: radius.input,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { flex: 1, backgroundColor: c.bg },
  content: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.xl },
  header: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  titles: { flex: 1, gap: 9 },
  eyebrow: { ...type.label, color: c.fg3 },
  title: { ...type.title, color: c.fg },
}));
