import {
  EFFORT_SCALES,
  type EffortScale,
  isRepBased,
  LIMITS,
  type SetMetric,
  type SetType,
} from "@leve/core";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { newId } from "../data/ids.ts";
import { changePlanEffort, type PlannedExercise } from "../data/routine-actions.ts";
import { parseRestSeconds } from "../data/settings-actions.ts";
import { effortLabel, effortValue } from "../model/effort.ts";
import { dropPlace, moveBlock, orderBlocks, shiftExercise } from "../model/plan-order.ts";
import { leaveSuperset, pairWithPrevious, supersetLabels } from "../model/supersets.ts";
import type { Settings } from "../model/types.ts";
import { font, numeral, radius, space, type } from "../theme.ts";
import { ActionSheet } from "./action-sheet.tsx";
import { Button } from "./buttons.tsx";
import { ChoiceRow, MenuRow } from "./choice-row.tsx";
import { Dialog } from "./dialog.tsx";
import { DragBlock } from "./drag-block.tsx";
import { ExerciseThumb } from "./exercise-image.tsx";
import { ExercisePicker } from "./exercise-picker.tsx";
import { TitleField } from "./field.tsx";
import { announce } from "./focus.ts";
import { haptic } from "./haptics.ts";
import { GripIcon, LinkIcon, PlusIcon, TimerIcon } from "./icons.tsx";
import { RestDialog } from "./live/rest-dialog.tsx";
import { ModeTile } from "./mode-tile.tsx";
import { MoreButton } from "./popover-menu.tsx";
import { SetMetricInput } from "./set-metric-input.tsx";
import { SetTypeChoices, setTypeNames } from "./set-type-choices.tsx";
import { inputValue, setColumns } from "./set-values.ts";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";
import { clock } from "./use-ticker.ts";

/** A row of the reorder list, in points: every row is one line, so every row is this tall. */
const ROW = 64;

const twoDigits = (n: number) => String(n).padStart(2, "0");
const restOf = (entry: PlannedExercise, settings: Settings) =>
  entry.restSecondsText !== undefined
    ? parseRestSeconds(entry.restSecondsText)
    : (entry.original?.restSeconds ?? settings.defaultRestSeconds);
const restText = (seconds: number | null) =>
  seconds === null ? "?" : seconds === 0 ? "Off" : clock(seconds);
const usesRange = (entry: PlannedExercise) =>
  entry.useRepRange ?? entry.original?.useRepRange ?? false;
const typeOf = (set: PlannedExercise["sets"][number]): SetType =>
  set.type ?? set.original?.type ?? "normal";

/** A column of a planned set that takes a typed target. */
type PlanField = SetMetric | "repRangeMin" | "repRangeMax" | "effort";

function toggleRepRange(entry: PlannedExercise): PlannedExercise {
  const useRepRange = !usesRange(entry);
  const from = useRepRange ? "reps" : "repRangeMin";
  const to = useRepRange ? "repRangeMin" : "reps";
  return {
    ...entry,
    useRepRange,
    sets: entry.sets.map((set) => {
      if (set.values[to] !== undefined || set.original?.[to] != null) return set;
      const value = set.values[from] ?? set.original?.[from];
      return value == null ? set : { ...set, values: { ...set.values, [to]: String(value) } };
    }),
  };
}

/** "5 exercises · 15 sets", for the Save routine button. */
export function planSummary(plan: readonly PlannedExercise[]): string {
  const sets = plan.reduce((sum, entry) => sum + entry.sets.length, 0);
  return `${plan.length} ${plan.length === 1 ? "exercise" : "exercises"} · ${sets} ${sets === 1 ? "set" : "sets"}`;
}

