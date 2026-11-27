import type { WeightUnit } from "@leve/core";
import { Link, useLocalSearchParams, useNavigation } from "expo-router";
import { type ComponentRef, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  SectionList,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useHistory, useProgress } from "../../src/data/queries.ts";
import {
  displayedWorkoutTitle,
  filterHistoryMonths,
  type HistorySearchWorkout,
  monthOdometer,
  monthPages,
  type WorkoutSummary,
} from "../../src/model/past-workouts.ts";
import { recordsByWorkout, type WorkoutRecord } from "../../src/model/progress.ts";
import { numeral, radius, space, touch, type } from "../../src/theme.ts";
import { SetBarcode } from "../../src/ui/barcode.tsx";
import { Flash, flashDuration } from "../../src/ui/flash.tsx";
import { outOfReach } from "../../src/ui/focus.ts";
import {
  durationLabel,
  historySetLabel,
  monthLabel,
  readoutWeight,
  timeLabel,
  workoutMinutesLabel,
} from "../../src/ui/format.ts";
import { ChevronIcon, CloseIcon, SearchIcon } from "../../src/ui/icons.tsx";
import { BarAction } from "../../src/ui/main-action.tsx";
import { MonthCard } from "../../src/ui/month-odometer.tsx";
import { RecordMark } from "../../src/ui/record-mark.tsx";
import {
  BarButton,
  tabContentStyle,
  useTabBottomPadding,
  useTabScroll,
} from "../../src/ui/screen.tsx";
import { SearchField } from "../../src/ui/search-field.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { useToday } from "../../src/ui/use-now.ts";
import { WorkoutSyncReview } from "../../src/ui/workout-sync-review.tsx";

type Month = ReturnType<typeof useHistory>["months"][number];
type Records = ReadonlyMap<string, WorkoutRecord[]>;
type Section = { month: Month; key: string; data: HistorySearchWorkout[] };
const NO_RECORDS: WorkoutRecord[] = [];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/**
 * How long the workout just saved waits to be picked out when the finish sheet's closing doesn't
 * say it has finished: long enough for the sheet to be gone (280 ms in browsers, about 500 ms on
 * phones, where the tabs under a running workout aren't told when it closes).
 */
export const savedSettleMs = Platform.OS === "web" ? 450 : 750;

