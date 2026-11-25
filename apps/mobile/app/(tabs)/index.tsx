import { router } from "expo-router";
import {
  type ComponentRef,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Platform, type ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import {
  deleteFolder,
  finishFolderCreation,
  finishFolderRename,
} from "../../src/data/folder-actions.ts";
import { moveRoutine } from "../../src/data/organize-routine.ts";
import { useLive, useTrain } from "../../src/data/queries.ts";
import { restTimer } from "../../src/data/rest-timer.ts";
import { beginWorkout } from "../../src/data/workout-actions.ts";
import {
  replaceReviewedActiveWorkout,
  workoutDeletionSnapshot,
} from "../../src/data/workout-review.ts";
import { setProgress } from "../../src/model/live.ts";
import { dropPlace } from "../../src/model/plan-order.ts";
import {
  lastDoneLabel,
  type RoutineCard,
  type RoutineGroup,
  type WeekSummary,
} from "../../src/model/train.ts";
import type { Settings } from "../../src/model/types.ts";
import { font, numeral, radius, space, touch, type } from "../../src/theme.ts";
import { ActionSheet } from "../../src/ui/action-sheet.tsx";
import { afterFeedback } from "../../src/ui/after-feedback.ts";
import { Button } from "../../src/ui/buttons.tsx";
import { DragBlock } from "../../src/ui/drag-block.tsx";
import { EmptyState } from "../../src/ui/empty-state.tsx";
import { Enter } from "../../src/ui/enter.tsx";
import { announce } from "../../src/ui/focus.ts";
import { dayLabel, minutesLabel, readoutWeight } from "../../src/ui/format.ts";
import { haptic } from "../../src/ui/haptics.ts";
import {
  ChevronIcon,
  EditIcon,
  FolderIcon,
  GearIcon,
  PlusIcon,
  TrayIcon,
} from "../../src/ui/icons.tsx";
import { MainAction } from "../../src/ui/main-action.tsx";
import { ModeTile } from "../../src/ui/mode-tile.tsx";
import { NewFolderDialog } from "../../src/ui/new-folder-dialog.tsx";
import { showToast } from "../../src/ui/notice.tsx";
import { HeaderButton, TabScreen } from "../../src/ui/screen.tsx";
import { StartActions } from "../../src/ui/start-actions.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import { TrainSyncReview } from "../../src/ui/train-sync-review.tsx";
import { useNow } from "../../src/ui/use-now.ts";

export default function TrainScreen() {
  const now = useNow();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const styles = useStyles(sheet);
  const c = useColors();
  const { week, groups, upNext, active, settings, reviews } = useTrain(now);
  const { change, store } = useAppData();
  // The routine tapped while another workout runs, and that workout as it was then: discarding it
  // is refused if it changed while the sheet was open.
  const [switching, setSwitching] = useState<{
    routineId: string;
    workoutId: string;
    reviewed: ReturnType<typeof workoutDeletionSnapshot>;
  } | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // Set at once, so a second press before the next render can't discard again.
  const discardingNow = useRef(false);
  // The routine the running workout came from: null for an empty workout, undefined when none runs.
  const runningRoutine = active
    ? ((active.content as { routineId?: string | null } | null)?.routineId ?? null)
    : undefined;
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renaming, setRenaming] = useState<RoutineGroup["folder"]>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const routinesY = useRef(0);
  const reveal = useRef<string | null>(null);
  // A device runs one workout at a time. Tapping the running routine opens it again; tapping
  // another asks what to do with the running one first.
  // Stable callbacks, so rows that didn't change skip rendering again.
  const start = useCallback(
    (routineId?: string) => {
      if (active && routineId !== undefined && routineId !== runningRoutine) {
        haptic.select();
        setSwitching({
          routineId,
          workoutId: active.id,
          reviewed: workoutDeletionSnapshot(store, active.id),
        });
        return;
      }
      if (!active) change((store) => beginWorkout(store, routineId), "active-workout");
      haptic.tap();
      router.push("/workout/active");
    },
    [active, runningRoutine, change, store],
  );
  // Asked only while the workout it was opened for still runs.
  const pending = switching && switching.workoutId === active?.id ? switching : null;
  const switchTitle =
    pending &&
    groups.flatMap((group) => group.routines).find((routine) => routine.id === pending.routineId)
      ?.title;
  const closeSwitch = () => {
    if (discardingNow.current) return;
    setSwitching(null);
  };
  const discardAndStart = () => {
    if (!pending || discardingNow.current) return;
    const { workoutId, routineId, reviewed } = pending;
    discardingNow.current = true;
    setDiscarding(true);
    afterFeedback(() => {
      try {
        change(
          (store) => replaceReviewedActiveWorkout(store, workoutId, reviewed, routineId),
          "active-workout",
        );
      } catch (error) {
        haptic.warning();
        showToast((error as Error).message);
        return;
      } finally {
        discardingNow.current = false;
        setDiscarding(false);
        setSwitching(null);
      }
      restTimer.skip(store, workoutId);
      haptic.tap();
      afterSheet(() => router.push("/workout/active"));
    });
  };
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
  // Editing is for arranging: a tap on a routine opens its editor instead of starting it, its
  // grip drags it within its folder, and folders can be renamed. Starting steps aside meanwhile.
  const [editingMode, setEditing] = useState(false);
  const editing = editingMode && groups.length > 0;
  // While a grip is held the page stays still under the finger.
  const [gripHeld, setGripHeld] = useState(false);
  const toggleEditing = useCallback(() => {
    haptic.select();
    setEditing((current) => !current);
  }, []);
  // Holding a routine is the shortcut in, for someone who reaches for a routine to move it.
  const startEditing = useCallback(() => {
    haptic.select();
    setEditing(true);
    announce("Editing routines");
  }, []);
  const move = useCallback(
    (routine: RoutineCard, seen: readonly string[], to: number) => {
      try {
        change((store) => moveRoutine(store, routine.id, seen, to));
      } catch (error) {
        haptic.warning();
        showToast((error as Error).message);
        return;
      }
      haptic.select();
      announce(`${routine.title} moved to position ${to + 1} of ${seen.length}`);
    },
    [change],
  );
  const groupRuns = runs(groups, (g) => open.has(groupKey(g)));
  const newFolder = useCallback(() => setCreatingFolder(true), []);
  const routineCount = groups.reduce((sum, group) => sum + group.routines.length, 0);
  const folderCount = groups.filter((group) => group.folder).length;

  return (
    <TabScreen
      scrollRef={scroll}
      scrollEnabled={!gripHeld}
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
          instead, so Train offers nothing; nor does it while the routines are being edited. */}
      <MainAction>
        {active || editing ? null : <StartActions suggested={upNext} onStart={start} />}
      </MainAction>

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
          {groups.length > 0 && (
            <ModeTile
              on={editing}
              label="Edit"
              accessibilityLabel="Edit routines"
              doneAccessibilityLabel="Done editing routines"
              icon={(color) => <EditIcon color={color} size={15} />}
              onToggle={toggleEditing}
            />
          )}
        </View>
        {editing && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              <Text style={styles.bannerStrong}>Drag ⠿ to reorder.</Text> Tap a routine to edit it
              or move it to another folder.
            </Text>
          </View>
        )}
        {/* Routines and folders the server didn't take as this device had them, to settle here. */}
        {reviews.map((record) => (
          <TrainSyncReview key={`${record.kind}/${record.id}`} record={record} />
        ))}
        {pending && switchTitle && (
          <SwitchSheet
            routine={switchTitle}
            busy={discarding}
            onResume={() => {
              if (discardingNow.current) return;
              closeSwitch();
              haptic.tap();
              afterSheet(() => router.push("/workout/active"));
            }}
            onFinish={() => {
              if (discardingNow.current) return;
              const next = pending.routineId;
              closeSwitch();
              afterSheet(() => router.push({ pathname: "/workout/finish", params: { next } }));
            }}
            onDiscard={discardAndStart}
            onClose={closeSwitch}
          />
        )}
        {renaming && (
          <NewFolderDialog
            initialName={renaming.content.title}
            routineCount={groups.find((g) => g.folder?.id === renaming.id)?.routines.length ?? 0}
            onFinish={(name) => {
              finishFolderRename(change, renaming, name);
              setRenaming(null);
            }}
            onDelete={() => {
              change((store) => deleteFolder(store, renaming));
              haptic.tap();
              // Its routines join the ones not in a folder: open that group to show them there.
              if (groups.some((g) => g.folder?.id === renaming.id && g.routines.length > 0))
                setOpen((current) => new Set(current).add("unfiled"));
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
        {/* Adding happens where the new thing will appear: "Add routine" ends each open folder,
            and "New folder" ends the list of closed folders, or the section when none is closed. */}
        {groupRuns.map((run, r) =>
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
                    editing={editing}
                    onRename={setRenaming}
                    group={group}
                    onToggle={toggle}
                    onStart={start}
                    onStartEditing={startEditing}
                    onMove={move}
                    onGripHeld={setGripHeld}
                    running={runningRoutine}
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
                  onToggle={toggle}
                />
              ))}
              {r === groupRuns.length - 1 && <NewFolderRow onPress={newFolder} />}
            </Enter>
          ),
        )}
        {groups.length === 0 ? (
          // Nothing yet: adding a routine is the way in. A folder only helps once there are
          // routines to file, so it is offered quietly underneath.
          <EmptyState
            inset={false}
            title="No routines yet"
            text="Plan the exercises you repeat, then start them in one tap."
            action={
              <View style={styles.emptyActions}>
                <Button label="Add routine" onPress={() => newRoutine()} />
                <Button rank="text" label="Or start with a folder" onPress={newFolder} />
              </View>
            }
          />
        ) : (
          groupRuns.at(-1)?.open && (
            <Enter leaves style={styles.card}>
              <NewFolderRow first onPress={newFolder} />
            </Enter>
          )
        )}
      </View>
    </TabScreen>
  );
}