/** A routine's name typed onto the page, then a card with its folder, which opens a menu. */
export function RoutineDetailsFields({
  title,
  setTitle,
  folders,
  folderId,
  setFolderId,
  autoFocus = false,
}: {
  title: string;
  setTitle: (title: string) => void;
  folders: readonly { id: string; title: string }[];
  folderId: string | null;
  setFolderId: (id: string | null) => void;
  /** Focuses the name when the fields appear, so the keyboard opens to type it. */
  autoFocus?: boolean;
}) {
  const styles = useStyles(sheet);
  // A routine whose folder is gone is not in a folder, as Train shows it.
  const current = folders.find((folder) => folder.id === folderId);
  return (
    <>
      <TitleField
        label="Routine name"
        accessibilityLabel="Routine name"
        maxLength={LIMITS.titleLength}
        value={title}
        onChangeText={setTitle}
        autoFocus={autoFocus}
        style={styles.titleField}
      />
      <View style={styles.card}>
        <MenuRow
          label="Folder"
          value={current?.title ?? "Not in a folder"}
          menu={{
            title: "Folder",
            items: [
              { id: null, title: "Not in a folder" },
              ...folders.map((folder) => ({ id: folder.id, title: folder.title })),
            ].map((folder) => ({
              label: folder.title,
              checked: folder.id === (current?.id ?? null),
              // Choosing the folder it already shows in leaves it as it is: a routine whose folder
              // is gone stays filed as it was unless it is moved somewhere else.
              onPress: () => {
                if (folder.id !== (current?.id ?? null)) setFolderId(folder.id);
              },
            })),
          }}
        />
      </View>
    </>
  );
}

/**
 * The header's Reorder tile: folds the exercises into one-line rows to drag; Done (bone) unfolds
 * them where they now are.
 */
export function ReorderTile({
  reordering,
  onToggle,
  disabled = false,
}: {
  reordering: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <ModeTile
      on={reordering}
      label="Reorder"
      accessibilityLabel="Reorder exercises"
      doneAccessibilityLabel="Done reordering"
      icon={(color) => <GripIcon color={color} size={16} />}
      onToggle={onToggle}
      disabled={disabled}
    />
  );
}

/**
 * A routine's exercises, planned the way they are logged: each a block with its rest and a ⋯ menu,
 * then its sets as rows with targets to type. In reorder mode they fold into one-line rows that are
 * dragged by their grips, superset partners together.
 */
