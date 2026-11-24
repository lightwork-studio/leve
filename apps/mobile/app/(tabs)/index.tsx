import { router } from "expo-router";
import { type ComponentRef, memo, useCallback, useRef, useState } from "react";
import { type ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import { finishFolderCreation, finishFolderRename } from "../../src/data/folder-actions.ts";
import { useTrain } from "../../src/data/queries.ts";
import { beginWorkout } from "../../src/data/workout-actions.ts";
import {
  lastDoneLabel,
  type RoutineCard,
  type RoutineGroup,
  type WeekSummary,
} from "../../src/model/train.ts";
import type { Settings } from "../../src/model/types.ts";
import { numeral, radius, space, touch, type } from "../../src/theme.ts";
import { Enter } from "../../src/ui/enter.tsx";
import { dayLabel, minutesLabel, readoutWeight } from "../../src/ui/format.ts";
import { Group } from "../../src/ui/group.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import {
  ChevronIcon,
  EditIcon,
  FolderIcon,
  FolderPlusIcon,
  GearIcon,
  LibraryIcon,
  PlusIcon,
  TrayIcon,
} from "../../src/ui/icons.tsx";
import { MainAction } from "../../src/ui/main-action.tsx";
import { NewFolderDialog } from "../../src/ui/new-folder-dialog.tsx";
import { MoreButton } from "../../src/ui/popover-menu.tsx";
import { HeaderButton, TabScreen } from "../../src/ui/screen.tsx";
import { StartActions } from "../../src/ui/start-actions.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { useNow } from "../../src/ui/use-now.ts";