/**
 * Tapping a routine while another workout runs: carry on with the running one, finish it and then
 * start the routine, or discard it and start the routine now.
 */
function SwitchSheet({
  routine,
  busy,
  onResume,
  onFinish,
  onDiscard,
  onClose,
}: {
  routine: string;
  busy: boolean;
  onResume: () => void;
  onFinish: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const live = useLive();
  if (!live) return null;
  const title = live.tree.workout.content.title || "Workout";
  const { done } = setProgress(live.tree);
  return (
    <ActionSheet
      message={`${title} is still running, with ${done} logged ${done === 1 ? "set" : "sets"}. Discarding it can’t be undone.`}
      choices={[
        { label: `Resume ${title}`, onPress: onResume },
        { label: `Finish, then start ${routine}`, onPress: onFinish },
      ]}
      action={`Discard and start ${routine}`}
      busy={busy}
      busyLabel="Discarding…"
      onConfirm={onDiscard}
      onClose={onClose}
    />
  );
}

/** iOS can't show another screen while a sheet is still closing. */
const afterSheet = (go: () => void) => {
  if (Platform.OS === "ios") setTimeout(go, 320);
  else go();
};

const openSettings = () => router.push("/settings");
/** Opens the new routine form, filed in `folderId` to start with when one is given. */
const newRoutine = (folderId?: string) =>
  router.push(
    folderId ? { pathname: "/routine/new", params: { folder: folderId } } : "/routine/new",
  );

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
  editing,
  onToggle,
  onStart,
  onStartEditing,
  onMove,
  onGripHeld,
  running,
  onRename,
}: {
  onRename: (folder: NonNullable<RoutineGroup["folder"]>) => void;
  group: RoutineGroup;
  editing: boolean;
  onToggle: (key: string) => void;
  onStart: (routineId: string) => void;
  onStartEditing: () => void;
  /** Moves a routine to place `to` of the group, as `seen` showed it. */
  onMove: (routine: RoutineCard, seen: readonly string[], to: number) => void;
  onGripHeld: (held: boolean) => void;
  /** The running workout's routine: null for an empty workout, undefined when none runs. */
  running: string | null | undefined;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { folder } = group;
  // Each row's measured height, for where a dragged one lands.
  const heights = useRef<number[]>([]);
  // Rows that went (deleted, or moved to another folder) take no room any more.
  heights.current.length = Math.min(heights.current.length, group.routines.length);
  const [drag, setDrag] = useState<{ from: number; dy: number } | null>(null);
  // A grip held as editing ends, or as the folder goes, lets go of the page.
  useEffect(() => {
    if (!editing) setDrag(null);
    return () => onGripHeld(false);
  }, [editing, onGripHeld]);
  const seen = group.routines.map((routine) => routine.id);
  const place = drag ? dropPlace(heights.current, drag.from, drag.dy) : null;
  // The dragged row follows the finger; the rows it passes step aside by its height.
  const offset = (index: number) => {
    if (!drag || place === null) return 0;
    if (index === drag.from) return drag.dy;
    const moved = heights.current[drag.from] ?? 0;
    if (drag.from < place && index > drag.from && index <= place) return -moved;
    if (place < drag.from && index >= place && index < drag.from) return moved;
    return 0;
  };
  // The lifted row floats without the line above it, and when the first row is carried down, the
  // row that takes its place at the top drops its line too, as in the routine editor.
  const lineHidden = (index: number) =>
    drag !== null && (index === drag.from || (drag.from === 0 && place !== 0 && index === 1));
  const endDrag = (routine: RoutineCard, from: number, dy?: number) => {
    onGripHeld(false);
    setDrag(null);
    if (dy === undefined) return;
    const to = dropPlace(heights.current, from, dy);
    if (to !== from) onMove(routine, seen, to);
  };
  return (
    <View>
      <View style={[styles.headerRow, folder && editing && styles.headerWithAction]}>
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
        {folder && editing && (
          <IconAction
            label={`Edit ${folder.content.title} folder`}
            onPress={() => onRename(folder)}
          >
            <EditIcon color={c.fg2} size={15} />
          </IconAction>
        )}
      </View>
      {/* While editing, a lifted row's shadow may reach past the card. */}
      <View style={[styles.card, editing && styles.cardEditing]}>
        {group.routines.map((routine, i) =>
          editing ? (
            <DragBlock
              key={routine.id}
              lifted={drag?.from === i}
              offset={offset(i)}
              onGrab={() => onGripHeld(true)}
              onMove={(dy) => setDrag({ from: i, dy })}
              onEnd={(dy) => endDrag(routine, i, dy)}
            >
              {(grip) => (
                <EditRoutineRow
                  routine={routine}
                  first={i === 0}
                  lineHidden={lineHidden(i)}
                  grip={grip(`Drag to reorder ${routine.title}`)}
                  onLayout={(height) => {
                    heights.current[i] = height;
                  }}
                  onShift={
                    // Screen readers move a routine one place at a time instead of dragging it.
                    (direction) => {
                      const to = i + direction;
                      if (to >= 0 && to < seen.length) onMove(routine, seen, to);
                    }
                  }
                  canMoveUp={i > 0}
                  canMoveDown={i < seen.length - 1}
                />
              )}
            </DragBlock>
          ) : (
            <RoutineRow
              key={routine.id}
              routine={routine}
              index={i}
              first={i === 0}
              onStart={onStart}
              onStartEditing={onStartEditing}
              running={running === undefined ? "idle" : running === routine.id ? "this" : "other"}
            />
          ),
        )}
        <AddRoutineRow folder={folder} first={group.routines.length === 0} />
      </View>
    </View>
  );
});

