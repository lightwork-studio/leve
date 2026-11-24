import {
  type EffortScale,
  type ExerciseType,
  METRICS_BY_TYPE,
  type SetDistanceUnit,
  type SetMetric,
} from "@leve/core";
import { router, useNavigation } from "expo-router";
import {
  type ComponentRef,
  type ReactNode,
  type RefCallback,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import { useLive, usePastWorkouts } from "../../src/data/queries.ts";
import { workoutJournalData } from "../../src/data/read.ts";
import { restProgress, restTimer, useRest } from "../../src/data/rest-timer.ts";
import {
  deleteHeldSet,
  heldSet,
  holdSetRemoval,
  undoSetRemoval,
} from "../../src/data/set-removal.ts";
import { useShowTargets } from "../../src/data/show-targets.ts";
import { canChangeTrackRir, useTrackRir } from "../../src/data/track-rir.ts";
import {
  addSelectedExercises,
  addSet,
  canRecordSetReserve,
  exerciseRemovalSnapshot,
  logSet,
  moveWorkoutExercise,
  removeWorkoutExercise,
  setExerciseRest,
  unlogSet,
  updateSet,
  WorkoutActionError,
} from "../../src/data/workout-actions.ts";
import {
  discardReviewedActiveWorkout,
  workoutDeletionSnapshot,
} from "../../src/data/workout-review.ts";
import {
  effortCaption,
  effortField,
  effortLabel,
  effortValue,
  setEffortScale,
} from "../../src/model/effort.ts";
import {
  fieldOrder,
  nextField,
  type PadKey,
  stepLabel,
  stepSize,
  stepText,
  typeKey,
} from "../../src/model/inline-edit.ts";
import { routineTarget, setProgress, topOfRepRanges } from "../../src/model/live.ts";
import { correctionValues, parseTyped, previousValue } from "../../src/model/log-values.ts";
import {
  asksRir,
  countsReps,
  showsRirColumn,
  stepRir,
  stepRpe,
  typedRpe,
  typeRir,
  typeRpe,
} from "../../src/model/rir.ts";
import { supersetMemberships } from "../../src/model/supersets.ts";
import type { WorkoutPlan } from "../../src/model/types.ts";
import { countsTowardTotals } from "../../src/model/volume.ts";
import { font, gutter, numeral, radius, space, type } from "../../src/theme.ts";
import { DestructiveButton } from "../../src/ui/action-sheet.tsx";
import { BottomSheet } from "../../src/ui/bottom-sheet.tsx";
import { CommitButton } from "../../src/ui/commit-button.tsx";
import { Enter, StillOnOpen } from "../../src/ui/enter.tsx";
import { ExerciseMoveButtons } from "../../src/ui/exercise-move-buttons.tsx";
import { ExerciseNotes } from "../../src/ui/exercise-notes.tsx";
import { ExercisePicker } from "../../src/ui/exercise-picker.tsx";
import { lastFocusMove, moveFocus } from "../../src/ui/focus.ts";
import { distanceSuffix, durationLabel, workoutEffort } from "../../src/ui/format.ts";
import { haptic } from "../../src/ui/haptics.ts";
import {
  CheckIcon,
  ChevronIcon,
  ForwardIcon,
  MoreIcon,
  PlusIcon,
  TimerIcon,
} from "../../src/ui/icons.tsx";
import { SheetKeyboardAccessory } from "../../src/ui/keyboard-accessory.tsx";
import {
  DockLine,
  EditHeader,
  Keypad,
  RestSlab,
  SetStrip,
  Strong,
} from "../../src/ui/live/dock.tsx";
import { EditingRest, RestCompletion } from "../../src/ui/live/editing-rest.tsx";
import { WorkoutNotesTile } from "../../src/ui/live/notes-tile.tsx";
import { RestDialog } from "../../src/ui/live/rest-dialog.tsx";
import { RirPicks, RirQuestion } from "../../src/ui/live/rir.tsx";
import { SetEditorDock } from "../../src/ui/live/set-editor-dock.tsx";
import {
  type FieldView,
  fieldView,
  logValues,
  metricsOf,
  setDefaults,
  show,
  targetCaption,
  typedNumber,
  valuesLine,
} from "../../src/ui/live/set-fields.ts";
import { useSheetDrag } from "../../src/ui/live/sheet-drag.ts";
import { SwipeRow } from "../../src/ui/live/swipe-row.tsx";
import {
  afterLog,
  type DockTarget,
  dockTarget,
  type Entry,
  entryDistanceUnit,
  type LiveSet,
  labelOf,
  pendingAsk,
  previousForWorkout,
} from "../../src/ui/live/targets.ts";
import { UndoToast } from "../../src/ui/live/undo-toast.tsx";
import { layout } from "../../src/ui/motion.ts";
import { WorkoutMuscleSummary } from "../../src/ui/muscle-map.tsx";
import { goHome } from "../../src/ui/navigation.ts";
import { showToast } from "../../src/ui/notice.tsx";
import { SetChip, setNumbers } from "../../src/ui/set-chip.tsx";
import { SetSyncReview } from "../../src/ui/set-sync-review.tsx";
import { inputValue } from "../../src/ui/set-values.ts";
import { SheetOutline, sheetBorderWidth } from "../../src/ui/sheet-outline.tsx";
import { Tap } from "../../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";
import {
  clearSetStopwatch,
  readSetStopwatch,
  useSetStopwatch,
  writeSetStopwatch,
} from "../../src/ui/use-set-stopwatch.ts";
import { useSettled } from "../../src/ui/use-settled.ts";
import { clock, useTicker } from "../../src/ui/use-ticker.ts";
import { type SetDrafts, useWorkoutInputs } from "../../src/ui/use-workout-inputs.ts";
import { useWorkoutSelection } from "../../src/ui/use-workout-selection.ts";
import { WorkoutDetailsEditor } from "../../src/ui/workout-details-editor.tsx";

type Unit = "kg" | "lbs";
type Opened = NonNullable<Parameters<typeof updateSet>[3]>;

const setCount = (n: number) => `${n} ${n === 1 ? "set" : "sets"}`;

/** A column's heading: KG, REPS, TIME, KM… */
const HEADINGS: Record<SetMetric, (unit: Unit, distanceUnit: SetDistanceUnit) => string> = {
  weight: (unit) => unit.toUpperCase(),
  reps: () => "REPS",
  duration: () => "TIME",
  distance: (_, distanceUnit) => distanceSuffix(distanceUnit).toUpperCase(),
  count: () => "COUNT",
};

/** A field's name in a sentence. */
function fieldName(metric: SetMetric, type: string): string {
  if (metric === "count") return type === "steps_duration" ? "steps" : "floors";
  if (metric === "duration") return "time";
  return metric;
}

/**
 * The field being typed on the dock's number pad: one at a time, anywhere in the list. `from` says
 * whether it was opened from the list (Next walks on through the workout) or from the dock's own
 * strip (Next goes through that set's fields, then closes).
 */
interface Editing {
  entryId: string;
  setId: string;
  metric: SetMetric;
  /** Just opened: the first key replaces what it shows. */
  fresh: boolean;
  from: "list" | "dock";
  /** For a logged set, the correction typed so far, and the set as it was when opened. */
  correction?: { text: string | undefined; opened: Opened };
}

/** Effort being typed on the pad (after RIR 5+ or RPE 6−), for one set. */
interface RirTyping {
  setId: string;
  scale: EffortScale;
  text: string;
  /** Just opened: the first key replaces what it shows. */
  fresh: boolean;
}

/** How long Undo stays after a set is removed, unless something else is done first. */
const UNDO_MS = 8000;
/** How long a released check stays painted while the web's click, which logs it, is on its way. */
const CLICK_AFTER_RELEASE_MS = 150;
/** How long it stays while a screen reader is running on a phone, to reach and hear it. */
const UNDO_READING_MS = 10 * UNDO_MS;
/** Said once the workout is left, when a set removed just before it changed and so was kept. */
const REMOVAL_KEPT = "A removed set changed, so it was kept.";
/** Said instead when it couldn't be deleted for another reason. */
const REMOVAL_NOT_DELETED = "A removed set couldn't be deleted, so it was kept.";

/** A screen reader's way to remove a set, on every part of its row. */
const REMOVE_ACTIONS = [{ name: "remove", label: "Remove set" }];

interface FieldProblem {
  setId: string;
  metric?: SetMetric;
  message: string;
}

export default function ActiveWorkoutScreen() {
  const styles = useStyles(sheet);
  const c = useColors();
  const data = useLive();
  // A cold history read waits until the screen has slid in.
  const settled = useSettled();
  const history = usePastWorkouts(settled && !!data);
  const { change, store, version, historyVersion } = useAppData();
  const discardReview = useRef<ReturnType<typeof workoutDeletionSnapshot>>(null);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();

  const workoutId = data?.tree.workout.id;
  const { drafts, setDrafts, distanceUnits, chooseDistanceUnit } = useWorkoutInputs(
    store,
    workoutId,
  );
  const { focusIndex, pickedSetId, focusExercise, focusSet } = useWorkoutSelection(
    store,
    data?.tree,
  );
  // Every set's stopwatch can change what the list and the dock show.
  useSetStopwatch(store, workoutId ?? "");
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrollY = useRef(0);
  const headings = useRef(new Map<string, ComponentRef<typeof View>>());
  const rows = useRef(new Map<string, ComponentRef<typeof View>>());
  /** Each set's own control (its number), for focus to come back to. */
  const setControls = useRef(new Map<string, ComponentRef<typeof View>>());
  const cancelFocus = useRef<() => void>(undefined);
  useEffect(() => () => cancelFocus.current?.(), []);
  const [pickerWorkoutId, setPickerWorkoutId] = useState<string | null>(null);
  const picking = pickerWorkoutId !== null && pickerWorkoutId === workoutId;
  useEffect(() => {
    setPickerWorkoutId((openId) => (openId === workoutId ? openId : null));
  }, [workoutId]);
  const [editingDetails, setEditingDetails] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [fieldProblem, setFieldProblem] = useState<FieldProblem | null>(null);
  /** The exercise whose rest is being changed, its rest when the dialog opened, and whether the rest running now changes too. */
  const [restFor, setRestFor] = useState<{
    entryId: string;
    running: boolean;
    originalSeconds: number;
  } | null>(null);
  const revealCard = useRef<string | null>(
    focusIndex > 0 ? (data?.tree.entries[focusIndex]?.entry.id ?? null) : null,
  );
  const cardPositions = useRef(new Map<string, number>());
  const revealPendingCard = useCallback(() => {
    const id = revealCard.current;
    const y = id ? cardPositions.current.get(id) : undefined;
    if (y === undefined || !scroll.current) return;
    scroll.current.scrollTo({ y, animated: false });
    revealCard.current = null;
  }, []);
  useEffect(() => {
    if (picking || !revealCard.current) return;
    const frame = requestAnimationFrame(revealPendingCard);
    return () => cancelAnimationFrame(frame);
  }, [picking, revealPendingCard]);
  /** Brings an exercise's card to the top of the list and selects it. */
  const jumpTo = (id: string) => {
    const heading = headings.current.get(id);
    if (Platform.OS !== "web") Keyboard.dismiss();
    if (Platform.OS === "web" && heading) {
      // An earlier card may have grown without resizing this heading.
      (heading as unknown as HTMLElement).scrollIntoView?.({ block: "start" });
    } else {
      revealCard.current = id;
      revealPendingCard();
    }
    focusExercise(id);
    cancelFocus.current?.();
    cancelFocus.current = moveFocus(heading);
  };
  const [problem, setProblem] = useState<string | null>(null);
  const [trackRir] = useTrackRir();
  const showTargets = useShowTargets();
  /** The set whose editor the dock is showing (its type, and Remove set). */
  const [setEditor, setSetEditor] = useState<string | null>(null);
  /** The row slid open to show Remove. */
  const [swiped, setSwiped] = useState<string | null>(null);
  /** A set just removed, which Undo can still bring back. */
  const [removed, setRemoved] = useState<{
    setId: string;
    entryId: string;
    message: string;
  } | null>(null);
  const undoRef = useRef<ComponentRef<typeof View>>(null);
  /** The removal whose Undo the person moved keyboard focus to: it waits while it has. */
  const [undoFocused, setUndoFocused] = useState<string | null>(null);
  /** Where focus goes once the screen has drawn what changed (the set Undo brought back...). */
  const focusNext = useRef<(() => ComponentRef<typeof View> | undefined) | null>(null);
  /** The set just logged that is asked for its reps in reserve. */
  const [rirAsk, setRirAsk] = useState<string | null>(null);
  /** Whether the rest has run while asking: once it ends, the question goes. */
  const askedDuringRest = useRef(false);
  const [rirPicker, setRirPicker] = useState<{ setId: string; from: "list" | "dock" } | null>(null);
  const [rirTyping, setRirTyping] = useState<RirTyping | null>(null);
  const previous =
    data && history
      ? previousForWorkout(history, data.tree, data.settings, data.initialPlan)
      : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: set edits leave prior journals unchanged.
  const journal = useMemo(
    () => (settled && workoutId ? workoutJournalData(store, workoutId) : null),
    [store, workoutId, historyVersion, settled],
  );
  const carried = journal?.carried ?? [];
  const needsReview =
    !!journal &&
    (journal.problems.length > 0 || carried.some(({ note }) => journal.rejectedIds.has(note.id)));
  const coachReplies = carried.filter((item) => item.showReply).length;
  const rest = useRest(store, workoutId, version);
  useRestEnd(rest);

  // A field the minimised workout couldn't log without opens for typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, when the workout opens.
  useEffect(() => {
    if (!workoutId) return;
    const ask = pendingAsk.take(store, workoutId);
    if (!ask) return;
    setEditing({
      entryId: ask.entryId,
      setId: ask.setId,
      metric: ask.metric,
      fresh: true,
      from: "list",
    });
    setFieldProblem({ setId: ask.setId, metric: ask.metric, message: ask.message });
  }, [workoutId]);

  /** Runs a change, showing what went wrong instead of failing silently. */
  const run = (fn: Parameters<typeof change>[0]): boolean => {
    try {
      change(fn, "active-workout");
      setProblem(null);
      return true;
    } catch (error) {
      haptic.warning();
      setProblem((error as Error).message);
      return false;
    }
  };
  /**
   * Deletes the set removed last, now that its Undo has gone (it was only held back until now, so
   * an undone removal never reaches sync). When the workout is being left, a deletion it refuses
   * is told in a toast, since this screen and its problem are going away. Returns whether nothing
   * was refused.
   */
  const settleRemoval = (leaving = false): boolean => {
    if (removed) setRemoved(null);
    if (!heldSet(store)) return true;
    if (!leaving) return run((db) => deleteHeldSet(db));
    try {
      change((db) => deleteHeldSet(db), "active-workout");
      return true;
    } catch (error) {
      haptic.warning();
      showToast(error instanceof WorkoutActionError ? REMOVAL_KEPT : REMOVAL_NOT_DELETED);
      return false;
    }
  };
  const settle = useRef(settleRemoval);
  settle.current = settleRemoval;
  /** Runs a change after settling a removal: anything else done ends its Undo. */
  const attempt = (fn: Parameters<typeof change>[0]): boolean => {
    settleRemoval();
    return run(fn);
  };
  /**
   * Comes first in every tap: a row slid open closes, and that is all the tap does; otherwise a
   * removal can no longer be undone. Returns whether the tap is used up.
   */
  const gate = (): boolean => {
    if (swiped) {
      setSwiped(null);
      return true;
    }
    settleRemoval();
    return false;
  };
  /**
   * The gate for a tap that opens another screen: a removal it ends that is refused also uses up
   * the tap, so the lifter stays where the problem shows instead of leaving it behind.
   */
  const gateLeaving = (): boolean => {
    if (swiped) {
      setSwiped(null);
      return true;
    }
    return !settleRemoval();
  };
  /**
   * Whether focus is still on Undo (or nowhere), so it would be lost with it. A browser can tell;
   * a phone can't, so there it is whether Undo is the last place focus was sent.
   */
  const focusOnUndo = () => {
    if (Platform.OS !== "web") return !!undoRef.current && lastFocusMove() === undoRef.current;
    const active = document.activeElement;
    const undo = undoRef.current as unknown as Node | null;
    return !active || active === document.body || !!undo?.contains(active);
  };
  /** Undo has gone by itself: focus still on it moves to its exercise's heading. */
  const expireRemoval = () => {
    const entryId = removed?.entryId;
    const moveOn = focusOnUndo();
    settleRemoval();
    if (entryId && moveOn) focusNext.current = () => headings.current.get(entryId);
  };
  const expire = useRef(expireRemoval);
  expire.current = expireRemoval;
  // Undo goes after a while (longer with a screen reader, and not while it has focus), and when
  // the workout is left.
  const waiting = !!removed && undoFocused !== removed.setId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new removal starts its own wait.
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const wait = (reading: boolean) => {
      if (live) timer = setTimeout(() => expire.current(), reading ? UNDO_READING_MS : UNDO_MS);
    };
    // Browsers always say a screen reader runs: there, keyboard focus on Undo is what holds it.
    if (Platform.OS === "web") wait(false);
    else AccessibilityInfo.isScreenReaderEnabled().then(wait, () => wait(false));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [waiting, removed]);
  // Focus moves once what it moves to is on the screen.
  useEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    cancelFocus.current?.();
    cancelFocus.current = moveFocus(next());
  });
  useEffect(
    () => () => {
      settle.current(true);
    },
    [],
  );
  // The question about reps in reserve goes once the rest it was asked in has ended.
  const resting = !!rest && restProgress(rest, Date.now()).left > 0;
  useEffect(() => {
    if (!rirAsk) return;
    if (resting) askedDuringRest.current = true;
    else if (askedDuringRest.current) setRirAsk(null);
  }, [rirAsk, resting]);
  // Leaving the workout, in any way, closes the rest dialog first, so it never stays on top of
  // the screen that comes next.
  const navigation = useNavigation();
  useEffect(
    () =>
      navigation.addListener("blur", () => {
        setRestFor(null);
        settle.current(true);
      }),
    [navigation],
  );
  /** Minimises the workout, unless a correction being typed can't be saved: then it stays, saying why. */
  const minimise = (): boolean => {
    if (editing && !commit(editing)) return false;
    setRestFor(null);
    settleRemoval(true);
    if (router.canGoBack()) router.back();
    else router.replace("/");
    return true;
  };
  const drag = useSheetDrag(minimise);

  // Keeps the field being typed in sight above the dock as the pad opens or Next moves on.
  const editingSet = editing?.setId ?? rirTyping?.setId;
  useEffect(() => {
    if (!editingSet) return;
    const frame = requestAnimationFrame(() => {
      const row = rows.current.get(editingSet);
      if (!row) return;
      if (Platform.OS === "web") {
        (row as unknown as HTMLElement).scrollIntoView?.({ block: "nearest" });
        return;
      }
      row.measureInWindow?.((_x, y, _w, height) => {
        // The viewport is already laid out at its final size while the dock is animating.
        scroll.current?.measureInWindow?.((_sx, top, _sw, viewportHeight) => {
          const below = y + height + space.sm - (top + viewportHeight);
          if (below > 0)
            scroll.current?.scrollTo({ y: scrollY.current + below, animated: !reduced });
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [editingSet, reduced]);

  // A computer keyboard types into the pad too, in browsers.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    if (Platform.OS !== "web" || !(editing || rirTyping) || typeof document === "undefined") return;
    const listener = (event: KeyboardEvent) => keys.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [editing, rirTyping]);

  if (!data) {
    return (
      <View style={[styles.empty, { paddingTop: insets.top + space.xl }]}>
        <Text style={styles.emptyText}>No workout is in progress.</Text>
        <Tap accessibilityRole="button" onPress={goHome} style={styles.primary}>
          <Text style={styles.primaryLabel}>Back to Train</Text>
        </Tap>
      </View>
    );
  }

  const { tree, settings, initialPlan, summary } = data;
  const unit = settings.weightUnit;
  const ready = previous !== null;
  const plannedTimedSession =
    tree.entries.length > 0 &&
    tree.entries.every(({ entry }) =>
      METRICS_BY_TYPE[entry.content.exerciseType as ExerciseType]?.includes("duration"),
    );
  const effort = workoutEffort(summary, unit, plannedTimedSession);
  const groups = supersetMemberships(tree.entries.map(({ entry }) => entry.content.supersetId));
  const progress = setProgress(tree);
  const countedSets = tree.entries.reduce(
    (sum, { sets }) =>
      sum + sets.filter((set) => countsTowardTotals(set.content, settings.countWarmups)).length,
    0,
  );
  const title = tree.workout.content.title || "Workout";
  const target = dockTarget(tree, focusIndex, pickedSetId);
  const effortScale = initialPlan?.effortScale ?? "rir";
  const scaleFor = (set: LiveSet) => setEffortScale(set.content, initialPlan?.effortScale);
  const canStore = {
    rir: canRecordSetReserve(store),
    rpe: canRecordSetReserve(store, "rpe"),
  };
  const canStoreEffort = (set: LiveSet) => canStore[scaleFor(set)];
  // The question also needs Track RIR to be changeable here: a server that can store RIR but not
  // the setting hides the switch, and the question must not keep asking with no way to stop it.
  const asksForRir = canStore[effortScale] && canChangeTrackRir(store);

  // ---- Reading a field ----
  const distanceUnitOf = (entry: Entry) =>
    entryDistanceUnit(entry.entry.content.exerciseType, distanceUnits[entry.entry.id], settings);
  const find = (setId: string) => {
    for (const entry of tree.entries) {
      const setIndex = entry.sets.findIndex((set) => set.id === setId);
      const set = entry.sets[setIndex];
      if (set) return { entry, set, setIndex };
    }
    return null;
  };
  const defaultsOf = (entry: Entry, index: number) => {
    const text = editing?.correction?.text;
    const corrected = editing && entry.sets.slice(0, index).find((s) => s.id === editing.setId);
    const correction =
      editing &&
      corrected &&
      text?.trim() &&
      text !== inputValue(corrected.content, editing.metric, unit, distanceUnitOf(entry))
        ? { setId: corrected.id, draft: { [editing.metric]: text } }
        : undefined;
    return setDefaults(
      entry,
      index,
      drafts,
      unit,
      previous?.get(entry.entry.id)?.sets[index],
      correction,
    );
  };
  const viewOf = (entry: Entry, set: LiveSet, setIndex: number, metric: SetMetric): FieldView => {
    const distanceUnit = distanceUnitOf(entry);
    const view = fieldView({
      set: set.content,
      metric,
      type: entry.entry.content.exerciseType,
      unit,
      distanceUnit,
      draft: drafts[set.id],
      timer: readSetStopwatch(store, tree.workout.id, set.id),
      previous: defaultsOf(entry, setIndex),
      target: routineTarget(initialPlan, set.content),
      ready,
    });
    const on = editing?.setId === set.id && editing.metric === metric;
    const typed = on ? editing.correction?.text : undefined;
    if (typed !== undefined)
      return {
        ...view,
        text: typed,
        firm: true,
        missing: false,
        // − and + move on from what is typed; with nothing typed, from what was logged.
        value: typed.trim() ? typedNumber(metric, typed, unit, distanceUnit) : view.value,
      };
    if (!view.firm && accepted.has(`${set.id}:${metric}`)) return { ...view, firm: true };
    return view;
  };
  const textOf = (entry: Entry, set: LiveSet, metric: SetMetric) => {
    if (set.content.completedAt !== null) {
      if (editing?.setId === set.id && editing.metric === metric)
        return (
          editing.correction?.text ?? inputValue(set.content, metric, unit, distanceUnitOf(entry))
        );
      return inputValue(set.content, metric, unit, distanceUnitOf(entry));
    }
    if (metric === "duration") {
      const timer = readSetStopwatch(store, tree.workout.id, set.id);
      return timer?.seconds === undefined ? (timer?.text ?? "") : durationLabel(timer.seconds);
    }
    return drafts[set.id]?.[metric] ?? "";
  };

  // ---- Writing a field ----
  /** Something typed into a field answers the problem shown for it. */
  const typedInto = (setId: string, metric: SetMetric, text: string) => {
    if (
      fieldProblem?.setId === setId &&
      (!fieldProblem.metric || fieldProblem.metric === metric) &&
      text.trim()
    )
      setFieldProblem(null);
  };
  /** Writes what is typed for an unlogged set: kept on this device until Log records it. */
  const writeDraft = (entry: Entry, set: LiveSet, metric: SetMetric, text: string) => {
    typedInto(set.id, metric, text);
    if (metric === "duration") {
      writeSetStopwatch(store, tree.workout.id, set.id, { text });
      return;
    }
    const distanceUnit = distanceUnitOf(entry);
    setDrafts((d) => ({
      ...d,
      [set.id]: {
        ...d[set.id],
        [metric]: text,
        ...(metric === "weight" ? { weightUnit: unit } : {}),
        ...(metric === "distance" ? { distanceUnit } : {}),
      },
    }));
  };
  /**
   * Saves a correction typed for a logged set, through the same path as the set editor. A field
   * left empty clears that value and the set stays logged; a cleared value the set needs (its
   * reps, time or distance) is then asked for in its row. If it can't be saved, the pad stays open
   * and says why, where the lifter is typing.
   */
  const commit = (at: Editing): boolean => {
    const text = at.correction?.text;
    if (!at.correction || text === undefined) return true;
    const found = find(at.setId);
    if (!found) return true;
    const distanceUnit = distanceUnitOf(found.entry);
    if (text === inputValue(found.set.content, at.metric, unit, distanceUnit)) return true;
    const opened = at.correction.opened;
    settleRemoval();
    try {
      change(
        (db) =>
          updateSet(
            db,
            at.setId,
            correctionValues({ [at.metric]: text }, unit, distanceUnit),
            opened,
          ),
        "active-workout",
      );
    } catch (error) {
      haptic.warning();
      setFieldProblem({ setId: at.setId, metric: at.metric, message: (error as Error).message });
      return false;
    }
    setProblem(null);
    if (fieldProblem?.setId === at.setId) setFieldProblem(null);
    return true;
  };
  const open = (entry: Entry, set: LiveSet, metric: SetMetric, from: Editing["from"]) => {
    if (editing && !(editing.setId === set.id && editing.metric === metric) && !commit(editing))
      return;
    const logged = set.content.completedAt !== null;
    if (logged) focusExercise(entry.entry.id);
    else focusSet(entry.entry.id, set.id);
    setSetEditor(null);
    setRirPicker(null);
    setRirTyping(null);
    setEditing({
      entryId: entry.entry.id,
      setId: set.id,
      metric,
      fresh: true,
      from,
      ...(logged
        ? {
            correction: {
              text: undefined,
              opened: {
                id: set.id,
                values: set.content,
                parent: store.get("workout_exercise", entry.entry.id)?.content ?? null,
                exerciseType: entry.entry.content.exerciseType,
              },
            },
          }
        : {}),
    });
  };
  const close = () => {
    if (editing && commit(editing)) setEditing(null);
  };
  const press = (key: PadKey) => {
    if (!editing) return;
    const found = find(editing.setId);
    if (!found) return setEditing(null);
    const { entry, set } = found;
    const running = readSetStopwatch(store, tree.workout.id, set.id)?.startedAt !== undefined;
    if (editing.metric === "duration" && running && !editing.correction) return;
    const next = typeKey(editing.metric, textOf(entry, set, editing.metric), key, editing.fresh);
    if (next === null) return;
    if (editing.correction) {
      typedInto(set.id, editing.metric, next);
      setEditing({ ...editing, fresh: false, correction: { ...editing.correction, text: next } });
    } else {
      writeDraft(entry, set, editing.metric, next);
      setEditing({ ...editing, fresh: false });
    }
  };
  /** − or + on a field: moves it one step from what it stands for now. */
  const step = (
    entry: Entry,
    set: LiveSet,
    setIndex: number,
    metric: SetMetric,
    direction: -1 | 1,
  ) => {
    const distanceUnit = distanceUnitOf(entry);
    const view = viewOf(entry, set, setIndex, metric);
    const text = stepText(metric, view.value, direction, unit, distanceUnit);
    haptic.select();
    const on = editing?.setId === set.id && editing.metric === metric;
    if (set.content.completedAt !== null) {
      if (on && editing.correction) {
        typedInto(set.id, metric, text);
        setEditing({ ...editing, fresh: true, correction: { ...editing.correction, text } });
      }
      return;
    }
    if (
      metric === "duration" &&
      readSetStopwatch(store, tree.workout.id, set.id)?.startedAt !== undefined
    )
      return;
    writeDraft(entry, set, metric, text);
    if (on) setEditing({ ...editing, fresh: true });
  };
  const order = fieldOrder(
    tree.entries.map((entry) => ({
      metrics: metricsOf(entry.entry.content.exerciseType),
      sets: entry.sets,
    })),
    (setId) => !!find(setId)?.set.needsSyncReview,
  );
  /** Where Next goes from the field being typed. */
  const nextOf = (at: Editing) => {
    const found = find(at.setId);
    if (!found) return null;
    if (at.from === "dock") {
      const metrics = metricsOf(found.entry.entry.content.exerciseType);
      const metric = metrics[metrics.indexOf(at.metric) + 1];
      return metric
        ? {
            entryIndex: tree.entries.indexOf(found.entry),
            setIndex: found.setIndex,
            setId: at.setId,
            metric,
          }
        : null;
    }
    return nextField(order, at);
  };
  const nextName = (at: Editing): string | null => {
    const next = nextOf(at);
    if (!next) return null;
    const entry = tree.entries[next.entryIndex];
    if (!entry) return null;
    if (next.setId === at.setId) return fieldName(next.metric, entry.entry.content.exerciseType);
    const set = `set ${labelOf(entry, next.setIndex)}`;
    if (entry.entry.id === at.entryId) return set;
    return `${entry.entry.content.exerciseName.split(" ")[0]} · ${set}`;
  };
  const goNext = () => {
    if (!editing) return;
    if (!commit(editing)) return;
    const found = find(editing.setId);
    // Next on a suggestion takes it as it is: it shows as entered from now on.
    if (found && editing.fresh && !editing.correction) {
      const key = `${editing.setId}:${editing.metric}`;
      if (!textOf(found.entry, found.set, editing.metric).trim())
        setAccepted((known) => new Set(known).add(key));
    }
    const next = nextOf(editing);
    const entry = next && tree.entries[next.entryIndex];
    const set = entry?.sets[next?.setIndex ?? -1];
    if (!next || !entry || !set) return setEditing(null);
    const logged = set.content.completedAt !== null;
    if (logged) focusExercise(entry.entry.id);
    else focusSet(entry.entry.id, set.id);
    setEditing({
      entryId: entry.entry.id,
      setId: set.id,
      metric: next.metric,
      fresh: true,
      from: editing.from,
      ...(logged
        ? {
            correction: {
              text: undefined,
              opened: {
                id: set.id,
                values: set.content,
                parent: store.get("workout_exercise", entry.entry.id)?.content ?? null,
                exerciseType: entry.entry.content.exerciseType,
              },
            },
          }
        : {}),
    });
  };
  keys.current = (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, [role="dialog"], [role="alertdialog"]')) return;
    // The compact timer adds controls outside the keypad. Leave Tab and Shift+Tab to the browser
    // so they can reach those controls without committing the field. Enter still advances it.
    if (resting && event.key === "Tab") return;
    if (rirTyping) {
      if (/^[0-9]$/.test(event.key)) pressRir(event.key as PadKey);
      else if (event.key === "Backspace") pressRir("delete");
      else if (event.key === "Enter" || event.key === "Tab") doneRir();
      else if (event.key === "Escape") cancelRir();
      else return;
      event.preventDefault();
      return;
    }
    if (/^[0-9]$/.test(event.key)) press(event.key as PadKey);
    else if (event.key === "." || event.key === ",") press(".");
    else if (event.key === "Backspace") press("delete");
    else if (event.key === "Enter" || event.key === "Tab") goNext();
    else if (event.key === "Escape") close();
    else return;
    event.preventDefault();
  };

  // ---- Logging ----
  const logOne = (entry: Entry, set: LiveSet, setIndex: number) => {
    if (!ready) return;
    if (editing && !commit(editing)) return;
    const timer = readSetStopwatch(store, tree.workout.id, set.id);
    const result = logValues({
      set: set.content,
      type: entry.entry.content.exerciseType,
      unit,
      distanceUnit: distanceUnitOf(entry),
      draft: drafts[set.id],
      timer,
      previous: defaultsOf(entry, setIndex),
      target: routineTarget(initialPlan, set.content),
    });
    if (result === null) return;
    if ("error" in result) {
      haptic.warning();
      setFieldProblem({ setId: set.id, metric: result.missing, message: result.error });
      // The row stays open and asks for what is missing.
      if (result.missing) open(entry, set, result.missing, "list");
      return;
    }
    if (!attempt((db) => logSet(db, set.id, result.values))) return;
    setEditing(null);
    setSetEditor(null);
    setRirPicker(null);
    setRirTyping(null);
    setFieldProblem(null);
    focusExercise(entry.entry.id);
    haptic.tap();
    afterLog(store, tree.workout.id, entry, set.id, setDrafts);
    // Asked about this set now; a question about an earlier one goes unanswered.
    askedDuringRest.current = false;
    setRirAsk(
      asksRir({
        trackRir,
        canStore: asksForRir,
        type: entry.entry.content.exerciseType,
        set: set.content,
        scale: scaleFor(set),
      })
        ? set.id
        : null,
    );
  };
  const unlogOne = (entry: Entry, set: LiveSet) => {
    if (editing?.setId === set.id) setEditing(null);
    if (rirAsk === set.id) setRirAsk(null);
    focusExercise(entry.entry.id);
    if (!attempt((db) => unlogSet(db, set.id))) return;
    haptic.select();
    clearSetStopwatch(store, tree.workout.id, set.id);
    setFieldProblem(null);
    setDrafts((d) => {
      const { [set.id]: _, ...remaining } = d;
      return remaining;
    });
  };

  // ---- A set's editor, and removing ----
  /** "Set 2", or "Warm-up". */
  const setName = (entry: Entry, set: LiveSet) =>
    set.content.type === "warmup" ? "Warm-up" : `Set ${labelOf(entry, entry.sets.indexOf(set))}`;
  const closeEditors = () => {
    setEditing(null);
    setSetEditor(null);
    setRirPicker(null);
    setRirTyping(null);
  };
  const openSetEditor = (entry: Entry, set: LiveSet) => {
    if (gate()) return;
    if (editing && !commit(editing)) return;
    closeEditors();
    focusExercise(entry.entry.id);
    setSetEditor(set.id);
  };
  /** Gives a set another type, then returns the dock to logging. */
  const chooseType = (entry: Entry, set: LiveSet, kind: LiveSet["content"]["type"]) => {
    if (
      kind === set.content.type ||
      attempt((db) =>
        updateSet(
          db,
          set.id,
          { type: kind },
          {
            id: set.id,
            values: set.content,
            parent: store.get("workout_exercise", entry.entry.id)?.content ?? null,
            exerciseType: entry.entry.content.exerciseType,
          },
        ),
      )
    ) {
      haptic.select();
      setSetEditor(null);
    }
  };
  /**
   * Takes a set out at once, with Undo above the dock. It is only deleted once Undo has gone (see
   * set-removal.ts); a set removed before this one goes for good now.
   */
  const removeSet = (entry: Entry, set: LiveSet) => {
    setSwiped(null);
    settleRemoval();
    if (editing?.setId === set.id) setEditing(null);
    if (setEditor === set.id) setSetEditor(null);
    if (rirPicker?.setId === set.id) setRirPicker(null);
    if (rirTyping?.setId === set.id) setRirTyping(null);
    if (rirAsk === set.id) setRirAsk(null);
    const message = `${setName(entry, set)} removed`;
    if (!run((db) => holdSetRemoval(db, tree.workout.id, { set, entry: entry.entry }))) return;
    haptic.select();
    setRemoved({ setId: set.id, entryId: entry.entry.id, message });
  };
  /** Brings the removed set back exactly as it was, where it was. */
  const undoRemove = () => {
    const setId = removed?.setId;
    const undone = run((db) => {
      undoSetRemoval(db);
    });
    setRemoved(null);
    haptic.select();
    // Focus goes to the set that came back, instead of being lost with Undo.
    if (undone && setId) focusNext.current = () => setControls.current.get(setId);
  };

  // ---- Reps in reserve ----
  const recordRir = (set: LiveSet, value: number | null): boolean => {
    const scale = scaleFor(set);
    if (effortValue(set.content, scale) === value) return true;
    return attempt((db) => updateSet(db, set.id, { [effortField(scale)]: value }));
  };
  /** A pick from the strip: records it and closes the strip (and the question). */
  const pickRir = (set: LiveSet, value: number) => {
    if (!recordRir(set, value)) return;
    haptic.select();
    if (rirAsk === set.id) setRirAsk(null);
    setRirPicker(null);
  };
  /**
   * RIR 5+ or RPE 6−: opens the pad on the set's value (RIR 5 or RPE 6 when it has none), for any
   * RIR up to 10 or any RPE from 1 to 10. Nothing is recorded until Done.
   */
  const moreRir = (entry: Entry, set: LiveSet) => {
    if (editing && !commit(editing)) return;
    closeEditors();
    if (set.content.completedAt === null) focusSet(entry.entry.id, set.id);
    else focusExercise(entry.entry.id);
    const scale = scaleFor(set);
    const value = effortValue(set.content, scale);
    const text = value === null ? (scale === "rpe" ? "6" : "5") : String(value);
    setRirTyping({ setId: set.id, scale, text, fresh: true });
  };
  const toggleRirPicker = (entry: Entry, set: LiveSet, from: "list" | "dock") => {
    if (gate()) return;
    if (editing && !commit(editing)) return;
    const opening = rirPicker?.setId !== set.id || rirPicker.from !== from;
    closeEditors();
    if (set.content.completedAt === null) focusSet(entry.entry.id, set.id);
    else focusExercise(entry.entry.id);
    if (!opening) return;
    // Manual editing also answers the dock's question for this set.
    if (rirAsk === set.id) setRirAsk(null);
    setRirPicker({ setId: set.id, from });
  };
  const pressRir = (key: PadKey) => {
    if (!rirTyping) return;
    const type = rirTyping.scale === "rpe" ? typeRpe : typeRir;
    const next = type(rirTyping.text, key, rirTyping.fresh);
    if (next === null) {
      haptic.warning();
      return;
    }
    setRirTyping({ ...rirTyping, text: next, fresh: false });
  };
  /** Done records what the pad shows (a value left as it opened is left as it is). */
  const doneRir = () => {
    if (!rirTyping) return;
    const found = find(rirTyping.setId);
    const text = rirTyping.text.trim();
    const value = rirTyping.scale === "rpe" ? typedRpe(text) : text === "" ? null : Number(text);
    if (value === undefined) {
      haptic.warning();
      return;
    }
    if (found && !recordRir(found.set, value)) return;
    if (rirAsk === rirTyping.setId) setRirAsk(null);
    setRirTyping(null);
  };
  /** Closes the pad without recording anything. */
  const cancelRir = () => setRirTyping(null);

  // ---- Rest ----
  /**
   * Sets an exercise's rest for its next sets (refused if it changed since the dialog opened) and,
   * from the countdown, the running rest too.
   */
  const changeRest = (
    entryId: string,
    seconds: number,
    originalSeconds: number,
    running: ReturnType<typeof useRest>,
  ) => {
    const saved = attempt((db) =>
      setExerciseRest(db, tree.workout.id, entryId, String(seconds), originalSeconds),
    );
    if (saved && running) restTimer.retime(store, running, seconds);
    if (saved) setRestFor(null);
  };

  const editingFound = editing ? find(editing.setId) : null;
  /** The just-logged set asked for its reps in reserve, while Track RIR is on and it can be stored. */
  const asked = rirAsk && trackRir && asksForRir ? find(rirAsk) : null;
  const askedAbout = ({ entry, set, setIndex }: NonNullable<typeof asked>) =>
    `${setName(entry, set).toLowerCase()} · ${fieldsLine(entry, set, setIndex)}`;
  const rirPicks = ({ entry, set }: { entry: Entry; set: LiveSet }, tone: "bone" | "plain") => {
    const scale = scaleFor(set);
    return (
      <RirPicks
        tone={tone}
        scale={scale}
        label={`${scale === "rir" ? "Reps in reserve" : "RPE"} for ${setName(entry, set).toLowerCase()} of ${entry.entry.content.exerciseName}`}
        target={showTargets ? effortValue(routineTarget(initialPlan, set.content), scale) : null}
        value={effortValue(set.content, scale)}
        onPick={(value) => {
          if (!gate()) pickRir(set, value);
        }}
        onMore={() => {
          if (!gate()) moreRir(entry, set);
        }}
      />
    );
  };
  const manualRirPicks = (entry: Entry, set: LiveSet) => (
    <>
      {rirPicks({ entry, set }, "plain")}
      {effortValue(set.content, scaleFor(set)) !== null && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Clear effort"
          onPress={() => {
            if (!gate() && recordRir(set, null)) setRirPicker(null);
          }}
        >
          <Text style={styles.target}>Clear effort</Text>
        </Tap>
      )}
    </>
  );
  const fieldsLine = (entry: Entry, set: LiveSet, setIndex: number) =>
    valuesLine(
      metricsOf(entry.entry.content.exerciseType).map((metric) => ({
        metric,
        view: viewOf(entry, set, setIndex, metric),
      })),
      unit,
    );
  const previousLine = (entry: Entry, setIndex: number) => {
    const prev = previous?.get(entry.entry.id)?.sets[setIndex];
    if (!prev) return "–";
    const distanceUnit = distanceUnitOf(entry);
    return metricsOf(entry.entry.content.exerciseType)
      .map((m) => show(m, previousValue(prev, m), unit, distanceUnit) || "–")
      .join(" × ");
  };

  const typing = rirTyping ? find(rirTyping.setId) : null;
  const editorFound = setEditor ? find(setEditor) : null;
  const dockRir = rirPicker?.from === "dock" ? find(rirPicker.setId) : null;
  const typingFromDock = editing?.from === "dock" && editing.setId === target?.set.id;
  const editorOpen =
    (editing?.from === "list" && editingFound) ||
    typingFromDock ||
    typing ||
    editorFound ||
    dockRir;
  // Keep the slab in the same dock slot as an editor opens so the countdown can resize in place.
  const fullRest = !editorOpen && rest && resting ? rest : null;
  const dockRest = editorOpen ? rest : fullRest;
  const dockContent = (): ReactNode => {
    // Typing a set from the list: the dock becomes the pad.
    if (editing && editing.from === "list" && editingFound) {
      const { entry, set, setIndex } = editingFound;
      const label = labelOf(entry, setIndex);
      const logged = set.content.completedAt !== null;
      const name = fieldName(editing.metric, entry.entry.content.exerciseType);
      const view = viewOf(entry, set, setIndex, editing.metric);
      const setName = set.content.type === "warmup" ? "Warm-up" : `Set ${label}`;
      const problemHere = fieldProblem?.setId === set.id ? fieldProblem.message : null;
      return (
        <>
          <EditHeader
            chip={label}
            logged={logged}
            exercise={entry.entry.content.exerciseName}
            detail={[
              setName,
              name,
              logged ? "logged" : null,
              `last ${previousLine(entry, setIndex)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            announcement={`${entry.entry.content.exerciseName}, ${setName}, ${name}: ${view.text}`}
            onDone={close}
          />
          {problemHere && (
            <Text accessibilityRole="alert" style={styles.dockProblem}>
              {problemHere}
            </Text>
          )}
          <Keypad
            tall
            metric={editing.metric}
            step={stepLabel(editing.metric, unit, distanceUnitOf(entry))}
            next={{ to: nextName(editing) }}
            onKey={press}
            onStep={(direction) => step(entry, set, setIndex, editing.metric, direction)}
            onNext={goNext}
          />
        </>
      );
    }
    // Effort after RIR 5+ or RPE 6−: the pad, for whole RIR up to 10 or RPE from 1 to 10 in half
    // steps, with one Done (its last key).
    if (rirTyping && typing) {
      const { entry, set, setIndex } = typing;
      const name = setName(entry, set);
      const rpe = rirTyping.scale === "rpe";
      const effortName = rpe ? "RPE" : "reps in reserve";
      return (
        <>
          <EditHeader
            chip={labelOf(entry, setIndex)}
            logged={set.content.completedAt !== null}
            exercise={entry.entry.content.exerciseName}
            detail={`${name} · ${effortName} · ${rpe ? "1 to 10" : "0 to 10"}`}
            announcement={`${entry.entry.content.exerciseName}, ${name}, ${effortName}: ${rirTyping.text || "empty"}`}
            onCancel={cancelRir}
          />
          <Keypad
            tall
            metric="reps"
            decimal={rpe}
            step={rpe ? "0.5" : "1"}
            next={{ to: null }}
            onKey={pressRir}
            onStep={(direction) =>
              setRirTyping({
                ...rirTyping,
                text: (rpe ? stepRpe : stepRir)(rirTyping.text, direction),
                fresh: true,
              })
            }
            onNext={doneRir}
          />
        </>
      );
    }
    if (dockRir) {
      const { entry, set, setIndex } = dockRir;
      const name = entry.entry.content.exerciseName;
      const detail = `${setName(entry, set)} · ${effortLabel(scaleFor(set))}`;
      return (
        <>
          <EditHeader
            chip={labelOf(entry, setIndex)}
            logged={set.content.completedAt !== null}
            exercise={name}
            detail={detail}
            announcement={`${name}, ${detail}`}
            onCancel={() => setRirPicker(null)}
          />
          {manualRirPicks(entry, set)}
        </>
      );
    }
    // The set's own editor, from its number: its type, and Remove set.
    if (editorFound) {
      const { entry, set, setIndex } = editorFound;
      const logged = set.content.completedAt !== null;
      const scale = scaleFor(set);
      const reserve = effortValue(set.content, scale);
      return (
        <SetEditorDock
          chip={labelOf(entry, setIndex)}
          logged={logged}
          exercise={entry.entry.content.exerciseName}
          detail={[
            setName(entry, set),
            logged ? `logged · ${fieldsLine(entry, set, setIndex)}` : "not logged",
            reserve != null ? `${effortLabel(scale)} ${reserve}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          value={set.content.type}
          onType={(kind) => chooseType(entry, set, kind)}
          effort={
            canStoreEffort(set) && countsReps(entry.entry.content.exerciseType)
              ? {
                  label: `Edit ${effortLabel(scale)}`,
                  onPress: () => toggleRirPicker(entry, set, "dock"),
                }
              : undefined
          }
          onRemove={() => removeSet(entry, set)}
          onDone={() => setSetEditor(null)}
        />
      );
    }
    if (fullRest) return null;
    if (!target) {
      if (tree.entries.length === 0)
        return (
          <Tap
            accessibilityRole="button"
            onPress={() => setPickerWorkoutId(picking ? null : tree.workout.id)}
            style={styles.dockAdd}
          >
            <View>
              <Text style={styles.dockAddLabel}>Add exercise</Text>
              <Text style={styles.dockAddDetail}>From the library</Text>
            </View>
            <PlusIcon color={c.bg} size={24} />
          </Tap>
        );
      return (
        <>
          <View style={styles.dockDone}>
            <Text style={styles.dockDoneCount}>{progress.done}</Text>
            <Text style={styles.dockDoneText}>
              {`${progress.done === 1 ? "set" : "sets"} logged · ${effort.amount}${effort.unit ? ` ${effort.unit}` : ""}`}
            </Text>
          </View>
          <CommitButton
            label="Finish workout"
            detail="Review, then save"
            icon={<ForwardIcon color={c.commitInk} size={26} />}
            onPress={() => {
              if (!settleRemoval()) return;
              setRestFor(null);
              router.push("/workout/finish");
            }}
          />
        </>
      );
    }
    // The strip: the set's fields with ± and the check that logs it.
    const { entry, set, setIndex, label } = target;
    const type = entry.entry.content.exerciseType;
    const distanceUnit = distanceUnitOf(entry);
    const fromDock = typingFromDock ? editing : null;
    const timer = readSetStopwatch(store, tree.workout.id, set.id);
    const planned = showTargets ? routineTarget(initialPlan, set.content) : undefined;
    const scale = scaleFor(set);
    const currentEffort = effortValue(set.content, scale);
    const plannedEffort = effortCaption(planned, initialPlan?.effortScale);
    const fields = metricsOf(type).map((metric) => {
      const view = viewOf(entry, set, setIndex, metric);
      const size = stepSize(metric, unit, distanceUnit);
      return {
        metric,
        name: fieldName(metric, type),
        text: view.text,
        firm: view.firm,
        target: targetCaption(planned, metric, unit, distanceUnit) ?? undefined,
        unit:
          metric === "weight"
            ? unit
            : metric === "duration"
              ? "m:ss"
              : metric === "distance"
                ? distanceSuffix(distanceUnit)
                : fieldName(metric, type),
        ...(metric === "weight" ? { step: stepLabel(metric, unit, distanceUnit) } : {}),
        steps: (view.value ?? 0) / size,
        editing: fromDock?.metric === metric,
        onStep: (direction: -1 | 1) => {
          if (!gate()) step(entry, set, setIndex, metric, direction);
        },
        onEdit: () => {
          if (!gate()) open(entry, set, metric, "dock");
        },
      };
    });
    const what = set.content.type === "warmup" ? "warm-up" : `set ${label}`;
    return (
      <>
        <DockLine
          marker={{ label, onPress: () => openSetEditor(entry, set) }}
          left={
            <Text>
              <Strong>{entry.entry.content.exerciseName}</Strong>
              {fromDock
                ? ` · typing ${fieldName(fromDock.metric, type)}`
                : set.content.type === "warmup"
                  ? " · warm-up"
                  : ` · of ${setCount(entry.sets.filter((s) => s.content.type !== "warmup").length)}`}
            </Text>
          }
          right={
            <Text>
              {"Last "}
              <Strong>{previousLine(entry, setIndex)}</Strong>
            </Text>
          }
        />
        <SetStrip
          fields={fields}
          effort={
            countsReps(type) && (plannedEffort !== null || currentEffort !== null)
              ? {
                  label: effortLabel(scale),
                  value: currentEffort,
                  target: plannedEffort,
                  onEdit: canStoreEffort(set)
                    ? () => toggleRirPicker(entry, set, "dock")
                    : undefined,
                }
              : undefined
          }
          logLabel={`Log ${what} of ${entry.entry.content.exerciseName}`}
          canLog={ready && timer?.startedAt === undefined}
          onLog={() => {
            if (!gate()) logOne(entry, set, setIndex);
          }}
        />
        {fromDock && fieldProblem?.setId === set.id && (
          <Text accessibilityRole="alert" style={styles.dockProblem}>
            {fieldProblem.message}
          </Text>
        )}
        {fromDock && (
          <Keypad
            metric={fromDock.metric}
            step={stepLabel(fromDock.metric, unit, distanceUnit)}
            next={{ to: nextName(fromDock) }}
            onKey={press}
            onStep={(direction) => step(entry, set, setIndex, fromDock.metric, direction)}
            onNext={goNext}
          />
        )}
      </>
    );
  };
  /** Without a rest timer, the question sits above the logging strip. */
  const askAbove =
    asked && !resting && !editing && !rirTyping && !setEditor && !dockRir ? (
      <View style={styles.ask}>
        <RirQuestion scale={effortScale} about={askedAbout(asked)} onSkip={() => setRirAsk(null)} />
        {rirPicks(asked, "plain")}
      </View>
    ) : null;
  const restEntry = restFor ? tree.entries.find((e) => e.entry.id === restFor.entryId) : undefined;
  const runningRest =
    restFor?.running && rest && rest.source.entryId === restFor.entryId ? rest : null;

  const restNext = target
    ? `${target.entry.entry.content.exerciseName} · ${setOf(target)} · ${fieldsLine(target.entry, target.set, target.setIndex)}`
    : "All sets logged";
  const editingRest = (
    <EditingRest key={tree.workout.id} workoutId={tree.workout.id} next={restNext} />
  );
  const screen = (
    <StillOnOpen>
      <View style={[styles.ground, { paddingTop: Math.max(insets.top, space.sm) }]}>
        <Animated.View style={[styles.screen, drag.style]}>
          <View {...drag.handlers} style={styles.header}>
            <View style={styles.grab} />
            <View style={styles.headerRow}>
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Minimise workout"
                onPress={minimise}
                style={styles.iconButton}
              >
                <ChevronIcon direction="down" color={c.fg} />
              </Tap>
              <Tap
                accessibilityRole="button"
                accessibilityLabel={
                  data.needsDetailReview ? "Review workout sync issue" : "Edit workout details"
                }
                style={styles.titleButton}
                onPress={() => {
                  if (!gate()) setEditingDetails(tree.workout.id);
                }}
              >
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {title}
                </Text>
                {data.needsDetailReview ? (
                  <Text style={styles.reviewLabel}>Review sync issue</Text>
                ) : (
                  <Subline
                    startedAt={tree.workout.content.startedAt}
                    sets={`${progress.done}/${progress.total} sets`}
                    effort={
                      effort.label === "Volume"
                        ? `${effort.amount}${effort.unit ? ` ${effort.unit}` : ""}`
                        : `${effort.label} ${effort.amount}`
                    }
                  />
                )}
              </Tap>
              {editingDetails === tree.workout.id && (
                <WorkoutDetailsEditor
                  mode="active"
                  workout={tree.workout}
                  onClose={() => setEditingDetails(null)}
                />
              )}
              <Tap
                accessibilityRole="button"
                onPress={() => {
                  if (gateLeaving()) return;
                  if (editing && !commit(editing)) return;
                  closeEditors();
                  setRestFor(null);
                  router.push("/workout/finish");
                }}
                style={styles.finish}
              >
                <Text style={styles.finishLabel}>Finish</Text>
              </Tap>
            </View>
            {tree.entries.length > 0 && (
              <View style={styles.segments}>
                {tree.entries.map((entry, index) => {
                  const done = entry.sets.filter((s) => s.content.completedAt !== null).length;
                  const current = target?.entryIndex === index;
                  return (
                    <Tap
                      key={entry.entry.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Jump to ${entry.entry.content.exerciseName}, ${done} of ${setCount(entry.sets.length)} done`}
                      hitSlop={{ top: 10, bottom: 10 }}
                      onPress={() => {
                        if (!gate()) jumpTo(entry.entry.id);
                      }}
                      scaleTo={1}
                      style={styles.segmentHit}
                    >
                      <View style={[styles.segment, current && styles.segmentCurrent]}>
                        <View
                          style={[
                            styles.segmentFill,
                            {
                              width: `${(entry.sets.length ? done / entry.sets.length : 0) * 100}%`,
                            },
                          ]}
                        />
                      </View>
                    </Tap>
                  );
                })}
              </View>
            )}
          </View>

          <ScrollView
            ref={scroll}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={32}
            onScroll={({ nativeEvent }) => {
              scrollY.current = nativeEvent.contentOffset.y;
            }}
            contentContainerStyle={styles.scrollContent}
          >
            {/* What is there when the screen opens is just there; only later changes move. */}
            <StillOnOpen>
              <View style={styles.body}>
                {/* The whole workout: its muscles so far, and its notes. */}
                <View style={styles.topRow}>
                  <WorkoutMuscleSummary amounts={data.muscleSets} sets={countedSets} />
                  <WorkoutNotesTile
                    count={carried.length + (journal?.notes.length ?? 0)}
                    coachReplies={coachReplies}
                    needsReview={needsReview}
                    onPress={() => {
                      if (gateLeaving()) return;
                      setRestFor(null);
                      router.push({
                        pathname: "/workout/notes/[id]",
                        params: { id: tree.workout.id },
                      });
                    }}
                  />
                </View>
                {problem && (
                  <Enter leaves>
                    <Text accessibilityRole="alert" style={styles.problem}>
                      {problem}
                    </Text>
                  </Enter>
                )}
                {tree.entries.map((entry, index) => {
                  const group = groups[index];
                  const partner = group && tree.entries[group.next];
                  return (
                    <View
                      key={entry.entry.id}
                      onLayout={({ nativeEvent }) => {
                        cardPositions.current.set(entry.entry.id, nativeEvent.layout.y);
                        if (!picking && revealCard.current === entry.entry.id) revealPendingCard();
                      }}
                    >
                      <EntryCard
                        actionProblem={problem}
                        headingRef={(node) => {
                          if (node) headings.current.set(entry.entry.id, node);
                          else headings.current.delete(entry.entry.id);
                        }}
                        rowRef={(setId, node) => {
                          if (node) rows.current.set(setId, node);
                          else rows.current.delete(setId);
                        }}
                        controlRef={(setId, node) => {
                          if (node) setControls.current.set(setId, node);
                          else setControls.current.delete(setId);
                        }}
                        index={index}
                        count={tree.entries.length}
                        group={group?.label}
                        entry={entry}
                        unit={unit}
                        distanceUnit={distanceUnitOf(entry)}
                        otherDistanceUnit={
                          distanceUnitOf(entry) === settings.distanceUnit
                            ? settings.shortDistanceUnit
                            : settings.distanceUnit
                        }
                        drafts={drafts}
                        workoutId={tree.workout.id}
                        plan={initialPlan}
                        previousTopOfRange={previous?.get(entry.entry.id)?.topOfRange ?? null}
                        effortScale={effortScale}
                        showTargets={showTargets}
                        legacyRoutine={!!tree.workout.content.routineId && !initialPlan}
                        ready={ready}
                        currentSetId={target?.set.id}
                        editing={editing}
                        // The pad shows the problem of the set it is open on.
                        fieldProblem={editing?.setId === fieldProblem?.setId ? null : fieldProblem}
                        viewOf={(set, setIndex, metric) => viewOf(entry, set, setIndex, metric)}
                        previousLine={(setIndex) => previousLine(entry, setIndex)}
                        showRir={showsRirColumn({
                          trackRir,
                          type: entry.entry.content.exerciseType,
                          sets: entry.sets,
                          ...(initialPlan?.effortScale && { scale: initialPlan.effortScale }),
                          hasTarget:
                            showTargets &&
                            entry.sets.some(
                              ({ content }) =>
                                effortCaption(
                                  routineTarget(initialPlan, content),
                                  initialPlan?.effortScale,
                                ) !== null,
                            ),
                        })}
                        canStoreRir={canStoreEffort}
                        rirRowId={rirPicker?.from === "list" ? rirPicker.setId : null}
                        rirTyping={rirTyping}
                        rirPicks={(set) => manualRirPicks(entry, set)}
                        swipedId={swiped}
                        canSwipe={!editing && !setEditor && !rirTyping && !rirPicker}
                        editorSetId={setEditor ?? rirTyping?.setId ?? null}
                        onSwipe={(set, opened) => {
                          if (opened) settleRemoval();
                          setSwiped(opened ? set.id : null);
                        }}
                        onRemoveSet={(set) => removeSet(entry, set)}
                        onEditSet={(set) => openSetEditor(entry, set)}
                        onRirCell={(set) => toggleRirPicker(entry, set, "list")}
                        onGate={gate}
                        onInteract={() => focusExercise(entry.entry.id)}
                        onPick={(set) => {
                          if (gate()) return;
                          if (editing && !commit(editing)) return;
                          closeEditors();
                          if (set.content.completedAt === null) focusSet(entry.entry.id, set.id);
                        }}
                        onCell={(set, metric) => {
                          if (!gate()) open(entry, set, metric, "list");
                        }}
                        onLog={(set, setIndex) => {
                          if (!gate()) logOne(entry, set, setIndex);
                        }}
                        onUnlog={(set) => {
                          if (!gate()) unlogOne(entry, set);
                        }}
                        onChooseDistanceUnit={(chosen) =>
                          chooseDistanceUnit(entry.entry.id, chosen)
                        }
                        onRest={() =>
                          setRestFor({
                            entryId: entry.entry.id,
                            running: false,
                            originalSeconds: entry.entry.content.restSeconds,
                          })
                        }
                        onMove={(direction) =>
                          attempt((db) =>
                            moveWorkoutExercise(db, tree.workout.id, entry.entry.id, direction),
                          )
                        }
                        onRemove={(reviewed) =>
                          attempt((db) =>
                            removeWorkoutExercise(db, tree.workout.id, entry.entry.id, reviewed),
                          )
                        }
                        onAddSet={() => attempt((db) => addSet(db, entry.entry.id))}
                        onTimer={(set) => {
                          setFieldProblem(null);
                          focusExercise(entry.entry.id);
                          const timer = readSetStopwatch(store, tree.workout.id, set.id);
                          if (timer?.startedAt !== undefined)
                            writeSetStopwatch(store, tree.workout.id, set.id, {
                              seconds: Math.max(
                                0,
                                Math.floor((Date.now() - timer.startedAt) / 1000),
                              ),
                            });
                          else {
                            writeSetStopwatch(store, tree.workout.id, set.id, {
                              startedAt: Date.now(),
                            });
                            restTimer.skip(store, tree.workout.id);
                          }
                        }}
                        onSyncResolved={(set) => {
                          clearSetStopwatch(store, tree.workout.id, set.id);
                          setDrafts((d) => {
                            const { [set.id]: _, ...remaining } = d;
                            return remaining;
                          });
                        }}
                      />
                      {group && partner && (
                        <Tap
                          accessibilityRole="button"
                          accessibilityLabel={`Next in ${group.label}: ${partner.entry.content.exerciseName}, exercise ${group.next + 1}`}
                          style={styles.partner}
                          onPress={() => jumpTo(partner.entry.id)}
                        >
                          <Text style={styles.partnerLabel}>
                            Next in superset · {partner.entry.content.exerciseName}
                          </Text>
                          <ChevronIcon direction="right" color={c.fg} size={18} />
                        </Tap>
                      )}
                    </View>
                  );
                })}
                {tree.entries.length === 0 && (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>Empty workout</Text>
                    <Text style={styles.emptyText}>Add an exercise to start logging.</Text>
                  </View>
                )}

                <Tap
                  accessibilityRole="button"
                  accessibilityState={{ expanded: picking }}
                  onPress={() => {
                    if (!gate()) setPickerWorkoutId(picking ? null : tree.workout.id);
                  }}
                  style={styles.secondary}
                >
                  <PlusIcon color={c.fg} size={16} />
                  <Text style={styles.secondaryLabel}>Add exercise</Text>
                </Tap>
                {picking && (
                  <ExercisePicker
                    included={tree.entries.map((e) => e.entry.content.exerciseId)}
                    onClose={() => setPickerWorkoutId(null)}
                    onPickMany={(exercises) => {
                      const added = change(
                        (db) =>
                          addSelectedExercises(
                            db,
                            tree.workout.id,
                            exercises,
                            settings.defaultRestSeconds,
                          ),
                        "active-workout",
                      );
                      const first = added[0];
                      if (first) {
                        focusExercise(first);
                        revealCard.current = first;
                      }
                      setProblem(null);
                      setPickerWorkoutId(null);
                    }}
                  />
                )}
                <DestructiveButton
                  key={tree.workout.id}
                  label="Discard workout"
                  message="This workout and everything logged in it will be deleted. This can’t be undone."
                  keep="Keep training"
                  busyLabel="Discarding…"
                  onAsk={() => {
                    // Opening the sheet ends a removal’s Undo, so the workout it shows is the one
                    // discarded, and a change made to it meanwhile refuses the discard.
                    settleRemoval();
                    discardReview.current = workoutDeletionSnapshot(store, tree.workout.id);
                  }}
                  capture
                  onConfirm={() => {
                    if (
                      attempt((db) =>
                        discardReviewedActiveWorkout(db, tree.workout.id, discardReview.current),
                      )
                    ) {
                      restTimer.skip(store, tree.workout.id);
                      setRestFor(null);
                      goHome();
                    }
                  }}
                />
              </View>
            </StillOnOpen>
          </ScrollView>
          <Animated.View
            layout={dockRest && Platform.OS !== "web" ? layout : undefined}
            style={[
              styles.dock,
              dockRest && Platform.OS !== "web" && styles.clipDock,
              { paddingBottom: Math.max(insets.bottom, space.md) + space.sm },
            ]}
          >
            {removed && (
              <UndoToast
                key={removed.setId}
                message={removed.message}
                undoRef={undoRef}
                onUndo={undoRemove}
                onFocusChange={(focused) => {
                  const id = removed.setId;
                  setUndoFocused((now) => (focused ? id : now === id ? null : now));
                }}
              />
            )}
            {askAbove}
            {fullRest &&
              (asked ? (
                <RirQuestion
                  scale={effortScale}
                  about={askedAbout(asked)}
                  onSkip={() => setRirAsk(null)}
                />
              ) : (
                <DockLine
                  left={
                    target ? (
                      <Text>
                        {"Up next · "}
                        <Strong>{target.entry.entry.content.exerciseName}</Strong>
                        {` · ${setOf(target)}`}
                      </Text>
                    ) : (
                      "All sets logged"
                    )
                  }
                  right={
                    target ? (
                      <Strong>{fieldsLine(target.entry, target.set, target.setIndex)}</Strong>
                    ) : undefined
                  }
                />
              ))}
            {dockRest && (
              <RestSlab
                key={`timer-${tree.workout.id}`}
                rest={dockRest}
                style={[styles.dockTimer, !fullRest && styles.restAboveEditor]}
                band={fullRest && asked ? rirPicks(asked, "bone") : undefined}
                onTime={
                  fullRest
                    ? () =>
                        setRestFor({
                          entryId: fullRest.source.entryId,
                          running: true,
                          originalSeconds:
                            tree.entries.find((e) => e.entry.id === fullRest.source.entryId)?.entry
                              .content.restSeconds ?? 0,
                        })
                    : undefined
                }
                onAdjust={(seconds) => restTimer.adjust(store, dockRest, seconds)}
                onSkip={() => restTimer.skip(store, tree.workout.id, dockRest.source)}
              />
            )}
            {editorOpen && (
              <RestCompletion
                key={`rest-end-${tree.workout.id}`}
                rest={rest}
                next={restNext}
                style={styles.restAboveEditor}
              />
            )}
            {dockContent()}
          </Animated.View>
          <SheetOutline radius={radius.hero} sides />
        </Animated.View>
        {restFor && restEntry && (
          <RestDialog
            title={restEntry.entry.content.exerciseName}
            note={
              runningRest
                ? "This rest, and the next ones for this exercise"
                : "After each set of this exercise"
            }
            initialSeconds={
              runningRest ? runningRest.totalSeconds : restEntry.entry.content.restSeconds
            }
            left={
              runningRest ? clock(restProgress(runningRest, Date.now()).left / 1000) : undefined
            }
            onClose={() => setRestFor(null)}
            onSet={(seconds) =>
              changeRest(restEntry.entry.id, seconds, restFor.originalSeconds, runningRest)
            }
          />
        )}
      </View>
    </StillOnOpen>
  );
  return (
    <SheetKeyboardAccessory.Provider value={editingRest}>{screen}</SheetKeyboardAccessory.Provider>
  );
}

/** "set 2/3" or "warm-up", for the dock's lines. */
function setOf(target: DockTarget): string {
  if (target.set.content.type === "warmup") return "warm-up";
  const working = target.entry.sets.filter((s) => s.content.type !== "warmup").length;
  return `set ${target.label}/${working}`;
}

/** Ends the rest when its time is up, with a tap felt only if it ends now. */
function useRestEnd(rest: ReturnType<typeof useRest>) {
  const { store } = useAppData();
  const now = useTicker(rest !== null);
  const remaining = rest ? Math.ceil(restProgress(rest, now).left / 1000) : 0;
  useEffect(() => {
    if (rest && remaining <= 0) {
      // Only a rest that ends now is felt; one that ended while this screen was closed isn't.
      if (restTimer.expire(store, rest) && Date.now() - rest.endsAt < 2000) haptic.success();
    }
  }, [rest, remaining, store]);
}

/**
 * The line under the title: the running duration, sets done and the work so far. The clock ticks
 * on its own, so the rest of the screen doesn't render again every second.
 */
function Subline({ startedAt, sets, effort }: { startedAt: string; sets: string; effort: string }) {
  const styles = useStyles(sheet);
  const now = useTicker();
  const elapsed = clock((now - Date.parse(startedAt)) / 1000);
  return (
    <View
      accessible
      accessibilityLabel={`Duration ${elapsed}, ${sets}, ${effort}`}
      style={styles.subline}
    >
      <View style={styles.liveDot} />
      <Text style={styles.sublineText} numberOfLines={1}>
        {`${elapsed} · ${sets} · ${effort}`}
      </Text>
    </View>
  );
}

function EntryCard({
  actionProblem,
  headingRef,
  rowRef,
  controlRef,
  index,
  count,
  group,
  entry,
  unit,
  distanceUnit,
  otherDistanceUnit,
  drafts,
  workoutId,
  plan,
  previousTopOfRange,
  effortScale,
  showTargets,
  legacyRoutine,
  ready,
  currentSetId,
  editing,
  fieldProblem,
  viewOf,
  previousLine,
  showRir,
  canStoreRir,
  rirRowId,
  rirTyping,
  rirPicks,
  swipedId,
  canSwipe,
  editorSetId,
  onSwipe,
  onRemoveSet,
  onEditSet,
  onRirCell,
  onGate,
  onInteract,
  onPick,
  onCell,
  onLog,
  onUnlog,
  onChooseDistanceUnit,
  onRest,
  onMove,
  onRemove,
  onAddSet,
  onTimer,
  onSyncResolved,
}: {
  actionProblem: string | null;
  headingRef: RefCallback<ComponentRef<typeof View>>;
  rowRef: (setId: string, node: ComponentRef<typeof View> | null) => void;
  controlRef: (setId: string, node: ComponentRef<typeof View> | null) => void;
  index: number;
  count: number;
  group: string | undefined;
  entry: Entry;
  unit: Unit;
  distanceUnit: SetDistanceUnit;
  otherDistanceUnit: SetDistanceUnit;
  drafts: SetDrafts;
  workoutId: string;
  plan: WorkoutPlan | null;
  previousTopOfRange: number | null;
  effortScale: EffortScale;
  showTargets: boolean;
  legacyRoutine: boolean;
  ready: boolean;
  /** The set the dock logs next. */
  currentSetId: string | undefined;
  editing: Editing | null;
  fieldProblem: FieldProblem | null;
  viewOf: (set: LiveSet, setIndex: number, metric: SetMetric) => FieldView;
  previousLine: (setIndex: number) => string;
  /** Whether the sets show a reps in reserve column. */
  showRir: boolean;
  /** Whether reps in reserve can be changed (the account can store it). */
  canStoreRir: (set: LiveSet) => boolean;
  /** The set with the reps in reserve strip open under its row. */
  rirRowId: string | null;
  /** Reps in reserve being typed on the pad, shown in its set's cell. */
  rirTyping: RirTyping | null;
  rirPicks: (set: LiveSet) => ReactNode;
  /** The row slid open to show Remove. */
  swipedId: string | null;
  canSwipe: boolean;
  /** The set the dock is editing (its type, or its reps in reserve). */
  editorSetId: string | null;
  onSwipe: (set: LiveSet, open: boolean) => void;
  onRemoveSet: (set: LiveSet) => void;
  onEditSet: (set: LiveSet) => void;
  onRirCell: (set: LiveSet) => void;
  /** Comes first in a tap; true when the tap only closed a row slid open. */
  onGate: () => boolean;
  onInteract: () => void;
  onPick: (set: LiveSet) => void;
  onCell: (set: LiveSet, metric: SetMetric) => void;
  onLog: (set: LiveSet, setIndex: number) => void;
  onUnlog: (set: LiveSet) => void;
  onChooseDistanceUnit: (unit: SetDistanceUnit) => void;
  onRest: () => void;
  onMove: (direction: -1 | 1) => boolean;
  onRemove: (reviewed: ReturnType<typeof exerciseRemovalSnapshot>) => void;
  onAddSet: () => void;
  onTimer: (set: LiveSet) => void;
  onSyncResolved: (set: LiveSet) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { store } = useAppData();
  const removal = useRef<ReturnType<typeof exerciseRemovalSnapshot>>(null);
  const interact = (action: () => void) => {
    if (onGate()) return;
    onInteract();
    action();
  };
  const [expanded, setExpanded] = useState(true);
  const [managing, setManaging] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const sheetScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const afterDismiss = useRef<() => void>(undefined);
  const dismissed = () => {
    setManaging(false);
    setDismissing(false);
    const next = afterDismiss.current;
    afterDismiss.current = undefined;
    next?.();
  };
  const closeMenu = (next?: () => void) => {
    afterDismiss.current = next;
    // Wait for UIKit to dismiss this modal before presenting another.
    if (Platform.OS === "ios") setDismissing(true);
    else dismissed();
  };
  const type = entry.entry.content.exerciseType;
  const metrics = metricsOf(type);
  const done = entry.sets.filter((s) => s.content.completedAt !== null).length;
  const numbers = setNumbers(entry.sets);
  const name = entry.entry.content.exerciseName;
  const restSeconds = entry.entry.content.restSeconds;
  const [showDistanceError, setShowDistanceError] = useState(false);
  const invalidDistance = entry.sets.some(({ id, content, needsSyncReview }) => {
    if (content.completedAt !== null || needsSyncReview) return false;
    const draft = drafts[id];
    return (
      !!draft?.distance &&
      parseTyped("distance", draft.distance, unit, draft.distanceUnit ?? distanceUnit) === "invalid"
    );
  });
  const complete = done === entry.sets.length && entry.sets.length > 0;
  const topOfRange = topOfRepRanges(entry, plan);
  const rangeCount = topOfRange ?? previousTopOfRange;
  const labelLegacyEffort =
    !plan?.effortScale && entry.sets.some(({ content }) => content.rpe != null);
  return (
    // A different exercise slides in; its rows start in place and move only as sets change.
    <Enter style={styles.card}>
      <StillOnOpen>
        <View style={styles.cardHead}>
          <Text style={[styles.cardIndex, complete && styles.cardIndexDone]}>
            {String(index + 1).padStart(2, "0")}
          </Text>
          <Tap
            ref={headingRef}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityState={{ expanded }}
            onPress={() => interact(() => setExpanded(!expanded))}
            scaleTo={1}
            style={styles.cardTitle}
          >
            <Text style={styles.exercise} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.exerciseLine} numberOfLines={1}>
              {[`${done} of ${setCount(entry.sets.length)}`, group].filter(Boolean).join(" · ")}
            </Text>
          </Tap>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Rest ${restSeconds > 0 ? clock(restSeconds) : "off"} for ${name}. Change it`}
            onPress={() => interact(onRest)}
            style={styles.chip}
          >
            <TimerIcon color={c.fg2} size={15} />
            <Text style={styles.chipText}>{restSeconds > 0 ? clock(restSeconds) : "Off"}</Text>
          </Tap>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Manage ${name}`}
            accessibilityState={{ expanded: managing }}
            onPress={() => interact(() => setManaging(true))}
            style={styles.chipIcon}
          >
            <MoreIcon color={c.fg2} size={18} />
          </Tap>
        </View>
        {rangeCount !== null && (
          <Text style={styles.rangeResult}>
            {topOfRange === null ? "Last time · " : ""}
            {`Top of range in all ${setCount(rangeCount)}`}
          </Text>
        )}
        {managing && (
          <BottomSheet
            title={name}
            close="x"
            closeLabel="Close exercise options"
            visible={!dismissing}
            onDismiss={dismissed}
            onClose={() => closeMenu()}
            scrollRef={sheetScroll}
          >
            <View style={styles.actions}>
              {actionProblem && (
                <Text accessibilityRole="alert" style={styles.problem}>
                  {actionProblem}
                </Text>
              )}
              <Tap
                accessibilityRole="button"
                accessibilityLabel={`View history for ${name}`}
                style={styles.action}
                onPress={() =>
                  closeMenu(() =>
                    router.push({
                      pathname: "/exercise/[id]",
                      params: { id: entry.entry.content.exerciseId, activeEntryId: entry.entry.id },
                    }),
                  )
                }
              >
                <Text style={styles.actionLabel}>View history</Text>
              </Tap>
              <Tap
                accessibilityRole="button"
                accessibilityLabel={`Rest timer for ${name}, ${restSeconds > 0 ? clock(restSeconds) : "off"}`}
                style={styles.action}
                onPress={() => closeMenu(onRest)}
              >
                <Text style={styles.actionLabel}>
                  {`Rest timer · ${restSeconds > 0 ? clock(restSeconds) : "off"}`}
                </Text>
              </Tap>
              <ExerciseMoveButtons
                name={name}
                index={index}
                count={count}
                scroll={sheetScroll}
                buttonStyle={styles.action}
                textStyle={styles.actionLabel}
                onMove={(direction) => {
                  onInteract();
                  return onMove(direction);
                }}
              />
              <ExerciseNotes
                entry={entry.entry}
                expanded
                editor={{ draft: noteDraft, setDraft: setNoteDraft }}
                onInteract={onInteract}
              />
              <DestructiveButton
                label="Remove exercise"
                message={`${name} and its sets will be removed from this workout.`}
                keep="Keep it"
                busyLabel="Removing…"
                onAsk={() => {
                  // The exercise as it is when the sheet opens: a change made to it meanwhile
                  // refuses the removal.
                  removal.current = exerciseRemovalSnapshot(store, entry.entry.id);
                }}
                capture
                onConfirm={() => {
                  if (removal.current) onRemove(removal.current);
                }}
              />
            </View>
          </BottomSheet>
        )}
        <ExerciseNotes entry={entry.entry} expanded={expanded} onInteract={onInteract} />
        {expanded && (
          <View style={styles.sets}>
            <View style={styles.headRow}>
              <Text style={[styles.headCell, styles.setCol, styles.center]}>SET</Text>
              <Text style={[styles.headCell, styles.prevCol]}>PREVIOUS</Text>
              {metrics.map((m) =>
                m === "distance" ? (
                  <Tap
                    key={m}
                    style={[valueWidth(metrics, m, showRir), styles.unitButton]}
                    accessibilityRole="button"
                    accessibilityLabel={`Distance in ${distanceSuffix(distanceUnit)}. Switch to ${distanceSuffix(otherDistanceUnit)}`}
                    onPress={() => {
                      onInteract();
                      if (invalidDistance) {
                        setShowDistanceError(true);
                        return;
                      }
                      setShowDistanceError(false);
                      onChooseDistanceUnit(otherDistanceUnit);
                    }}
                  >
                    <Text style={[styles.headCell, styles.center]}>
                      {HEADINGS[m](unit, distanceUnit)} ⇄
                    </Text>
                  </Tap>
                ) : (
                  <Text
                    key={m}
                    style={[styles.headCell, styles.center, valueWidth(metrics, m, showRir)]}
                  >
                    {HEADINGS[m](unit, distanceUnit)}
                  </Text>
                ),
              )}
              {showRir && (
                <Text
                  aria-label={
                    labelLegacyEffort ? "Effort" : effortScale === "rir" ? "Reps in reserve" : "RPE"
                  }
                  style={[styles.headCell, styles.center, styles.rirCol]}
                >
                  {labelLegacyEffort ? "Effort" : effortLabel(effortScale)}
                </Text>
              )}
              <Text style={[styles.headCell, styles.center, styles.doneCol]}>DONE</Text>
            </View>
            {showDistanceError && invalidDistance && (
              <Text accessibilityRole="alert" style={styles.fieldError}>
                Finish entering the distance before switching units.
              </Text>
            )}
            {entry.sets.map((set, i) =>
              set.needsSyncReview ? (
                <SetSyncReview
                  key={set.id}
                  id={set.id}
                  entryId={entry.entry.id}
                  workoutId={workoutId}
                  label={labelOf(entry, i)}
                  onResolved={() => onSyncResolved(set)}
                />
              ) : (
                <SetRow
                  key={set.id}
                  rowRef={(node) => rowRef(set.id, node)}
                  controlRef={(node) => controlRef(set.id, node)}
                  set={set}
                  label={labelOf(entry, i)}
                  number={numbers[i] ?? 0}
                  isCurrent={set.id === currentSetId}
                  metrics={metrics}
                  unit={unit}
                  distanceUnit={distanceUnit}
                  plan={plan}
                  effortScale={setEffortScale(set.content, plan?.effortScale)}
                  labelLegacyEffort={labelLegacyEffort}
                  showTargets={showTargets}
                  ready={ready}
                  running={readSetStopwatch(store, workoutId, set.id)?.startedAt}
                  editing={editing?.setId === set.id ? editing : null}
                  problem={fieldProblem?.setId === set.id ? fieldProblem.message : null}
                  views={metrics.map((m) => viewOf(set, i, m))}
                  previous={previousLine(i)}
                  showRir={showRir}
                  canStoreRir={canStoreRir(set)}
                  rirOpen={rirRowId === set.id}
                  rirTyped={rirTyping?.setId === set.id ? rirTyping : null}
                  rirPicks={rirRowId === set.id ? rirPicks(set) : null}
                  editorOpen={editorSetId === set.id}
                  swiped={swipedId === set.id}
                  canSwipe={canSwipe}
                  onSwipe={(open) => onSwipe(set, open)}
                  onRemove={() => onRemoveSet(set)}
                  onPick={() => onPick(set)}
                  onCell={(metric) => onCell(set, metric)}
                  onRirCell={() => onRirCell(set)}
                  onLog={() => onLog(set, i)}
                  onUnlog={() => onUnlog(set)}
                  onEdit={() => onEditSet(set)}
                  onTimer={() => {
                    if (!onGate()) onTimer(set);
                  }}
                />
              ),
            )}
            {legacyRoutine && <Text style={styles.target}>Original routine targets unknown</Text>}
          </View>
        )}
        {/* The full-width footer moves down as a new row appears. */}
        {expanded && (
          <Animated.View layout={layout}>
            <Tap
              accessibilityRole="button"
              onPress={() => interact(onAddSet)}
              style={styles.addSet}
            >
              <PlusIcon color={c.fg2} size={15} />
              <Text style={styles.addSetLabel}>Add set</Text>
            </Tap>
          </Animated.View>
        )}
      </StillOnOpen>
    </Enter>
  );
}

/**
 * How wide a value column is: weights a little wider than reps, one field wider still, and all a
 * little narrower to make room for reps in reserve.
 */
function valueWidth(metrics: readonly SetMetric[], metric: SetMetric, rir = false) {
  if (metrics.length === 1) return { width: 124 };
  if (rir) return { width: metric === "reps" ? 44 : 58 };
  if (metric === "reps") return { width: 50 };
  return { width: metric === "weight" ? 72 : 64 };
}

function SetRow({
  rowRef,
  controlRef,
  set,
  label,
  number,
  isCurrent,
  metrics,
  unit,
  distanceUnit,
  plan,
  effortScale,
  labelLegacyEffort,
  showTargets,
  ready,
  running,
  editing,
  problem,
  views,
  previous,
  showRir,
  canStoreRir,
  rirOpen,
  rirTyped,
  rirPicks,
  editorOpen,
  swiped,
  canSwipe,
  onSwipe,
  onRemove,
  onPick,
  onCell,
  onRirCell,
  onLog,
  onUnlog,
  onEdit,
  onTimer,
}: {
  rowRef: (node: ComponentRef<typeof View> | null) => void;
  /** The set's own control, its number. */
  controlRef: (node: ComponentRef<typeof View> | null) => void;
  set: LiveSet;
  label: string;
  number: number;
  isCurrent: boolean;
  metrics: readonly SetMetric[];
  unit: Unit;
  distanceUnit: SetDistanceUnit;
  plan: WorkoutPlan | null;
  effortScale: EffortScale;
  labelLegacyEffort: boolean;
  showTargets: boolean;
  ready: boolean;
  /** When the set's stopwatch started, while it runs. */
  running: number | undefined;
  editing: Editing | null;
  problem: string | null;
  views: FieldView[];
  previous: string;
  showRir: boolean;
  canStoreRir: boolean;
  /** Whether the reps in reserve strip is open under this row. */
  rirOpen: boolean;
  /** Reps in reserve being typed on the pad for this set. */
  rirTyped: RirTyping | null;
  rirPicks: ReactNode;
  /** Whether the dock is editing this set. */
  editorOpen: boolean;
  swiped: boolean;
  canSwipe: boolean;
  onSwipe: (open: boolean) => void;
  onRemove: () => void;
  onPick: () => void;
  onCell: (metric: SetMetric) => void;
  onRirCell: () => void;
  onLog: () => void;
  onUnlog: () => void;
  onEdit: () => void;
  onTimer: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const isDone = set.content.completedAt !== null;
  // Paint the check on contact. Only a completed tap can log a set or start its rest.
  const [checking, setChecking] = useState(false);
  const showCheck = isDone || checking;
  // On the web the tap arrives as a click after the finger lifts. Keep the check painted until
  // then, so it doesn't vanish before the set is logged. A tap that never completes clears it.
  const releasing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopReleasing = () => {
    if (releasing.current !== null) clearTimeout(releasing.current);
    releasing.current = null;
  };
  useEffect(
    () => () => {
      if (releasing.current !== null) clearTimeout(releasing.current);
    },
    [],
  );
  const timing = running !== undefined;
  const target = showTargets ? routineTarget(plan, set.content) : undefined;
  const highlighted = isCurrent || editing !== null || editorOpen || rirOpen;
  const reserve = effortValue(set.content, effortScale);
  const effortTarget = effortCaption(target, plan?.effortScale);
  const effortName = effortScale === "rir" ? "reps in reserve" : "RPE";
  // While it is typed on the pad, the cell shows what is typed; it is recorded on Done.
  const rirShown = rirTyped ? rirTyped.text || null : reserve == null ? null : String(reserve);
  const displayedEffort =
    labelLegacyEffort && rirShown !== null ? `${effortLabel(effortScale)} ${rirShown}` : rirShown;
  const otherLegacyEffort =
    labelLegacyEffort && effortScale === "rir" && set.content.rpe != null
      ? `RPE ${set.content.rpe}`
      : null;
  const effortDetails = `${displayedEffort ?? "Empty"}${otherLegacyEffort === null ? "" : `, ${otherLegacyEffort}`}${effortTarget === null ? "" : `. Target ${effortTarget}`}`;
  const effortStyle =
    displayedEffort === null
      ? styles.rirEmpty
      : labelLegacyEffort
        ? styles.legacyEffortValue
        : [styles.value, styles.rirValue];
  // Every part of the row offers Remove set to a screen reader, wherever its focus is.
  const removable = {
    accessibilityActions: REMOVE_ACTIONS,
    onAccessibilityAction: ({ nativeEvent }: { nativeEvent: { actionName: string } }) => {
      if (nativeEvent.actionName === "remove") onRemove();
    },
  };
  return (
    <>
      <Enter>
        <SwipeRow open={swiped} enabled={canSwipe} onOpen={onSwipe} onRemove={onRemove}>
          <Pressable
            ref={rowRef}
            accessible={false}
            onPress={onPick}
            style={[
              styles.row,
              highlighted && styles.rowCurrent,
              (editorOpen || rirOpen) && styles.rowEditing,
              rirOpen && styles.rowOpen,
            ]}
          >
            {highlighted && !editorOpen && !rirOpen && <View style={styles.rowMark} />}
            <View style={[styles.setCol, styles.center]}>
              <Tap
                ref={controlRef}
                accessibilityRole="button"
                accessibilityLabel={`Edit set ${label}`}
                accessibilityHint="Its type, or remove it"
                accessibilityState={{ expanded: editorOpen }}
                hitSlop={9}
                onPress={onEdit}
                {...removable}
              >
                <SetChip type={set.content.type} number={number} highlighted={highlighted} />
              </Tap>
            </View>
            <Text style={[styles.prev, styles.prevCol]} numberOfLines={1}>
              {previous}
            </Text>
            {metrics.map((metric, i) => {
              const view = views[i];
              if (!view) return null;
              const on = editing?.metric === metric;
              const caption = targetCaption(target, metric, unit, distanceUnit);
              return (
                <Tap
                  key={metric}
                  accessibilityRole="button"
                  accessibilityLabel={`${HEADINGS[metric](unit, distanceUnit).toLowerCase()} for set ${label}`}
                  accessibilityHint={
                    [view.firm ? null : "Suggested", caption && `Target ${caption}`]
                      .filter(Boolean)
                      .join(". ") || undefined
                  }
                  accessibilityState={{ selected: on }}
                  onPress={() => onCell(metric)}
                  scaleTo={0.97}
                  style={[styles.cell, valueWidth(metrics, metric, showRir), on && styles.cellOn]}
                  {...removable}
                >
                  <View style={styles.cellValue}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.value,
                        view.firm && !view.missing && styles.valueFirm,
                        isDone && styles.valueFirm,
                        view.missing && styles.missing,
                        on && editing.fresh && !view.firm && styles.valueHint,
                      ]}
                    >
                      {view.text}
                    </Text>
                    {on && !editing.fresh && <View style={styles.caret} />}
                  </View>
                  {caption && (
                    <Text numberOfLines={1} style={styles.cellTarget}>
                      {caption}
                    </Text>
                  )}
                  {!on && !isDone && (
                    <View style={[styles.cellRule, caption && styles.cellRuleWithTarget]} />
                  )}
                </Tap>
              );
            })}
            {showRir &&
              (canStoreRir ? (
                <Tap
                  accessibilityRole="button"
                  accessibilityLabel={`${effortName} for set ${label}`}
                  accessibilityHint={effortDetails}
                  accessibilityState={{ expanded: rirOpen }}
                  onPress={onRirCell}
                  scaleTo={0.97}
                  style={[styles.cell, styles.rirCol, (rirOpen || rirTyped) && styles.cellOn]}
                  {...removable}
                >
                  <View style={styles.cellValue}>
                    <Text numberOfLines={1} style={effortStyle}>
                      {displayedEffort ?? "–"}
                    </Text>
                    {rirTyped && !rirTyped.fresh && <View style={styles.caret} />}
                  </View>
                  {otherLegacyEffort && (
                    <Text style={styles.legacyEffortValue}>{otherLegacyEffort}</Text>
                  )}
                  {effortTarget !== null && <Text style={styles.cellTarget}>{effortTarget}</Text>}
                </Tap>
              ) : (
                <View
                  accessible
                  accessibilityLabel={`${effortName} for set ${label}, ${effortDetails}`}
                  style={[styles.cell, styles.rirCol]}
                >
                  <Text numberOfLines={1} style={effortStyle}>
                    {displayedEffort ?? "–"}
                  </Text>
                  {otherLegacyEffort && (
                    <Text style={styles.legacyEffortValue}>{otherLegacyEffort}</Text>
                  )}
                  {effortTarget !== null && <Text style={styles.cellTarget}>{effortTarget}</Text>}
                </View>
              ))}
            <View style={[styles.doneCol, styles.center]}>
              <Tap
                accessibilityRole="checkbox"
                accessibilityLabel={isDone ? `Undo logged set ${label}` : `Log set ${label}`}
                accessibilityState={{ checked: isDone, disabled: !isDone && (!ready || timing) }}
                disabled={!isDone && (!ready || timing)}
                onPressIn={() => {
                  stopReleasing();
                  setChecking(!isDone && !swiped);
                }}
                onPressOut={() => {
                  stopReleasing();
                  if (Platform.OS !== "web") setChecking(false);
                  else
                    releasing.current = setTimeout(() => {
                      releasing.current = null;
                      setChecking(false);
                    }, CLICK_AFTER_RELEASE_MS);
                }}
                onPress={() => {
                  stopReleasing();
                  setChecking(false);
                  if (isDone) onUnlog();
                  else onLog();
                }}
                style={styles.checkHit}
                {...removable}
              >
                <View
                  style={[
                    styles.checkBox,
                    isCurrent && styles.checkCurrent,
                    showCheck && styles.checked,
                  ]}
                >
                  {showCheck && <CheckIcon color={c.bg} size={18} strokeWidth={2.6} />}
                </View>
              </Tap>
            </View>
          </Pressable>
        </SwipeRow>
      </Enter>
      {rirOpen && rirPicks && <View style={styles.rirStrip}>{rirPicks}</View>}
      {!isDone && metrics.includes("duration") && (
        <SetStopwatch startedAt={running} onPress={onTimer} />
      )}
      {!isDone && problem && (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {problem}
        </Text>
      )}
    </>
  );
}

function SetStopwatch({ startedAt, onPress }: { startedAt?: number; onPress: () => void }) {
  const styles = useStyles(sheet);
  const running = startedAt !== undefined;
  const now = useTicker(running);
  return (
    <View style={[styles.stopwatch, running && styles.stopwatchRunning]}>
      <Text style={styles.stopwatchLabel}>
        {running ? clock((now - startedAt) / 1000) : "Set timer"}
      </Text>
      <Tap accessibilityRole="button" onPress={onPress} style={styles.stopwatchButton}>
        <Text style={styles.stopwatchAction}>{running ? "Stop timer" : "Start timer"}</Text>
      </Tap>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  // Behind the sheet: the screen it rose over, dimmed.
  ground: { flex: 1, backgroundColor: c.scrim },
  screen: {
    flex: 1,
    backgroundColor: c.bg,
    borderTopLeftRadius: radius.hero,
    borderTopRightRadius: radius.hero,
    paddingTop: sheetBorderWidth,
    paddingHorizontal: sheetBorderWidth,
    overflow: "hidden",
  },
  header: { backgroundColor: c.bg, paddingBottom: 10 },
  grab: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: c.line2,
    alignSelf: "center",
    marginTop: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 10,
  },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  titleButton: {
    flex: 1,
    minHeight: 44,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { ...type.cardTitle, color: c.fg, textAlign: "center" },
  reviewLabel: { ...type.meta, color: c.alert, marginTop: 5 },
  subline: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.commit },
  sublineText: { ...type.meta, color: c.fg2, flexShrink: 1 },
  finish: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: c.line2,
    backgroundColor: c.s1,
    alignItems: "center",
    justifyContent: "center",
  },
  finishLabel: { ...type.action, color: c.fg },
  segments: { flexDirection: "row", gap: 3, marginHorizontal: 16, alignItems: "center" },
  segmentHit: { flex: 1, height: 24, justifyContent: "center" },
  segment: { height: 5, borderRadius: 3, backgroundColor: c.s3, overflow: "hidden" },
  segmentCurrent: { height: 11, borderRadius: 4, borderWidth: 1.5, borderColor: c.fg2 },
  segmentFill: { height: "100%", backgroundColor: c.fg },
  scrollContent: { paddingBottom: space.xl },
  body: { paddingHorizontal: 12, paddingTop: 4, gap: 12 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 8 },
  empty: { flex: 1, backgroundColor: c.bg, padding: space.xl, gap: space.lg },
  emptyCard: {
    backgroundColor: c.s1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: c.line,
    padding: space.lg,
    gap: space.xs,
  },
  emptyTitle: { ...type.rowTitle, color: c.fg },
  emptyText: { ...type.body, color: c.fg2 },
  fieldError: { ...font.bodySemi, fontSize: 14, color: c.alert, paddingHorizontal: 8 },
  problem: {
    ...font.bodySemi,
    fontSize: 14,
    color: c.alert,
    backgroundColor: c.s1,
    borderRadius: radius.input,
    padding: space.md,
  },
  partner: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space.xs,
    paddingHorizontal: 4,
  },
  partnerLabel: { flexShrink: 1, ...font.bodySemi, fontSize: 15, color: c.fg },
  card: {
    backgroundColor: c.s1,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: c.line,
    overflow: "hidden",
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 10,
    paddingBottom: 4,
    paddingLeft: 16,
    paddingRight: 10,
  },
  cardIndex: { ...font.mono, fontSize: 12, color: c.fg3, width: 18 },
  cardIndexDone: { color: c.fg },
  cardTitle: { flex: 1, minWidth: 0, minHeight: 48, justifyContent: "center" },
  exercise: { ...type.cardTitle, color: c.fg },
  exerciseLine: { ...type.label, color: c.fg3, marginTop: 5 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: c.line2,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chipText: { ...font.mono, fontSize: 12, color: c.fg2 },
  chipIcon: {
    width: 44,
    minHeight: 44,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: {
    gap: space.xs,
    paddingHorizontal: 16,
  },
  action: { minHeight: 44, justifyContent: "center" },
  actionLabel: { ...font.bodySemi, color: c.fg },
  sets: { paddingHorizontal: 8 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28 },
  headCell: { ...type.labelSmall, color: c.fg3 },
  center: { textAlign: "center", alignItems: "center" },
  unitButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  setCol: { width: 44, paddingLeft: 6 },
  prevCol: { flex: 1, minWidth: 0 },
  doneCol: { width: 46 },
  // Every row has the same size, current or not, so the list doesn't jump when the dock moves on.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 52,
    borderRadius: 14,
  },
  rowCurrent: { backgroundColor: c.s2 },
  // Being edited in the dock, or with reps in reserve open under it: lifted, without the mark.
  rowEditing: { backgroundColor: c.s2 },
  rowOpen: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  rirCol: { width: 44 },
  rirValue: { ...numeral(21, "300"), color: c.fg },
  legacyEffortValue: { ...font.mono, fontSize: 9, lineHeight: 12, color: c.fg },
  rirEmpty: { ...font.mono, fontSize: 15, color: c.fg3 },
  rirStrip: {
    backgroundColor: c.s2,
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 10,
    marginBottom: 4,
  },
  rowMark: {
    position: "absolute",
    left: 0,
    top: 11,
    bottom: 11,
    width: 3,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: c.fg,
  },
  prev: { ...font.mono, fontSize: 12, color: c.fg3 },
  cell: {
    height: 44,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  cellValue: { flexDirection: "row", alignItems: "center", maxWidth: "100%" },
  cellTarget: { ...font.mono, fontSize: 10, lineHeight: 12, color: c.fg2 },
  cellOn: { backgroundColor: c.bg, borderWidth: 1.5, borderColor: c.fg },
  cellRule: {
    position: "absolute",
    left: 13,
    right: 13,
    bottom: 5,
    borderBottomWidth: 1,
    borderStyle: "dashed",
    borderColor: c.line2,
  },
  cellRuleWithTarget: { bottom: 16 },
  value: { ...numeral(24, "300"), color: c.fg3 },
  valueFirm: { color: c.fg },
  valueHint: { color: c.fg2 },
  missing: { ...font.bodySemi, fontSize: 12, color: c.alert, textDecorationLine: "underline" },
  caret: { width: 2, height: 24, marginLeft: 2, backgroundColor: c.fg },
  checkHit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  checkBox: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: c.line2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkCurrent: { borderColor: c.fg },
  checked: { borderColor: c.fg, backgroundColor: c.fg },
  target: { ...type.meta, color: c.fg2, textAlign: "center", marginVertical: space.xs },
  rangeResult: {
    ...type.meta,
    color: c.fg2,
    marginHorizontal: 10,
    marginBottom: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    backgroundColor: c.s2,
    borderRadius: radius.chip,
  },
  addSet: {
    marginTop: 4,
    minHeight: 46,
    borderTopWidth: 1,
    borderTopColor: c.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  addSetLabel: { ...type.action, color: c.fg2 },
  secondary: {
    minHeight: 52,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: c.line2,
    backgroundColor: c.s1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  secondaryLabel: { ...type.action, color: c.fg },
  primary: {
    minHeight: 52,
    borderRadius: radius.card,
    backgroundColor: c.commit,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { ...type.commit, color: c.commitInk },
  stopwatch: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginVertical: space.xs,
    paddingLeft: space.md,
    backgroundColor: c.bg,
    borderRadius: radius.input,
  },
  stopwatchRunning: { backgroundColor: c.s3 },
  stopwatchLabel: { ...numeral(17, "400"), color: c.fg },
  stopwatchButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.lg },
  stopwatchAction: { ...type.action, color: c.fg },
  dock: {
    paddingTop: 10,
    paddingHorizontal: gutter.group,
    backgroundColor: c.bg,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  clipDock: { overflow: "hidden" },
  dockTimer: { zIndex: 1 },
  restAboveEditor: { marginBottom: space.sm },
  // The question about reps in reserve without a rest timer, with a hairline under it.
  ask: {
    paddingBottom: 12,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
  dockProblem: {
    ...font.bodySemi,
    fontSize: 13,
    color: c.alert,
    paddingHorizontal: 4,
    paddingTop: 8,
  },
  dockDone: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 6,
    paddingBottom: 10,
  },
  dockDoneCount: { ...numeral(38), color: c.fg },
  dockDoneText: { ...type.value, color: c.fg2, paddingBottom: 4 },
  dockAdd: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: c.fg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  dockAddLabel: { ...type.commit, color: c.bg },
  dockAddDetail: { ...type.meta, color: c.bg, opacity: 0.7 },
}));