export default function TrainScreen() {
  const now = useNow();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const styles = useStyles(sheet);
  const c = useColors();
  const { week, groups, upNext, active, settings } = useTrain(now);
  const { change } = useAppData();
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renaming, setRenaming] = useState<RoutineGroup["folder"]>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const routinesY = useRef(0);
  const reveal = useRef<string | null>(null);
  // A device runs one workout at a time: starting while one runs opens it again.
  // Stable callbacks, so rows that didn't change skip rendering again.
  const start = useCallback(
    (routineId?: string) => {
      if (!active) change((store) => beginWorkout(store, routineId), "active-workout");
      haptic.tap();
      router.push("/workout/active");
    },
    [active, change],
  );
  // The first folder starts open, as the place most routines live; the rest start closed.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(groups[0] ? [groupKey(groups[0])] : []),
  );
  const toggle = useCallback(
    (key: string) => {
      haptic.select();
      reveal.current = open.has(key) ? null : key;
      setOpen((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [open],
  );
  const routineCount = groups.reduce((sum, group) => sum + group.routines.length, 0);
  const folderCount = groups.filter((group) => group.folder).length;

  return (
    <TabScreen
      scrollRef={scroll}
      title="Train"
      eyebrow={dayLabel(new Date(now).toISOString(), undefined, now)}
      action={
        <HeaderButton label="Settings" onPress={openSettings}>
          <GearIcon color={c.fg2} size={19} />
        </HeaderButton>
      }
    >
      <WeekCard week={week} unit={settings?.weightUnit ?? "kg"} />
      {/* Starting sits in the main-action slot above the tabs, offering the routine next in
          rotation beside an empty workout. While a workout runs, the slot shows that workout
          instead, so Train offers nothing. */}
      <MainAction>{active ? null : <StartActions suggested={upNext} onStart={start} />}</MainAction>

      <View
        style={styles.routines}
        onLayout={(event) => {
          routinesY.current = event.nativeEvent.layout.y;
        }}
      >
        <View style={styles.sectionRow}>
          <View style={styles.sectionTitle}>
            <Text accessibilityRole="header" style={styles.section}>
              Routines
            </Text>
            <Text style={styles.sectionAside}>
              {routineCount}
              {folderCount > 0
                ? ` · ${folderCount} ${folderCount === 1 ? "folder" : "folders"}`
                : ""}
            </Text>
          </View>
          {/* One + for everything that can be added here, so the heading keeps a single tile. */}
          <MoreButton
            label="Add routine or folder"
            icon={(color, size) => <PlusIcon color={color} size={size + 2} />}
            items={[
              {
                label: "New routine",
                icon: (color) => <PlusIcon color={color} size={18} />,
                onPress: () => newRoutine(),
              },
              {
                label: "New folder",
                icon: (color) => <FolderPlusIcon color={color} size={18} />,
                onPress: () => setCreatingFolder(true),
              },
            ]}
          />
        </View>
        {active && (
          <Text style={styles.note}>
            Finish or discard your current workout to start another routine.
          </Text>
        )}
        {renaming && (
          <NewFolderDialog
            initialName={renaming.content.title}
            routineCount={groups.find((g) => g.folder?.id === renaming.id)?.routines.length ?? 0}
            onFinish={(name) => {
              finishFolderRename(change, renaming, name);
              setRenaming(null);
            }}
          />
        )}
        {creatingFolder && (
          <NewFolderDialog
            onFinish={(name) => {
              finishFolderCreation(change, name);
              setCreatingFolder(false);
            }}
          />
        )}
        {runs(groups, (g) => open.has(groupKey(g))).map((run) =>
          run.open ? (
            run.groups.map((group) => (
              <View
                key={groupKey(group)}
                onLayout={({ nativeEvent }) => {
                  const key = groupKey(group);
                  if (reveal.current !== key) return;
                  const y = nativeEvent.layout.y;
                  requestAnimationFrame(() => {
                    if (reveal.current !== key) return;
                    reveal.current = null;
                    scroll.current?.scrollTo({
                      y: Math.max(0, routinesY.current + y - insets.top - space.sm),
                      animated: !reduced,
                    });
                  });
                }}
              >
                <Enter leaves>
                  <OpenGroup
                    onRename={setRenaming}
                    group={group}
                    onToggle={toggle}
                    onStart={active ? undefined : start}
                  />
                </Enter>
              </View>
            ))
          ) : (
            // Closed folders next to each other share one card, one row each.
            <Enter key={run.groups.map(groupKey).join("+")} leaves style={styles.card}>
              {run.groups.map((group, i) => (
                <ClosedGroup
                  key={groupKey(group)}
                  group={group}
                  first={i === 0}
                  onRename={setRenaming}
                  onToggle={toggle}
                />
              ))}
            </Enter>
          ),
        )}
      </View>

      <Group label="Library" style={styles.library}>
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Exercises, records and history by name or muscle"
          onPress={openLibrary}
          scaleTo={0.98}
          style={styles.libraryRow}
        >
          <View style={styles.badge}>
            <LibraryIcon color={c.fg2} size={18} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.libraryTitle}>Exercises</Text>
            <Text style={styles.routineMeta}>Records and history · by name or muscle</Text>
          </View>
          <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
        </Tap>
      </Group>
    </TabScreen>
  );
}

const openSettings = () => router.push("/settings");
/** Opens the new routine form, filed in `folderId` to start with when one is given. */
const newRoutine = (folderId?: string) =>
  router.push(
    folderId ? { pathname: "/routine/new", params: { folder: folderId } } : "/routine/new",
  );
const openLibrary = () => router.push({ pathname: "/exercises", params: { from: "train" } });

/** The tallest a day's bar is, in points; an untrained day is a stub. */
const DAY_BAR = 34;

/**
 * This week at a glance: how many workouts, a bar per day as tall as its volume against the
 * week's biggest day (today ringed until trained), and the week's volume, time and sets.
 */
function WeekCard({ week, unit }: { week: WeekSummary; unit: Settings["weightUnit"] }) {
  const styles = useStyles(sheet);
  const most = Math.max(0, ...week.days.map((day) => day.volumeKg));
  const today = week.days.findIndex((day) => day.today);
  return (
    <View style={styles.card}>
      <View style={styles.week}>
        <View
          accessible
          accessibilityLabel={`${week.workouts} ${week.workouts === 1 ? "workout" : "workouts"} this week`}
          style={styles.weekCount}
        >
          <Text style={styles.weekNumber}>{week.workouts}</Text>
          <View style={styles.weekKey}>
            <Text style={[styles.label, styles.strong]}>This week</Text>
            <Text style={styles.label}>{week.workouts === 1 ? "workout" : "workouts"}</Text>
          </View>
        </View>
        <View style={styles.days}>
          {week.days.map((day, i) => {
            const height = day.trained
              ? Math.max(8, most > 0 ? (day.volumeKg / most) * DAY_BAR : DAY_BAR)
              : day.today
                ? 30
                : 3;
            return (
              <View
                key={day.name}
                accessible
                accessibilityLabel={`${day.name}${day.trained ? ", trained" : ""}${day.today ? ", today" : ""}`}
                style={styles.day}
              >
                <View
                  style={[
                    styles.dayBar,
                    { height },
                    day.trained
                      ? styles.dayTrained
                      : day.today
                        ? styles.dayToday
                        : today >= 0 && i > today && styles.dayAhead,
                  ]}
                />
                <Text style={[styles.label, day.today && styles.strong]}>{day.letter}</Text>
              </View>
            );
          })}
        </View>
      </View>
      <View style={styles.weekFoot}>
        <WeekFigure label="Vol" value={`${readoutWeight(week.volumeKg, unit)} ${unit}`} />
        <WeekFigure label="Time" value={minutesLabel(week.minutes)} />
        <WeekFigure label="Sets" value={String(week.sets)} />
      </View>
    </View>
  );
}

function WeekFigure({ label, value }: { label: string; value: string }) {
  const styles = useStyles(sheet);
  return (
    <Text
      accessibilityLabel={`${label === "Vol" ? "Volume" : label} ${value}`}
      style={styles.label}
    >
      {label}
      <Text style={styles.weekValue}> {value}</Text>
    </Text>
  );
}

const groupKey = (group: RoutineGroup) => group.folder?.id ?? "unfiled";
const groupTitle = (group: RoutineGroup) => group.folder?.content.title ?? "Not in a folder";

/** Splits the groups into runs of open and closed ones, keeping their order. */
function runs(groups: RoutineGroup[], isOpen: (group: RoutineGroup) => boolean) {
  const result: { open: boolean; groups: RoutineGroup[] }[] = [];
  for (const group of groups) {
    const open = isOpen(group);
    const last = result.at(-1);
    if (last && last.open === open) last.groups.push(group);
    else result.push({ open, groups: [group] });
  }
  return result;
}

const OpenGroup = memo(function OpenGroup({
  group,
  onToggle,
  onStart,
  onRename,
}: {
  onRename: (folder: NonNullable<RoutineGroup["folder"]>) => void;
  group: RoutineGroup;
  onToggle: (key: string) => void;
  onStart?: ((routineId: string) => void) | undefined;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <View>
      <View style={styles.headerRow}>
        <Tap
          accessibilityRole="button"
          accessibilityState={{ expanded: true }}
          onPress={() => onToggle(groupKey(group))}
          style={[styles.groupHeader, styles.flex]}
        >
          <ChevronIcon direction="down" color={c.fg3} size={16} strokeWidth={2} />
          <Text style={[styles.label, styles.flexShrink]} numberOfLines={1}>
            {groupTitle(group)}
          </Text>
          <View style={styles.flex} />
          <Text style={styles.label}>{group.routines.length}</Text>
        </Tap>
        <FolderMenu folder={group.folder} onRename={onRename} />
      </View>
      {group.routines.length > 0 && (
        <View style={styles.card}>
          {group.routines.map((routine, i) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              index={i}
              first={i === 0}
              onStart={onStart}
            />
          ))}
        </View>
      )}
    </View>
  );
});