export default function HistoryScreen() {
  const [query, setQuery] = useState("");
  const { saved } = useLocalSearchParams<{ saved?: string }>();
  const today = useToday();
  const { months, settings, rejectedDeletions } = useHistory();
  const list = useRef<SectionList<HistorySearchWorkout, Section>>(null);
  const reduced = useReducedMotion();
  const lit = useJustSaved(saved, months, setQuery);
  const { index } = useProgress();
  const styles = useStyles(sheet);
  const c = useColors();
  const search = useRef<ComponentRef<typeof TextInput>>(null);
  // The field heads the list: scroll back to it, then open it for typing.
  const openSearch = useCallback(() => {
    list.current?.getScrollResponder()?.scrollTo({ y: 0, animated: !reduced });
    search.current?.focus();
  }, [reduced]);
  const paddingBottom = useTabBottomPadding();
  const { paddingTop, scrollProps } = useTabScroll();
  const records = useMemo(() => recordsByWorkout(index), [index]);
  // A virtualised list: only the rows near the screen are rendered, so years of workouts open as
  // quickly as a few weeks.
  const sections = useMemo(
    (): Section[] =>
      filterHistoryMonths(months, query).map((month) => ({
        month,
        key: month.key,
        data: month.workouts,
      })),
    [months, query],
  );
  const unit = settings.weightUnit;
  const renderItem = useCallback(
    ({
      item,
      index: at,
      section,
    }: {
      item: HistorySearchWorkout;
      index?: number;
      section?: { month: Month };
    }) => (
      <SessionRow
        workout={item}
        unit={unit}
        records={records.get(item.id) ?? NO_RECORDS}
        flash={item.id === lit}
        first={(at ?? 0) === 0}
        // A section's month holds just the workouts it lists (see filterHistoryMonths).
        last={!section || (at ?? 0) === section.month.workouts.length - 1}
      />
    ),
    [unit, records, lit],
  );
  // The row just lit is brought to the middle of the screen, once: on a phone it usually sits
  // below the month card, out of sight. (A section's items count from 1: its header is 0.)
  const scrolledTo = useRef<string | null>(null);
  // Kept until the scroll has been retried, for a row that hadn't been drawn yet.
  const retry = useRef<Parameters<SectionList["scrollToLocation"]>[0] | null>(null);
  useEffect(() => {
    if (!lit || scrolledTo.current === lit) return;
    const sectionIndex = sections.findIndex((s) => s.data.some((w) => w.id === lit));
    const section = sections[sectionIndex];
    if (!section) return;
    scrolledTo.current = lit;
    const location = {
      sectionIndex,
      itemIndex: section.data.findIndex((w) => w.id === lit) + 1,
      viewPosition: 0.5,
      animated: !reduced,
    };
    retry.current = location;
    list.current?.scrollToLocation(location);
  }, [lit, sections, reduced]);
  const renderSectionHeader = useCallback(
    ({ section }: { section: { month: Month } }) => (
      <MonthHeader month={section.month} unit={unit} />
    ),
    [unit],
  );
  return (
    <SectionList
      ref={list}
      style={styles.scroll}
      {...scrollProps}
      contentContainerStyle={[tabContentStyle, { paddingTop, paddingBottom }]}
      sections={sections}
      keyboardShouldPersistTaps="handled"
      keyExtractor={(workout) => workout.id}
      stickySectionHeadersEnabled={false}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={7}
      // A row not drawn yet can't be scrolled to exactly: head for about where it is, so it gets
      // drawn, and try once more.
      onScrollToIndexFailed={({ averageItemLength, index: at }) => {
        list.current
          ?.getScrollResponder()
          ?.scrollTo({ y: averageItemLength * at, animated: false });
        const location = retry.current;
        retry.current = null;
        if (location) setTimeout(() => list.current?.scrollToLocation(location), 100);
      }}
      ListHeaderComponent={
        <View style={styles.head}>
          {/* Search sits beside the week over the tabs: it brings the field into view and opens it. */}
          <BarAction>
            <BarButton label="Search workouts or exercises" onPress={openSearch}>
              <SearchIcon color={c.fg2} size={18} />
            </BarButton>
          </BarAction>
          {rejectedDeletions.map((record) => (
            <WorkoutSyncReview
              key={record.id}
              workoutId={record.id}
              record={record}
              readOnlyReason={null}
            />
          ))}
          <MonthPager
            months={months}
            today={today}
            unit={unit}
            firstWeekday={settings.firstWeekday}
            records={records}
          />
          <SearchField
            ref={search}
            label="Search workouts or exercises"
            placeholder="Search workouts or exercises"
            value={query}
            onChangeText={setQuery}
          />
        </View>
      }
      ListEmptyComponent={
        query.trim() ? (
          <NoResults query={query.trim()} onClear={() => setQuery("")} />
        ) : (
          <Text accessibilityLiveRegion="polite" style={styles.empty}>
            No workouts yet.
          </Text>
        )
      }
      renderSectionHeader={renderSectionHeader}
      renderItem={renderItem}
    />
  );
}

/**
 * The workout just saved (passed in as `saved` on the way to History), picked out once: a search
 * that would hide it is cleared, and when the finish sheet has gone its id is returned for as long
 * as its row stays lit. It is then taken off the route, so coming back to History or reloading
 * doesn't light it again.
 */
function useJustSaved(
  saved: string | undefined,
  months: Month[],
  setQuery: (update: (query: string) => string) => void,
): string | null {
  const navigation = useNavigation();
  const [arriving, setArriving] = useState<string | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!saved) return;
    setArriving(saved);
    setQuery((query) =>
      filterHistoryMonths(months, query).some((month) => month.workouts.some((w) => w.id === saved))
        ? query
        : "",
    );
    navigation.setParams({ saved: undefined } as never);
  }, [saved, months, setQuery, navigation]);
  // Lit once the finish sheet over History has closed, or after a moment when its closing isn't
  // reported (browsers report only the closing screen's own transition).
  useEffect(() => {
    if (!arriving) return;
    let off: ReturnType<typeof setTimeout> | undefined;
    const light = () => {
      if (off) return;
      setLit(arriving);
      off = setTimeout(() => {
        setLit(null);
        setArriving(null);
      }, flashDuration);
    };
    const settle = setTimeout(light, savedSettleMs);
    const stop = navigation.getParent()?.addListener("transitionEnd" as never, (event: never) => {
      if (!(event as { data?: { closing?: boolean } }).data?.closing) light();
    });
    return () => {
      clearTimeout(settle);
      clearTimeout(off);
      stop?.();
    };
  }, [arriving, navigation]);
  return lit;
}