/** A bare icon with a full touch target, for the one secondary action a row or header has. */
function IconAction({
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
      style={styles.iconAction}
    >
      {children}
    </Tap>
  );
}

/** Ends a folder's card: adds a routine filed in that folder, or in none for the unfiled group. */
function AddRoutineRow({ folder, first }: { folder: RoutineGroup["folder"]; first: boolean }) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={folder ? `Add routine to ${folder.content.title}` : "Add routine"}
      onPress={() => newRoutine(folder?.id)}
      scaleTo={0.98}
      style={[styles.addRoutine, !first && styles.divider]}
    >
      <View style={styles.addRoutineIcon}>
        <PlusIcon color={c.fg2} size={16} />
      </View>
      <Text style={styles.addLabel}>Add routine</Text>
    </Tap>
  );
}

/** Ends the closed folders' card, or the section when none is closed. */
function NewFolderRow({ first = false, onPress }: { first?: boolean; onPress: () => void }) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel="New folder"
      onPress={onPress}
      scaleTo={0.98}
      style={[styles.closedFolder, !first && styles.divider]}
    >
      <View style={[styles.badge, styles.badgeNew]}>
        <PlusIcon color={c.fg2} size={16} />
      </View>
      <Text style={[styles.closedTitle, styles.addLabelColor]} numberOfLines={1}>
        New folder
      </Text>
    </Tap>
  );
}