/** A folder's ⋯ menu: add a routine straight into it, or rename it. */
function FolderMenu({
  folder,
  onRename,
}: {
  folder: RoutineGroup["folder"];
  onRename: (folder: NonNullable<RoutineGroup["folder"]>) => void;
}) {
  const styles = useStyles(sheet);
  if (!folder) return null;
  return (
    <View style={styles.folderMenu}>
      <MoreButton
        small
        label={`${folder.content.title} folder options`}
        title={folder.content.title}
        items={[
          {
            label: "New routine",
            icon: (color) => <PlusIcon color={color} size={18} />,
            onPress: () => newRoutine(folder.id),
          },
          {
            label: "Rename folder",
            icon: (color) => <EditIcon color={color} size={18} />,
            onPress: () => onRename(folder),
          },
        ]}
      />
    </View>
  );
}

const ClosedGroup = memo(function ClosedGroup({
  group,
  first,
  onToggle,
  onRename,
}: {
  group: RoutineGroup;
  first: boolean;
  onToggle: (key: string) => void;
  onRename: (folder: NonNullable<RoutineGroup["folder"]>) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <View style={[styles.headerRow, styles.closedRow, !first && styles.divider]}>
      <Tap
        accessibilityRole="button"
        accessibilityState={{ expanded: false }}
        onPress={() => onToggle(groupKey(group))}
        style={[styles.closedFolder, styles.flex]}
      >
        <View style={styles.badge}>
          {group.folder ? (
            <FolderIcon color={c.fg2} size={18} />
          ) : (
            <TrayIcon color={c.fg2} size={18} />
          )}
        </View>
        <Text style={styles.closedTitle} numberOfLines={1}>
          {groupTitle(group)}
        </Text>
        <Text style={styles.closedCount}>{group.routines.length}</Text>
        <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
      </Tap>
      <FolderMenu folder={group.folder} onRename={onRename} />
    </View>
  );
});