/**
 * A search that found nothing: what search looks at, and a row at the card's foot that clears it
 * (as the ✕ in the field does).
 */
function NoResults({ query, onClear }: { query: string; onClear: () => void }) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <View>
      <View style={styles.results}>
        <Text style={styles.label}>0 results</Text>
        <Text style={styles.label}>Names and exercises</Text>
      </View>
      <View style={styles.noResults}>
        <View accessibilityLiveRegion="polite" style={styles.noResultsBody}>
          <View style={styles.noResultsIcon}>
            <SearchIcon color={c.fg3} size={21} />
          </View>
          <Text accessibilityRole="header" style={styles.noResultsTitle}>
            {`Nothing matches “${query}”`}
          </Text>
          <Text style={styles.noResultsText}>
            Search looks at workout names and the exercises in them.
          </Text>
        </View>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={onClear}
          scaleTo={0.98}
          style={styles.clear}
        >
          <CloseIcon color={c.fg2} size={14} />
          <Text style={styles.clearText}>Clear search</Text>
        </Tap>
      </View>
    </View>
  );
}

/**
 * The month at a glance, a page per month laid out oldest to newest like a calendar, opening on the
 * current month at the right-hand end. Browsed by swiping (right goes back in time) or with the
 * buttons beside its name (disabled at either end, so both while there is one month). A trained
 * date lists its sessions under the card.
 */