const ClosedGroup = memo(function ClosedGroup({
  group,
  first,
  onToggle,
}: {
  group: RoutineGroup;
  first: boolean;
  onToggle: (key: string) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityState={{ expanded: false }}
      onPress={() => onToggle(groupKey(group))}
      style={[styles.closedFolder, !first && styles.divider]}
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
  );
});

const openRoutine = (id: string) => router.push({ pathname: "/routine/[id]", params: { id } });

/** What a routine row says: its title, then how big it is and when it was last done. */
function routineText(routine: RoutineCard) {
  const shown = routine.exerciseNames.slice(0, 3);
  const more = routine.exerciseNames.length - shown.length;
  const summary = `${routine.exerciseCount} ${routine.exerciseCount === 1 ? "exercise" : "exercises"} · ${lastDoneLabel(routine.daysSinceLast).toLowerCase()}`;
  return {
    summary,
    names: shown.length > 0 ? `${shown.join(" · ")}${more > 0 ? ` +${more}` : ""}` : null,
    spoken: [routine.title, ...shown, summary].join(", "),
  };
}

function RoutineDetails({ routine }: { routine: RoutineCard }) {
  const styles = useStyles(sheet);
  const { summary, names } = routineText(routine);
  return (
    <View style={styles.flex}>
      <Text style={styles.routineTitle} numberOfLines={2}>
        {routine.title}
      </Text>
      <Text style={styles.routineMeta} numberOfLines={1}>
        {summary}
      </Text>
      {names !== null && (
        <Text style={styles.routineNames} numberOfLines={1}>
          {names}
        </Text>
      )}
    </View>
  );
}