const RoutineRow = memo(function RoutineRow({
  routine,
  index,
  first,
  onStart,
}: {
  routine: RoutineCard;
  index: number;
  first: boolean;
  onStart?: ((routineId: string) => void) | undefined;
}) {
  const styles = useStyles(sheet);
  const shown = routine.exerciseNames.slice(0, 3);
  const more = routine.exerciseNames.length - shown.length;
  const summary = `${routine.exerciseCount} ${routine.exerciseCount === 1 ? "exercise" : "exercises"} · ${lastDoneLabel(routine.daysSinceLast).toLowerCase()}`;
  const spoken = [routine.title, ...shown, summary].join(", ");
  const details = (
    <>
      <Text style={styles.routineIndex}>{String(index + 1).padStart(2, "0")}</Text>
      <View style={styles.flex}>
        <Text style={styles.routineTitle} numberOfLines={2}>
          {routine.title}
        </Text>
        <Text style={styles.routineMeta} numberOfLines={1}>
          {summary}
        </Text>
        {shown.length > 0 && (
          <Text style={styles.routineNames} numberOfLines={1}>
            {shown.join(" · ")}
            {more > 0 ? ` +${more}` : ""}
          </Text>
        )}
      </View>
    </>
  );
  return (
    <View style={[styles.routine, !first && styles.divider]}>
      {/* The row starts the routine, as the start button did; while a workout runs it starts
          nothing, as the start button wasn't offered then. */}
      {onStart ? (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`Start ${spoken}`}
          style={styles.routineDetails}
          scaleTo={0.98}
          onPress={() => onStart(routine.id)}
        >
          {details}
        </Tap>
      ) : (
        <View accessible accessibilityLabel={spoken} style={styles.routineDetails}>
          {details}
        </View>
      )}
      <MoreButton
        small
        label={`${routine.title} options`}
        title={routine.title}
        items={[
          {
            label: "Edit routine",
            icon: (color) => <EditIcon color={color} size={18} />,
            onPress: () => router.push({ pathname: "/routine/[id]", params: { id: routine.id } }),
          },
        ]}
      />
    </View>
  );
});

const sheet = themedStyles((c) => ({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  label: { ...type.label, color: c.fg3 },
  strong: { color: c.fg },
  card: {
    backgroundColor: c.s1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: c.line,
    overflow: "hidden",
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  week: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.xl,
    paddingTop: 14,
    paddingHorizontal: space.lg,
  },
  weekCount: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  weekNumber: { ...numeral(54), color: c.fg },
  weekKey: { gap: 5, paddingBottom: 6 },
  days: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-end", gap: 6, height: 52 },
  day: { flex: 1, alignItems: "center", justifyContent: "flex-end", gap: 5, height: "100%" },
  dayBar: {
    width: "100%",
    maxWidth: 16,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    backgroundColor: c.s3,
  },
  dayTrained: { backgroundColor: c.fg },
  dayToday: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: c.fg2 },
  dayAhead: { opacity: 0.45 },
  weekFoot: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: space.sm,
    marginTop: 10,
    marginHorizontal: space.lg,
    paddingTop: 10,
    paddingBottom: space.md,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  weekValue: { ...type.meta, color: c.fg, letterSpacing: 0, textTransform: "none" },
  routines: { gap: space.md },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { flexDirection: "row", alignItems: "baseline", gap: space.md, flexShrink: 1 },
  section: { ...type.heading, color: c.fg },
  sectionAside: { ...type.label, color: c.fg3 },
  note: { ...type.meta, color: c.fg3 },
  folderMenu: { width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center" },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: touch,
    paddingLeft: 6,
  },
  closedRow: { paddingRight: space.xs },
  closedFolder: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingLeft: space.lg,
    paddingRight: space.sm,
  },
  badge: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: c.s2,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  closedTitle: { flex: 1, ...type.rowTitle, color: c.fg },
  closedCount: { ...type.value, color: c.fg2 },
  routine: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingLeft: space.lg,
    paddingRight: space.md,
  },
  routineDetails: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    minHeight: touch,
  },
  routineIndex: { ...type.value, color: c.fg3, width: 20, paddingTop: 3 },
  routineTitle: { ...type.cardTitle, fontSize: 19, lineHeight: 22, color: c.fg },
  routineMeta: { ...type.meta, color: c.fg3, marginTop: 4 },
  routineNames: { ...type.caption, color: c.fg2, marginTop: 3 },
  library: { marginHorizontal: 0, marginTop: space.sm, marginBottom: 0 },
  libraryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  libraryTitle: { ...type.rowTitle, color: c.fg },
}));