function MonthPager({
  months,
  today,
  unit,
  firstWeekday,
  records,
}: {
  months: Month[];
  today: number;
  unit: WeightUnit;
  firstWeekday: number;
  records: Records;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [width, setWidth] = useState(0);
  // The month on screen by its key, or null for the newest, so it stays put as months come and go.
  const [shown, setShown] = useState<string | null>(null);
  const list = useRef<FlatList<Month>>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const pages = useMemo(() => monthPages(months, today), [months, today]);
  const recordsIn = useCallback((id: string) => records.get(id)?.length ?? 0, [records]);
  const odometers = useMemo(
    () => pages.map((month) => monthOdometer(month, today, firstWeekday, recordsIn)),
    [pages, today, firstWeekday, recordsIn],
  );
  const last = Math.max(0, pages.length - 1);
  const at = shown === null ? -1 : pages.findIndex((month) => month.key === shown);
  // A month that has gone, its last workout deleted, gives way to the newest.
  const current = at < 0 ? last : at;
  const show = (to: number) => setShown(to >= last ? null : (pages[to]?.key ?? null));
  const selectedDay = odometers[current]?.cells.find((day) => day?.start === selected);
  // The picked date closes once its last session is gone, so one added later doesn't open it.
  if (
    selected !== null &&
    !odometers.some((odometer) =>
      odometer.cells.some((day) => day?.start === selected && day.sessions.length > 0),
    )
  )
    setSelected(null);
  const goTo = (to: number) => {
    if (to < 0 || to > last || !list.current) return;
    list.current.scrollToOffset({ offset: to * width, animated: false });
    show(to);
  };
  const controls = (
    <View style={styles.pagerControls}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel="Show older month"
        accessibilityState={{ disabled: current === 0 }}
        disabled={current === 0}
        style={[styles.pagerButton, current === 0 && styles.disabled]}
        onPress={() => goTo(current - 1)}
      >
        <ChevronIcon direction="left" color={c.fg2} size={16} strokeWidth={2} />
      </Tap>
      <Tap
        accessibilityRole="button"
        accessibilityLabel="Show newer month"
        accessibilityState={{ disabled: current === last }}
        disabled={current === last}
        style={[styles.pagerButton, current === last && styles.disabled]}
        onPress={() => goTo(current + 1)}
      >
        <ChevronIcon color={c.fg2} size={16} strokeWidth={2} />
      </Tap>
    </View>
  );
  return (
    <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
      {width > 0 && (
        <FlatList
          // Laid out afresh when the width or the months change, opening on the same month: one
          // arriving in front of it would otherwise shift the month on screen.
          key={`${width}:${pages.map((month) => month.key).join()}`}
          ref={list}
          initialScrollIndex={current}
          onScroll={({ nativeEvent }) =>
            show(Math.max(0, Math.round(nativeEvent.contentOffset.x / width)))
          }
          scrollEventThrottle={32}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          data={pages}
          extraData={[current, selected, odometers]}
          initialNumToRender={2}
          keyExtractor={(month) => month.key}
          getItemLayout={(_, at) => ({ length: width, offset: width * at, index: at })}
          renderItem={({ index: at }) => {
            const odometer = odometers[at];
            if (!odometer) return null;
            const picked = odometer.cells.find((day) => day?.start === selected);
            return (
              <View style={{ width }} {...outOfReach(at !== current)}>
                <MonthCard
                  odometer={odometer}
                  unit={unit}
                  firstWeekday={firstWeekday}
                  selected={picked?.date ?? null}
                  onSelect={(date) => {
                    const start = new Date(odometer.year, odometer.month, date).getTime();
                    setSelected((value) => (value === start ? null : start));
                  }}
                />
              </View>
            );
          }}
        />
      )}
      {/* Over the card's top right, beside the month's name. Shown with a single month too, greyed
          out, so the card reads as one that pages. */}
      {width > 0 && controls}
      {selectedDay?.sessions.map((workout) => (
        <Link
          key={workout.id}
          href={{ pathname: "/workout/[id]", params: { id: workout.id } }}
          asChild
        >
          <Tap accessibilityRole="link" style={StyleSheet.flatten(styles.daySession)}>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{displayedWorkoutTitle(workout)}</Text>
              <Text style={styles.rowDetail}>
                {timeLabel(workout.startedAt)} · {workoutMinutesLabel(workout.durationMinutes)}
              </Text>
            </View>
            <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
          </Tap>
        </Link>
      ))}
    </View>
  );
}

const MonthHeader = memo(function MonthHeader({ month, unit }: { month: Month; unit: WeightUnit }) {
  const styles = useStyles(sheet);
  const volume = month.workouts.reduce((sum, w) => sum + w.volumeKg, 0);
  const count = month.workouts.length;
  return (
    <View style={styles.month}>
      <Text accessibilityRole="header" style={styles.label}>
        {monthLabel(month.year, month.month)}
      </Text>
      <Text style={styles.label}>
        {count} {count === 1 ? "workout" : "workouts"}
        {volume > 0 ? ` · ${readoutWeight(volume, unit)} ${unit}` : ""}
      </Text>
    </View>
  );
});

/**
 * One session: its date, title and records, its time, sets and volume, the exercises it did,
 * and a barcode of its sets. Memoised: a row re-renders only when its workout changes.
 */
const SessionRow = memo(function SessionRow({
  workout,
  unit,
  records,
  flash = false,
  first,
  last,
}: {
  workout: HistorySearchWorkout;
  unit: WeightUnit;
  records: WorkoutRecord[];
  flash?: boolean;
  first: boolean;
  last: boolean;
}) {
  const styles = useStyles(sheet);
  const names = workout.exercises.map((e) => e.name);
  const shown = (workout.matchingExerciseNames ?? names).slice(0, 3);
  const started = new Date(workout.startedAt);
  const recordSets = new Set(records.flatMap((record) => (record.setId ? [record.setId] : [])));
  const bars = workout.exercises
    .filter((exercise) => exercise.bars.length)
    .map((exercise) =>
      exercise.bars.map((bar) => ({
        magnitude: bar.magnitude,
        warmup: bar.warmup,
        record: recordSets.has(bar.setId),
      })),
    );
  // Volume before sets, so a narrow row cuts the set details rather than the volume.
  const figures = [
    workoutMinutesLabel(workout.durationMinutes),
    effortText(workout, unit),
    historySetLabel(workout),
  ].filter(Boolean);
  return (
    <Link href={`/workout/${workout.id}`} asChild>
      <Tap
        accessibilityRole="link"
        accessibilityLabel={[
          displayedWorkoutTitle(workout),
          started.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
          records.length
            ? `${records.length} ${records.length === 1 ? "record" : "records"}`
            : null,
          ...figures,
          shown.join(", "),
        ]
          .filter(Boolean)
          .join(", ")}
        scaleTo={0.98}
        style={StyleSheet.flatten([
          styles.row,
          first && styles.rowFirst,
          last && styles.rowLast,
          !first && styles.divider,
        ])}
      >
        {flash && <Flash />}
        <View style={styles.date}>
          <Text style={styles.dateNumber}>{String(started.getDate()).padStart(2, "0")}</Text>
          <Text style={styles.label}>{WEEKDAYS[started.getDay()]}</Text>
        </View>
        <View style={styles.rowMain}>
          <View style={styles.titleLine}>
            <Text style={[styles.rowTitle, styles.shrink]} numberOfLines={1}>
              {displayedWorkoutTitle(workout)}
            </Text>
            {records.length > 0 && (
              <View style={styles.records}>
                <RecordMark />
                <Text style={styles.recordCount}>{records.length}</Text>
              </View>
            )}
          </View>
          <Text style={styles.figures} numberOfLines={1}>
            {figures.join(" · ")}
          </Text>
          <Text style={styles.exercises} numberOfLines={1}>
            {shown.join(" · ")}
            {names.length > shown.length ? ` +${names.length - shown.length}` : ""}
          </Text>
        </View>
        {bars.length > 0 && <SetBarcode exercises={bars} />}
      </Tap>
    </Link>
  );
});

/** The session's volume, or its logged time when it has no volume. */
function effortText(workout: WorkoutSummary, unit: WeightUnit) {
  if (workout.volumeKg > 0) return `${readoutWeight(workout.volumeKg, unit)} ${unit}`;
  if (workout.recordedSeconds !== null)
    return `${durationLabel(workout.recordedSeconds)} ${workout.missingTimedSets ? "partial time" : "timed"}`;
  return null;
}

const sheet = themedStyles((c) => ({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  scroll: { flex: 1, backgroundColor: c.bg },
  head: { gap: space.xl, paddingBottom: space.sm },
  label: { ...type.label, color: c.fg3 },
  pagerControls: { position: "absolute", top: 6, right: 10, flexDirection: "row", gap: 6 },
  pagerButton: {
    width: touch,
    height: touch,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.3 },
  daySession: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: touch,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderColor: c.line,
  },
  empty: { ...type.body, color: c.fg2, marginTop: space.xl },
  results: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    paddingTop: 18,
    paddingHorizontal: 6,
    paddingBottom: 10,
  },
  noResults: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  noResultsBody: {
    alignItems: "center",
    paddingTop: 28,
    paddingHorizontal: 22,
    paddingBottom: 24,
  },
  noResultsIcon: {
    width: 48,
    height: 48,
    borderRadius: 15,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  noResultsTitle: {
    ...type.cardTitle,
    fontSize: 18,
    lineHeight: 23,
    color: c.fg,
    textAlign: "center",
  },
  noResultsText: {
    ...type.body,
    fontSize: 14,
    lineHeight: 21,
    color: c.fg2,
    textAlign: "center",
    marginTop: 6,
    maxWidth: 290,
  },
  clear: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 48,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  clearText: { ...type.action, letterSpacing: 1.47, color: c.fg2 },
  month: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    paddingTop: 22,
    paddingBottom: 9,
    paddingHorizontal: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: c.s1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.line,
    // Keeps a flash inside the card's rounded corners.
    overflow: "hidden",
  },
  rowFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
  },
  rowLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  date: { width: 42, gap: 5 },
  dateNumber: { ...numeral(34), color: c.fg },
  rowMain: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowTitle: { ...type.rowTitle, color: c.fg },
  rowDetail: { ...type.meta, color: c.fg3, marginTop: 4 },
  records: { flexDirection: "row", alignItems: "center", gap: 6 },
  recordCount: { ...type.meta, fontWeight: "600", color: c.record },
  figures: { ...type.meta, color: c.fg2, marginTop: 4 },
  exercises: { ...type.caption, color: c.fg3, marginTop: 3 },
}));