const RoutineRow = memo(function RoutineRow({
  routine,
  index,
  first,
  onStart,
  onStartEditing,
  running,
}: {
  routine: RoutineCard;
  index: number;
  first: boolean;
  onStart: (routineId: string) => void;
  onStartEditing: () => void;
  /** Whether a workout runs, and if so whether it came from this routine. */
  running: "idle" | "this" | "other";
}) {
  const styles = useStyles(sheet);
  const { spoken } = routineText(routine);
  return (
    <View style={[styles.routine, !first && styles.divider]}>
      {/* The whole row starts the routine, its only action outside editing. While a workout runs,
          Train asks first (or opens that workout, for its own routine). Holding it starts editing
          instead; screen readers get Edit routine as an action. */}
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`${running === "this" ? "Resume" : "Start"} ${spoken}`}
        {...(running === "other" && {
          accessibilityHint: "Asks what to do with the running workout first",
        })}
        accessibilityActions={[{ name: "edit", label: "Edit routine" }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "edit") openRoutine(routine.id);
        }}
        style={styles.routineDetails}
        scaleTo={0.98}
        onPress={() => onStart(routine.id)}
        onLongPress={onStartEditing}
      >
        <Text style={styles.routineIndex}>{String(index + 1).padStart(2, "0")}</Text>
        <RoutineDetails routine={routine} />
      </Tap>
    </View>
  );
});