export function RoutinePlanEditor({
  plan,
  setPlan,
  effortScale,
  setEffortScale,
  settings,
  reordering,
  onReorder,
  onReorderDragChange,
}: {
  plan: PlannedExercise[];
  setPlan: Dispatch<SetStateAction<PlannedExercise[]>>;
  effortScale: EffortScale;
  setEffortScale: (scale: EffortScale) => void;
  settings: Settings;
  reordering: boolean;
  onReorder: () => void;
  onReorderDragChange: (held: boolean) => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const groups = supersetLabels(plan.map((entry) => entry.supersetId));
  const [picking, setPicking] = useState(false);
  const [pendingScale, setPendingScale] = useState<EffortScale | null>(null);
  const [effortError, setEffortError] = useState("");
  const switchScale = (next: EffortScale, confirmed = false) => {
    try {
      const converted = changePlanEffort(plan, effortScale, next);
      if (converted.cleared && !confirmed) {
        setPendingScale(next);
        return;
      }
      setPlan(converted.next);
      setEffortScale(next);
      setPendingScale(null);
      setEffortError("");
    } catch (problem) {
      setEffortError((problem as Error).message);
    }
  };
  const edit = (id: string, fn: (entry: PlannedExercise) => PlannedExercise) =>
    setPlan((entries) => entries.map((entry) => (entry.id === id ? fn(entry) : entry)));

  if (reordering)
    return (
      <ReorderList
        plan={plan}
        setPlan={setPlan}
        settings={settings}
        groups={groups}
        onDragChange={onReorderDragChange}
      />
    );

  return (
    <>
      <View style={styles.card}>
        <ChoiceRow
          label="Effort scale"
          hint="Applies to new workouts from this routine"
          choices={EFFORT_SCALES.map((value) => ({ value, label: effortLabel(value) }))}
          value={effortScale}
          onChoose={switchScale}
        />
        {effortError && (
          <Text accessibilityRole="alert" style={styles.effortHelp}>
            {effortError}
          </Text>
        )}
      </View>
      {pendingScale && (
        <Dialog
          eyebrow={`Switch to ${effortLabel(pendingScale)}`}
          onClose={() => setPendingScale(null)}
          confirm={{ label: "Switch scale", onPress: () => switchScale(pendingScale, true) }}
        >
          <Text style={styles.effortHelp}>
            Some effort targets have no exact equivalent. Switching clears those targets from this
            routine draft.
          </Text>
        </Dialog>
      )}
      {plan.map((entry, index) => (
        <ExerciseBlock
          key={entry.id}
          entry={entry}
          index={index}
          count={plan.length}
          group={groups[index]}
          partner={partnerOf(plan, groups, index)}
          previous={plan[index - 1]}
          settings={settings}
          effortScale={effortScale}
          edit={(fn) => edit(entry.id, fn)}
          onPair={(previousId) =>
            setPlan((entries) => pairWithPrevious(entries, previousId, entry.id))
          }
          onLeave={() => setPlan((entries) => leaveSuperset(entries, entry.id))}
          onRemove={() =>
            setPlan((entries) => leaveSuperset(entries, entry.id).filter((e) => e.id !== entry.id))
          }
          onReorder={onReorder}
        />
      ))}
      {plan.length < LIMITS.routineMaxExercises && (
        <Button
          label="Add exercise"
          icon={<PlusIcon color={c.fg} size={16} strokeWidth={2} />}
          onPress={() => setPicking(true)}
          style={styles.addExercise}
        />
      )}
      {picking && (
        <ExercisePicker
          included={plan.map((entry) => entry.exercise.id)}
          onClose={() => setPicking(false)}
          selectionLimit={LIMITS.routineMaxExercises - plan.length}
          onPickMany={(selected) => {
            const added = selected.map((exercise) => ({
              id: newId(),
              exercise,
              sets: [{ id: newId(), values: {} }],
            }));
            setPlan((entries) => [...entries, ...added]);
            setPicking(false);
          }}
        />
      )}
    </>
  );
}

/** The other exercises in this one's superset, by name. */
function partnerOf(
  plan: readonly PlannedExercise[],
  groups: readonly (string | undefined)[],
  index: number,
): string | undefined {
  const group = groups[index];
  if (!group) return undefined;
  const names = plan
    .filter((_, i) => i !== index && groups[i] === group)
    .map((entry) => entry.exercise.name);
  return names.join(", ") || undefined;
}

function ExerciseBlock({
  entry,
  index,
  count,
  group,
  partner,
  previous,
  settings,
  effortScale,
  edit,
  onPair,
  onLeave,
  onRemove,
  onReorder,
}: {
  entry: PlannedExercise;
  index: number;
  count: number;
  group: string | undefined;
  partner: string | undefined;
  previous: PlannedExercise | undefined;
  settings: Settings;
  effortScale: EffortScale;
  edit: (fn: (entry: PlannedExercise) => PlannedExercise) => void;
  onPair: (previousId: string) => void;
  onLeave: () => void;
  onRemove: () => void;
  onReorder: () => void;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const name = entry.exercise.name;
  const repBased = isRepBased(entry.exercise.type);
  const useRepRange = usesRange(entry);
  const rest = restOf(entry, settings);
  const [settingRest, setSettingRest] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [typing, setTyping] = useState<string | null>(null);
  const distanceUnit =
    entry.exercise.type === "distance_duration"
      ? settings.distanceUnit
      : settings.shortDistanceUnit;
  const columns = setColumns(entry.exercise.type, settings.weightUnit);
  const setCount = `${entry.sets.length} ${entry.sets.length === 1 ? "set" : "sets"}`;
  let number = 0;
  const numbers = entry.sets.map((set) => {
    const type = typeOf(set);
    if (type === "normal" || type === "failure") number += 1;
    return number;
  });
  const stored = (
    set: PlannedExercise["sets"][number],
    metric: SetMetric,
    field: SetMetric | "repRangeMin" | "repRangeMax",
  ) =>
    set.values[field] ??
    (set.original
      ? field === "repRangeMin" || field === "repRangeMax"
        ? String(set.original[field] ?? "")
        : inputValue(set.original, metric, settings.weightUnit, distanceUnit)
      : "");
  const shown = (set: PlannedExercise["sets"][number], field: PlanField) =>
    field === "effort"
      ? (set.effortText ?? String(effortValue(set.original, effortScale) ?? ""))
      : stored(set, field === "repRangeMin" || field === "repRangeMax" ? "reps" : field, field);
  // While one cell is typed in, the other sets of its kind (warm-up or not) that were blank in
  // that column when typing started take the same value, so a target is entered once.
  const filling = useRef<{ cell: string; typed: string; sets: string[] } | null>(null);
  const setValue = (setId: string, field: PlanField, value: string) => {
    const cell = `${setId} ${field}`;
    if (filling.current?.cell !== cell) {
      const source = entry.sets.find((s) => s.id === setId);
      const warmup = source !== undefined && typeOf(source) === "warmup";
      filling.current = {
        cell,
        typed: setId,
        sets: entry.sets
          .filter(
            (s) => s.id !== setId && (typeOf(s) === "warmup") === warmup && shown(s, field) === "",
          )
          .map((s) => s.id),
      };
    }
    const followers = new Set(filling.current.sets);
    edit((e) => {
      // A set whose kind changed while the keyboard stayed up stops following.
      const source = e.sets.find((s) => s.id === setId);
      const warmup = source !== undefined && typeOf(source) === "warmup";
      return {
        ...e,
        sets: e.sets.map((s) =>
          s.id !== setId && !(followers.has(s.id) && (typeOf(s) === "warmup") === warmup)
            ? s
            : field === "effort"
              ? { ...s, effortText: value }
              : { ...s, values: { ...s.values, [field]: value } },
        ),
      };
    });
  };
  const doneTyping = () => {
    filling.current = null;
  };
  // An added set starts from the targets and type of the last working set, never a warm-up's.
  const nextSet = (): PlannedExercise["sets"][number] => {
    const source = [...entry.sets].reverse().find((s) => typeOf(s) !== "warmup");
    const set: PlannedExercise["sets"][number] = { id: newId(), values: {} };
    if (!source) return set;
    // Added while its source's value is still being typed, it takes the rest of the typing too.
    const typing = filling.current;
    if (typing && (typing.typed === source.id || typing.sets.includes(source.id)))
      typing.sets.push(set.id);
    const fields: PlanField[] = columns.map(({ metric }) => metric);
    if (repBased) fields.push("repRangeMin", "repRangeMax", "effort");
    for (const field of fields) {
      const value = shown(source, field);
      if (!value) continue;
      if (field === "effort") set.effortText = value;
      else set.values[field] = value;
    }
    const type = typeOf(source);
    return type === "normal" ? set : { ...set, type };
  };

  return (
    <View style={styles.block}>
      {group ? <View style={styles.rail} /> : null}
      <View style={styles.head}>
        <ExerciseThumb
          exerciseId={entry.exercise.id}
          size={44}
          fallback={<Text style={styles.index}>{twoDigits(index + 1)}</Text>}
        />
        <View style={styles.names}>
          <Text accessibilityRole="header" style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {group ? (
            <View style={styles.metaRow}>
              <Text style={styles.tag}>{group}</Text>
              {partner ? (
                <Text style={styles.meta} numberOfLines={1}>
                  with {partner}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.meta} numberOfLines={1}>
              {setCount}
              {useRepRange && repBased ? " · rep range" : ""}
            </Text>
          )}
        </View>
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`${name} rest, ${restText(rest)}. Change it`}
          hitSlop={6}
          onPress={() => setSettingRest(true)}
          scaleTo={0.95}
          style={styles.chip}
        >
          <TimerIcon color={c.fg2} size={15} />
          <Text style={styles.chipText}>{restText(rest)}</Text>
        </Tap>
        <MoreButton
          small
          label={`${name} options`}
          title={name}
          meta={group ?? setCount}
          items={[
            ...(repBased
              ? [
                  {
                    label: "Rep range",
                    value: useRepRange ? "On" : "Off",
                    onPress: () => edit(toggleRepRange),
                  },
                ]
              : []),
            ...(group
              ? [{ label: "Leave superset", onPress: onLeave }]
              : previous
                ? [
                    {
                      label: `Superset with ${previous.exercise.name}`,
                      icon: (color: string) => <LinkIcon color={color} size={18} />,
                      onPress: () => onPair(previous.id),
                    },
                  ]
                : []),
            ...(count > 1
              ? [
                  {
                    label: "Reorder exercises",
                    icon: (color: string) => <GripIcon color={color} size={18} />,
                    onPress: onReorder,
                  },
                ]
              : []),
            { label: "Remove from routine", destructive: true, onPress: () => setRemoving(true) },
          ]}
        />
      </View>

      <View style={styles.sets}>
        <View
          style={[styles.setRow, styles.headRow]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={[styles.colHead, styles.chipCol]}>Set</Text>
          <View style={styles.flex} />
          {columns.map(({ metric, heading }) => (
            <Text
              key={metric}
              style={[
                styles.colHead,
                metric === "reps" && useRepRange ? styles.rangeCol : styles.valueCol,
              ]}
            >
              {metric === "distance" ? distanceUnit.toUpperCase() : heading}
            </Text>
          ))}
          {repBased ? (
            <Text style={[styles.colHead, styles.rpeCol]}>{effortLabel(effortScale)}</Text>
          ) : null}
        </View>
        {entry.sets.map((set, i) => {
          const type = typeOf(set);
          const expanded = typing === set.id;
          const chip = type === "normal" ? String(numbers[i]) : setTypeNames[type][0];
          return (
            <View key={set.id} style={[styles.setWrap, i > 0 && styles.setDivider]}>
              <View style={styles.setRow}>
                <View style={styles.chipCol}>
                  <Tap
                    accessibilityRole="button"
                    accessibilityLabel={`${name} set ${i + 1} type: ${setTypeNames[type]}`}
                    accessibilityState={{ expanded }}
                    hitSlop={9}
                    onPress={() => setTyping(expanded ? null : set.id)}
                    scaleTo={0.9}
                    style={[styles.setChip, type === "warmup" && styles.setChipWarmup]}
                  >
                    <Text style={[styles.setChipText, type === "warmup" && styles.setChipDim]}>
                      {chip}
                    </Text>
                  </Tap>
                </View>
                <Text style={styles.target} numberOfLines={1}>
                  {type === "warmup" ? "warm-up" : "target"}
                </Text>
                {columns.map(({ metric, heading }) => {
                  const label =
                    metric === "distance"
                      ? distanceUnit
                      : metric === "duration"
                        ? "Time (m:ss)"
                        : heading;
                  if (metric === "reps" && useRepRange)
                    return (
                      <View key={metric} style={[styles.rangeCol, styles.range]}>
                        <PlanCell
                          metric="reps"
                          narrow
                          label={`${name} set ${i + 1} Min reps`}
                          value={stored(set, metric, "repRangeMin")}
                          onChange={(value) => setValue(set.id, "repRangeMin", value)}
                          onFocusChange={doneTyping}
                        />
                        <Text style={styles.dash}>–</Text>
                        <PlanCell
                          metric="reps"
                          narrow
                          label={`${name} set ${i + 1} Max reps`}
                          value={stored(set, metric, "repRangeMax")}
                          onChange={(value) => setValue(set.id, "repRangeMax", value)}
                          onFocusChange={doneTyping}
                        />
                      </View>
                    );
                  return (
                    <View key={metric} style={styles.valueCol}>
                      <PlanCell
                        metric={metric}
                        label={`${name} set ${i + 1} ${label}`}
                        value={stored(set, metric, metric)}
                        onChange={(value) => setValue(set.id, metric, value)}
                        onFocusChange={doneTyping}
                      />
                    </View>
                  );
                })}
                {repBased ? (
                  <View style={styles.rpeCol}>
                    <TextInput
                      accessibilityLabel={`${name} set ${i + 1} target ${effortLabel(effortScale)}`}
                      inputMode={effortScale === "rir" ? "numeric" : "decimal"}
                      returnKeyType="done"
                      selectTextOnFocus
                      placeholder="—"
                      placeholderTextColor={c.fg3}
                      style={styles.rpe}
                      value={shown(set, "effort")}
                      onChangeText={(effortText) => setValue(set.id, "effort", effortText)}
                      onFocus={doneTyping}
                      onBlur={doneTyping}
                    />
                  </View>
                ) : null}
              </View>
              {expanded && (
                <View style={styles.typeChoices}>
                  <SetTypeChoices
                    value={type}
                    onChange={(next) => {
                      edit((current) => ({
                        ...current,
                        sets: current.sets.map((s) => (s.id === set.id ? { ...s, type: next } : s)),
                      }));
                      setTyping(null);
                    }}
                  />
                  {entry.sets.length > 1 && (
                    <Button
                      rank="destructive"
                      label="Remove set"
                      accessibilityLabel={`Remove set ${i + 1}`}
                      onPress={() => {
                        edit((e) => ({ ...e, sets: e.sets.filter((s) => s.id !== set.id) }));
                        setTyping(null);
                      }}
                    />
                  )}
                </View>
              )}
            </View>
          );
        })}
      </View>
      {entry.sets.length < LIMITS.routineMaxSets && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`Add set to ${name}`}
          onPress={() => {
            const set = nextSet();
            edit((e) => ({ ...e, sets: [...e.sets, set] }));
          }}
          scaleTo={0.98}
          style={styles.addSet}
        >
          <PlusIcon color={c.fg2} size={15} strokeWidth={2} />
          <Text style={styles.addSetText}>Add set</Text>
        </Tap>
      )}

      {settingRest && (
        <RestDialog
          title={name}
          note="After each set of this exercise"
          initialSeconds={rest ?? settings.defaultRestSeconds}
          onClose={() => setSettingRest(false)}
          onSet={(seconds) => {
            edit((e) => ({ ...e, restSecondsText: String(seconds) }));
            setSettingRest(false);
          }}
        />
      )}
      {removing && (
        <ActionSheet
          message={`${name} and its ${setCount} will be removed from this routine. Past workouts keep it.`}
          action="Remove exercise"
          keep="Keep it"
          onConfirm={() => {
            setRemoving(false);
            onRemove();
          }}
          onClose={() => setRemoving(false)}
        />
      )}
    </View>
  );
}

/** A planned value typed in place: a thin numeral over a dotted line, ringed while typing. */
function PlanCell({
  metric,
  label,
  value,
  onChange,
  onFocusChange,
  narrow = false,
}: {
  metric: SetMetric;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onFocusChange: () => void;
  narrow?: boolean;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <SetMetricInput
      metric={metric}
      accessibilityLabel={label}
      placeholder="—"
      placeholderTextColor={c.fg3}
      value={value}
      onChangeText={onChange}
      onFocus={() => {
        setFocused(true);
        onFocusChange();
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange();
      }}
      style={[styles.cell, narrow && styles.cellNarrow, focused && styles.cellOn]}
    />
  );
}

/** One line about a planned exercise: "3 × 6–8 · 80 kg · rest 1:30". */
function rowSummary(entry: PlannedExercise, settings: Settings, group: string | undefined) {
  const first = entry.sets.find((set) => typeOf(set) !== "warmup") ?? entry.sets[0];
  const parts = [`${entry.sets.length} ${entry.sets.length === 1 ? "set" : "sets"}`];
  if (first && isRepBased(entry.exercise.type)) {
    const reps = usesRange(entry)
      ? [
          first.values.repRangeMin ?? first.original?.repRangeMin,
          first.values.repRangeMax ?? first.original?.repRangeMax,
        ]
          .filter((value) => value !== undefined && value !== null && value !== "")
          .join("–")
      : String(first.values.reps ?? first.original?.reps ?? "");
    if (reps) parts[0] = `${entry.sets.length} × ${reps}`;
  }
  const rest = restOf(entry, settings);
  parts.push(group ? group.toLowerCase() : `rest ${restText(rest)}`);
  return parts.join(" · ");
}

/**
 * The exercises folded into one-line rows, each dragged by its grip; exercises in one superset move
 * as one. Screen readers move them with the rows' Move up and Move down actions instead.
 */
function ReorderList({
  plan,
  setPlan,
  settings,
  groups,
  onDragChange,
}: {
  plan: PlannedExercise[];
  setPlan: Dispatch<SetStateAction<PlannedExercise[]>>;
  settings: Settings;
  groups: readonly (string | undefined)[];
  onDragChange: (held: boolean) => void;
}) {
  const styles = useStyles(sheet);
  const blocks = orderBlocks(plan.map((entry) => entry.supersetId));
  const heights = blocks.map((block) => block.length * ROW);
  const [drag, setDrag] = useState<{ from: number; dy: number } | null>(null);
  useEffect(() => () => onDragChange(false), [onDragChange]);
  const place = drag ? dropPlace(heights, drag.from, drag.dy) : null;
  const topBlock = drag?.from === 0 && place !== 0 ? 1 : 0;
  const offset = (index: number) => {
    if (!drag || place === null) return 0;
    if (index === drag.from) return drag.dy;
    const moved = heights[drag.from] ?? 0;
    if (drag.from < place && index > drag.from && index <= place) return -moved;
    if (place < drag.from && index >= place && index < drag.from) return moved;
    return 0;
  };
  const endDrag = (from: number, dy?: number) => {
    onDragChange(false);
    setDrag(null);
    if (dy === undefined) return;
    const to = dropPlace(heights, from, dy);
    if (to === from) return;
    haptic.select();
    setPlan((entries) =>
      moveBlock(entries, orderBlocks(entries.map((entry) => entry.supersetId)), from, to),
    );
  };
  const shift = (entry: PlannedExercise, direction: -1 | 1) => {
    const next = shiftExercise(plan, entry.id, direction);
    setPlan(next);
    const at = next.findIndex((e) => e.id === entry.id);
    announce(`${entry.exercise.name} moved to position ${at + 1} of ${next.length}`);
  };
  return (
    <>
      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          <Text style={styles.bannerStrong}>Drag ⠿ to move an exercise.</Text> Sets, rest and
          supersets stay as they are. Done returns to editing; Save routine saves the new order with
          everything else.
        </Text>
      </View>
      <View style={styles.list}>
        {blocks.map((block, b) => (
          <DragBlock
            key={block.map((index) => plan[index]?.id).join("+")}
            lifted={drag?.from === b}
            offset={offset(b)}
            onGrab={() => onDragChange(true)}
            onMove={(dy) => setDrag({ from: b, dy })}
            onEnd={(dy) => endDrag(b, dy)}
          >
            {(grip) =>
              block.map((index) => {
                const entry = plan[index];
                if (!entry) return null;
                const group = groups[index];
                const divider = index !== block[0] || (b !== topBlock && b !== drag?.from);
                return (
                  <View
                    key={entry.id}
                    accessible
                    accessibilityLabel={`${entry.exercise.name}, ${index + 1} of ${plan.length}${group ? `, ${group}` : ""}`}
                    accessibilityHint="Drag the grip, or use the actions, to move it"
                    accessibilityActions={[
                      ...(b > 0 ? [{ name: "moveUp", label: "Move up" }] : []),
                      ...(b < blocks.length - 1 ? [{ name: "moveDown", label: "Move down" }] : []),
                    ]}
                    onAccessibilityAction={({ nativeEvent }) =>
                      shift(entry, nativeEvent.actionName === "moveUp" ? -1 : 1)
                    }
                    style={[
                      styles.reorderRow,
                      divider && styles.setDivider,
                      group && styles.reorderSuperset,
                    ]}
                  >
                    <ExerciseThumb
                      exerciseId={entry.exercise.id}
                      size={44}
                      fallback={<Text style={styles.index}>{twoDigits(index + 1)}</Text>}
                    />
                    <View style={styles.names}>
                      <Text style={styles.reorderName} numberOfLines={1}>
                        {entry.exercise.name}
                      </Text>
                      <Text style={styles.summary} numberOfLines={1}>
                        {rowSummary(entry, settings, group)}
                      </Text>
                    </View>
                    {grip(`Drag to reorder ${entry.exercise.name}`)}
                  </View>
                );
              })
            }
          </DragBlock>
        ))}
      </View>
    </>
  );
}

const sheet = themedStyles((c) => ({
  flex: { flex: 1 },
  titleField: { paddingHorizontal: 4 },
  card: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 54,
    paddingVertical: 9,
    paddingLeft: 16,
    paddingRight: 14,
  },
  detailLabel: { ...type.body, fontSize: 14.5, lineHeight: 19, color: c.fg },
  detailHint: { ...type.meta, fontSize: 10, lineHeight: 14, color: c.fg3, marginTop: 2 },
  detailValue: { ...type.value, fontSize: 12.5, color: c.fg2, maxWidth: 140 },
  sheetBody: { paddingHorizontal: 18, paddingTop: 4, gap: space.md },
  sheetNote: { ...type.caption, color: c.fg2 },
  cue: { gap: 2 },
  cueRemove: { alignSelf: "flex-start", paddingHorizontal: 2 },
  block: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  rail: {
    position: "absolute",
    left: 4,
    top: 14,
    bottom: 14,
    width: 3,
    borderRadius: 2,
    backgroundColor: c.fg3,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 14,
    paddingRight: 12,
    paddingBottom: 8,
    paddingLeft: 12,
  },
  index: { ...font.mono, fontSize: 12, color: c.fg3 },
  names: { flex: 1, minWidth: 0 },
  name: { ...font.bodyBold, fontSize: 17, lineHeight: 20, letterSpacing: -0.17, color: c.fg },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 },
  meta: { ...type.label, color: c.fg3, marginTop: 5, flexShrink: 1 },
  tag: {
    ...font.monoSemi,
    fontSize: 9,
    letterSpacing: 1.08,
    textTransform: "uppercase",
    color: c.fg2,
    borderWidth: 1,
    borderColor: c.line2,
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 6,
    overflow: "hidden",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 10,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: c.line2,
  },
  chipText: { ...font.mono, fontSize: 12, color: c.fg2 },
  sets: { paddingHorizontal: 8 },
  setWrap: {},
  setDivider: { borderTopWidth: 1, borderTopColor: c.line },
  setRow: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 50 },
  headRow: { minHeight: 0, paddingTop: 2, paddingBottom: 6 },
  colHead: { ...type.labelSmall, color: c.fg3, textAlign: "center" },
  chipCol: { width: 34, alignItems: "center" },
  valueCol: { width: 70 },
  rangeCol: { width: 86 },
  effortHelp: {
    ...type.caption,
    color: c.fg2,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  rpeCol: { width: 40, alignItems: "center" },
  range: { flexDirection: "row", alignItems: "center" },
  dash: { ...numeral(18), color: c.fg3, width: 8, textAlign: "center" },
  setChip: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: c.s2,
    alignItems: "center",
    justifyContent: "center",
  },
  setChipWarmup: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.line2,
  },
  setChipText: { ...font.monoSemi, fontSize: 12, color: c.fg2 },
  setChipDim: { fontSize: 10.5, color: c.fg3 },
  target: { ...font.mono, fontSize: 12, color: c.fg3, flex: 1, minWidth: 0 },
  cell: {
    ...numeral(22, "300"),
    height: 40,
    textAlign: "center",
    color: c.fg,
    borderRadius: 11,
    borderBottomWidth: 1,
    borderBottomColor: c.line2,
    borderStyle: "dashed",
    // Its own ring shows while typing; browsers would add a second one.
    outlineWidth: 0,
  },
  cellNarrow: { ...numeral(20, "300"), width: 39, borderRadius: 9 },
  cellOn: {
    backgroundColor: c.bg,
    borderWidth: 1.5,
    borderColor: c.fg,
    borderStyle: "solid",
  },
  rpe: {
    ...font.mono,
    fontSize: 11,
    color: c.fg2,
    height: 40,
    width: 40,
    textAlign: "center",
  },
  typeChoices: { gap: space.sm, paddingBottom: space.md, paddingHorizontal: 4 },
  addSet: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minHeight: 46,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  addSetText: { ...type.action, letterSpacing: 1.47, color: c.fg2 },
  addExercise: { alignSelf: "stretch" },
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
  list: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
  },
  reorderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: ROW,
    paddingLeft: 12,
    paddingRight: 6,
  },
  reorderSuperset: { boxShadow: `inset 3px 0 0 ${c.fg3}` },
  reorderName: { ...type.rowTitle, fontSize: 15, color: c.fg },
  summary: { ...type.meta, color: c.fg3, marginTop: 4 },
}));
