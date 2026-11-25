import { type ReactNode, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { choiceLabel, createCustomExercise, pickerLibrary } from "../data/custom-exercises.ts";
import { type BuiltInExercise, findExercises, type PickerExercise } from "../data/exercises.ts";
import { muscleSections } from "../model/muscle-map.ts";
import { radius, space, touch, type } from "../theme.ts";
import { BottomSheet } from "./bottom-sheet.tsx";
import { Button } from "./buttons.tsx";
import { CustomExerciseForm } from "./custom-exercise-form.tsx";
import { TYPE_NAMES } from "./exercise-metrics.ts";
import { ExerciseResults, type ExerciseResultsList } from "./exercise-results.tsx";
import { ExerciseFilters, ExerciseSearch, keepExerciseSearchFocused } from "./exercise-search.tsx";
import { FieldError } from "./field.tsx";
import { CheckIcon, PlusIcon } from "./icons.tsx";
import { MuscleFilter, MusclePreview } from "./muscle-filter.tsx";
import { Tap } from "./tap.tsx";
import { themedStyles, useColors, useStyles } from "./themed.ts";

const PAGE_TITLES = {
  browse: "Add exercise",
  create: "New exercise",
  selected: "Selected exercises",
  next: "",
} as const;

const exerciseKey = (exercise: PickerExercise) => exercise.id;

/**
 * A page after the selection, inside the same sheet: its back button returns to the list with the
 * selection kept. Nothing is added until the page itself saves.
 */
export type PickerNextPage = {
  title: string;
  /** The back button's label, naming the list it returns to. */
  backLabel: string;
  render: (selected: PickerExercise[]) => { body: ReactNode; footer: ReactNode };
};

type PickerProps = {
  included: string[];
  /** How the list marks an exercise already included, "Already added" unless given. */
  includedLabel?: string;
  /** A small line above the title, such as the workout being added to. */
  eyebrow?: string;
  onClose: () => void;
} & (
  | {
      onPick: (exercise: BuiltInExercise) => void;
      onPickMany?: never;
      selectionLimit?: never;
      next?: never;
    }
  | {
      onPick?: never;
      onPickMany: (exercises: BuiltInExercise[]) => void;
      selectionLimit?: number;
      next?: never;
    }
  | { onPick?: never; onPickMany?: never; selectionLimit?: never; next: PickerNextPage }
);

export function ExercisePicker({
  included,
  includedLabel = "Already added",
  eyebrow,
  onClose,
  onPick,
  onPickMany,
  next,
  selectionLimit,
}: PickerProps) {
  const multi = !!onPickMany || !!next;
  const styles = useStyles(sheet);
  const c = useColors();
  const submitted = useRef<PickerExercise[] | null>(null);
  const list = useRef<ExerciseResultsList<PickerExercise>>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const searching = focused || !!query.trim();
  const scrollToTop = () => list.current?.scrollToOffset({ offset: 0, animated: false });
  const [selected, setSelected] = useState<PickerExercise[]>([]);
  const [error, setError] = useState("");
  const selectedIds = useMemo(() => new Set(selected.map((item) => item.id)), [selected]);
  const [equipment, setEquipment] = useState("");
  const [muscle, setMuscle] = useState("");
  const { store, version, change } = useAppData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks changes to device records.
  const library = useMemo(() => pickerLibrary(store), [store, version]);
  const groups = useMemo(
    () => [...new Set(library.flatMap((e) => [...e.primaryMuscles, ...e.secondaryMuscles]))].sort(),
    [library],
  );
  const available = useMemo(
    () => (equipment ? library.filter((item) => item.equipment === equipment) : library),
    [library, equipment],
  );
  const matches = useMemo(() => findExercises(query, "", available), [query, available]);
  // With a muscle chosen, the exercises that target it come first, then those that also work it.
  const sections = useMemo(
    () => muscleSections(matches, muscle, (item) => item, choiceLabel),
    [matches, muscle],
  );
  const resultCount = sections.reduce((total, section) => total + section.data.length, 0);
  const choose = (item: PickerExercise) => {
    if (onPick) return onPick(item);
    if (
      selectionLimit !== undefined &&
      !selectedIds.has(item.id) &&
      selected.length >= selectionLimit
    ) {
      setError("The routine is full. Deselect an exercise to choose another.");
      return;
    }
    setError("");
    setSelected((current) =>
      current.some((other) => other.id === item.id)
        ? current.filter((other) => other.id !== item.id)
        : [...current, item],
    );
  };
  const add = () => {
    if (submitted.current === selected || !multi || !selected.length) return;
    const latest = new Map(pickerLibrary(store).map((item) => [item.id, item]));
    const current = selected.filter((choice) => {
      const item = latest.get(choice.id);
      return item?.name === choice.name && item.type === choice.type;
    });
    if (current.length !== selected.length) {
      setSelected(current);
      setError("An exercise changed. Review your selection and try again.");
      return;
    }
    if (selectionLimit !== undefined && current.length > selectionLimit) {
      setError("The routine is full. Deselect an exercise to continue.");
      return;
    }
    if (next) {
      setFocused(false);
      setPage("next");
      return;
    }
    if (!onPickMany) return;
    submitted.current = selected;
    try {
      onPickMany(current);
    } catch (cause) {
      submitted.current = null;
      setError((cause as Error).message);
    }
  };
  const [page, setPage] = useState<keyof typeof PAGE_TITLES>("browse");
  const back = () => {
    if (page === "browse") onClose();
    else {
      setFocused(false);
      setPage("browse");
    }
  };

  const count = (n: number) => `${n} ${n === 1 ? "exercise" : "exercises"}`;
  if (page === "next" && next) {
    const { body, footer } = next.render(selected);
    return (
      <BottomSheet
        title={next.title}
        size="large"
        scroll={false}
        closeLabel={next.backLabel}
        {...(eyebrow ? { eyebrow } : {})}
        onClose={back}
        footer={footer}
      >
        {body}
      </BottomSheet>
    );
  }
  const title = PAGE_TITLES[page];
  const caption = multi && selected.length ? `${selected.length} selected` : eyebrow;
  return (
    <BottomSheet
      title={title}
      size="large"
      scroll={false}
      closeLabel={page === "browse" ? "Cancel" : "Back"}
      {...(caption ? { eyebrow: caption } : {})}
      onClose={back}
      action={
        page === "browse" ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Create custom exercise"
            onPress={() => setPage("create")}
            scaleTo={0.92}
            style={styles.newTile}
          >
            <PlusIcon color={c.fg2} size={17} strokeWidth={2} />
          </Tap>
        ) : undefined
      }
      footer={
        multi && page !== "create" ? (
          <>
            <FieldError message={error} />
            <View
              style={styles.selbar}
              {...keepExerciseSearchFocused(focused && page === "browse", setFocused)}
            >
              {page === "browse" && selected.length > 0 && (
                <Button
                  label={`Selected · ${selected.length}`}
                  accessibilityLabel="Review selection"
                  onPress={() => setPage("selected")}
                  style={styles.review}
                />
              )}
              <Button
                rank="primary"
                label={
                  !selected.length
                    ? "Select exercises"
                    : next
                      ? `Next · ${selected.length}`
                      : `Add ${count(selected.length)}`
                }
                {...(next ? { accessibilityLabel: `Next, ${count(selected.length)}` } : {})}
                icon={
                  selected.length && !next ? (
                    <PlusIcon color={c.bg} size={16} strokeWidth={2} />
                  ) : undefined
                }
                disabled={!selected.length}
                onPress={add}
                style={styles.add}
              />
            </View>
          </>
        ) : undefined
      }
    >
      {page === "browse" && (
        <View style={styles.search} {...keepExerciseSearchFocused(focused, setFocused)}>
          <ExerciseSearch
            value={query}
            placeholder="Name or muscle"
            onChange={(text) => {
              setQuery(text);
              scrollToTop();
            }}
            onFocusChange={(next) => {
              setFocused(next);
              if (next) scrollToTop();
            }}
          />
        </View>
      )}
      {page === "create" ? (
        <CustomExerciseForm
          initialName={query}
          onSave={(draft) => {
            const saved = change((db) => createCustomExercise(db, draft));
            setQuery(saved.name);
            setEquipment("");
            setMuscle("");
            setFocused(false);
            setPage("browse");
          }}
        />
      ) : (
        <ExerciseResults
          key={page}
          ref={list}
          {...keepExerciseSearchFocused(focused && page === "browse", setFocused)}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          sections={
            page === "selected" ? [{ key: "selected", title: "", data: selected }] : sections
          }
          exerciseKey={exerciseKey}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            page === "browse" ? (
              <View style={[styles.filter, focused && styles.compactFilter]}>
                <ExerciseFilters
                  key={searching ? `search:${query.trim()}` : "browse"}
                  searching={searching}
                  muscle={muscle}
                  value={equipment}
                  onChange={setEquipment}
                >
                  <View style={styles.filterCard}>
                    <MuscleFilter
                      groups={groups}
                      muscle={muscle}
                      onSelect={setMuscle}
                      counts={
                        muscle
                          ? {
                              primary: sections.find((s) => s.key === "primary")?.data.length ?? 0,
                              also: sections.find((s) => s.key === "also")?.data.length ?? 0,
                            }
                          : { total: resultCount }
                      }
                    />
                  </View>
                </ExerciseFilters>
                {!focused && (
                  <Text style={styles.meta}>
                    {count(resultCount)}
                    {query.trim() ? " match" : ""}
                  </Text>
                )}
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {page === "selected"
                ? "No exercises selected."
                : equipment
                  ? `No matching exercises with ${equipment.toLowerCase()}. Clear the equipment filter or change your search.`
                  : "No matching exercises. Try another search or muscle group."}
            </Text>
          }
          renderExercise={({ exercise: item, first, last }) => {
            const includedAlready = included.includes(item.id);
            const selectedMuscle =
              page === "browse" &&
              muscle &&
              `${choiceLabel(muscle)} (${item.primaryMuscles.some((group) => group === muscle) ? "primary" : "secondary"})`;
            const checked = selectedIds.has(item.id);
            return (
              <Tap
                accessibilityRole={multi ? "checkbox" : "button"}
                accessibilityState={multi ? { checked } : undefined}
                accessibilityLabel={`${multi ? "" : "Add "}${item.name}${includedAlready ? " again" : ""}, ${TYPE_NAMES[item.type]}${selectedMuscle ? `, ${selectedMuscle}` : ""}`}
                onPress={() => choose(item)}
                scaleTo={0.98}
                style={[
                  styles.row,
                  first && styles.rowFirst,
                  !first && styles.divider,
                  last && styles.rowLast,
                ]}
              >
                <MusclePreview targets={item} />
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {includedAlready ? `${includedLabel} · ` : ""}
                    {TYPE_NAMES[item.type]} · {selectedMuscle || item.muscles.join(", ")} ·{" "}
                    {item.equipment}
                  </Text>
                </View>
                {multi ? (
                  <View style={[styles.checkbox, checked && styles.checked]}>
                    {checked && <CheckIcon size={14} color={c.bg} strokeWidth={2.4} />}
                  </View>
                ) : (
                  <View style={styles.plus}>
                    {includedAlready ? (
                      <CheckIcon size={16} color={c.fg} />
                    ) : (
                      <PlusIcon size={16} color={c.fg} />
                    )}
                  </View>
                )}
              </Tap>
            );
          }}
        />
      )}
    </BottomSheet>
  );
}

const sheet = themedStyles((c) => ({
  newTile: {
    width: touch,
    height: touch,
    borderRadius: 12,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    alignItems: "center",
    justifyContent: "center",
  },
  selbar: { flexDirection: "row", alignItems: "center", gap: space.sm },
  review: { flex: 1 },
  add: { flex: 1.6 },
  list: { flex: 1 },
  search: { paddingHorizontal: 12, paddingBottom: space.sm },
  listContent: { paddingHorizontal: 12, paddingBottom: space.lg },
  checkbox: {
    width: 24,
    height: 24,
    borderColor: c.line2,
    borderWidth: 1.5,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  checked: { backgroundColor: c.fg, borderColor: c.fg },
  filter: { gap: space.md, marginBottom: space.lg },
  compactFilter: { marginBottom: space.sm },
  filterCard: {
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    minHeight: 58,
    gap: space.md,
    backgroundColor: c.s1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.line,
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
  plus: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { ...type.rowTitle, color: c.fg },
  info: { flex: 1, minWidth: 0, gap: space.xs },
  meta: { ...type.meta, color: c.fg3, paddingHorizontal: 6 },
  rowMeta: { ...type.meta, color: c.fg3 },
  empty: { ...type.body, color: c.fg2, padding: space.lg },
}));