/**
 * A routine while editing: its grip drags it within the folder, and a tap opens its editor, where
 * it can also be moved to another folder or deleted.
 */
function EditRoutineRow({
  routine,
  first,
  lineHidden,
  grip,
  onLayout,
  onShift,
  canMoveUp,
  canMoveDown,
}: {
  routine: RoutineCard;
  first: boolean;
  /** Keeps the line's room but draws none, so rows don't shift by its width mid-drag. */
  lineHidden: boolean;
  grip: ReactNode;
  onLayout: (height: number) => void;
  onShift: (direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { spoken } = routineText(routine);
  return (
    <View
      style={[
        styles.routine,
        styles.routineEditing,
        !first && styles.divider,
        lineHidden && styles.dividerHidden,
      ]}
      onLayout={({ nativeEvent }) => onLayout(nativeEvent.layout.height)}
    >
      {grip}
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Edit ${spoken}`}
        accessibilityActions={[
          ...(canMoveUp ? [{ name: "moveUp", label: "Move up" }] : []),
          ...(canMoveDown ? [{ name: "moveDown", label: "Move down" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) =>
          onShift(nativeEvent.actionName === "moveUp" ? -1 : 1)
        }
        style={styles.routineDetails}
        scaleTo={0.98}
        onPress={() => openRoutine(routine.id)}
      >
        <RoutineDetails routine={routine} />
        <View style={styles.routineOpen}>
          <ChevronIcon color={c.fg3} size={16} strokeWidth={2} />
        </View>
      </Tap>
    </View>
  );
}

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
  cardEditing: { overflow: "visible" },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  dividerHidden: { borderTopColor: "transparent" },
  // As in the routine editor's reorder mode: what dragging does, in a dashed box.
  banner: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.line2,
  },
  bannerText: { ...font.mono, fontSize: 11, lineHeight: 16.5, color: c.fg3 },
  bannerStrong: { color: c.fg2 },
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
  iconAction: { width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center" },
  // The pencil's glyph lines up with the ones on the routine rows below.
  headerWithAction: { marginRight: space.xs + 1 },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: touch,
    paddingLeft: 6,
  },
  closedFolder: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 58,
    paddingHorizontal: space.lg,
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
  badgeNew: { backgroundColor: "transparent", borderStyle: "dashed", borderColor: c.line2 },
  closedTitle: { flex: 1, ...type.rowTitle, color: c.fg },
  closedCount: { ...type.value, color: c.fg2 },
  routine: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingLeft: space.lg,
    paddingRight: space.xs,
  },
  routineDetails: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    minHeight: touch,
  },
  // The grip's glyph sits in the numbers' column, its touch target reaching to the card's edge.
  routineEditing: { gap: 0, paddingLeft: 2 },
  routineOpen: { width: touch, alignSelf: "center", alignItems: "center" },
  routineIndex: { ...type.value, color: c.fg3, width: 20, paddingTop: 3 },
  routineTitle: { ...type.cardTitle, fontSize: 19, lineHeight: 22, color: c.fg },
  routineMeta: { ...type.meta, color: c.fg3, marginTop: 4 },
  routineNames: { ...type.caption, color: c.fg2, marginTop: 3 },
  addRoutine: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.lg,
  },
  // As wide as the routine numbers, so the + sits in their column.
  addRoutineIcon: { width: 20, alignItems: "center" },
  addLabel: { ...type.rowTitle, color: c.fg2 },
  addLabelColor: { color: c.fg2 },
  emptyActions: { alignItems: "center", gap: space.xs },
}));
