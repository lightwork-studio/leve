import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import { useTrain } from "../../src/data/queries.ts";
import { createRoutine, type PlannedExercise } from "../../src/data/routine-actions.ts";
import { routineFromWorkout } from "../../src/data/routine-from-workout.ts";
import { space, type } from "../../src/theme.ts";
import { CommitButton } from "../../src/ui/commit-button.tsx";
import { ErrorRow, FieldError } from "../../src/ui/field.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { CheckIcon } from "../../src/ui/icons.tsx";
import {
  planSummary,
  ReorderTile,
  RoutineDetailsFields,
  RoutinePlanEditor,
} from "../../src/ui/routine-plan-editor.tsx";
import { ScreenHeader } from "../../src/ui/screen.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";

export default function NewRoutine() {
  const { fromWorkout, folder } = useLocalSearchParams<{ fromWorkout?: string; folder?: string }>();
  return fromWorkout ? (
    <WorkoutRoutine key={fromWorkout} id={fromWorkout} />
  ) : (
    <RoutineForm {...(folder ? { inFolder: folder } : {})} />
  );
}

type WorkoutSource = ReturnType<typeof routineFromWorkout>;

function WorkoutRoutine({ id }: { id: string }) {
  const { store } = useAppData();
  const [opened, setOpened] = useState<WorkoutSource | null>(null);
  const source = opened ?? routineFromWorkout(store, id);
  if (!opened && "plan" in source) setOpened(source);
  return (
    <RoutineForm
      key={"plan" in source ? "ready" : "unavailable"}
      fromWorkout={id}
      source={source}
    />
  );
}

function RoutineForm({
  fromWorkout,
  source,
  inFolder,
}: {
  fromWorkout?: string;
  source?: WorkoutSource;
  /** The folder the routine was added from, chosen to start with while it still exists. */
  inFolder?: string;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [opened] = useState(Date.now);
  const { settings: preferences, groups } = useTrain(opened);
  const [settings] = useState(preferences);
  const { change } = useAppData();
  const draft = source && "plan" in source ? source : null;
  const [name, setName] = useState(draft?.name ?? "");
  const [notes, setNotes] = useState("");
  const [folder, setFolder] = useState<string | null>(() =>
    inFolder && groups.some((group) => group.folder?.id === inFolder) ? inFolder : null,
  );
  const [plan, setPlan] = useState<PlannedExercise[]>(draft?.plan ?? []);
  const [effortScale, setEffortScale] = useState(draft?.effortScale ?? "rir");
  const [reordering, setReordering] = useState(false);
  const [reorderGripHeld, setReorderGripHeld] = useState(false);
  // A routine opens on its name with the keyboard up while the name is blank; one drafted from a
  // workout usually has one. Only on opening: the field comes back after reordering without it.
  const [focusName, setFocusName] = useState(!name.trim());
  if (reordering && focusName) setFocusName(false);
  const [problem, setProblem] = useState("");
  const saving = useRef(false);
  const folders = groups.flatMap((group) =>
    group.folder ? [{ id: group.folder.id, title: group.folder.content.title }] : [],
  );
  const back = () => {
    if (router.canGoBack()) router.back();
    else if (fromWorkout)
      router.replace({ pathname: "/workout/[id]", params: { id: fromWorkout } });
    else router.replace("/");
  };
  const save = () => {
    if (saving.current) return;
    saving.current = true;
    try {
      change((store) => {
        // A folder deleted while the form was open leaves the routine in none, as the form shows.
        const target = folder === null ? null : store.get("routine_folder", folder);
        const filed = target?.content && !target.deleted ? folder : null;
        createRoutine(store, name, filed, plan, settings, notes, effortScale);
      });
    } catch (error) {
      saving.current = false;
      haptic.warning();
      setProblem((error as Error).message);
      return;
    }
    back();
  };
  const unavailable = source && "error" in source ? source.error : null;
  return (
    <ScrollView
      style={styles.page}
      scrollEnabled={!reorderGripHeld}
      keyboardShouldPersistTaps="handled"
      // The keyboard pushes the page up, so the last sets stay visible while they are typed in.
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xxl },
      ]}
    >
      <ScreenHeader
        title={reordering ? "Reorder" : "New routine"}
        backLabel={fromWorkout ? "Workout" : "Train"}
        backAccessibilityLabel={fromWorkout ? "Back to workout" : "Back to Train"}
        back={back}
        {...(unavailable
          ? {}
          : {
              action: (
                <ReorderTile
                  reordering={reordering}
                  disabled={!reordering && plan.length < 2}
                  onToggle={() => setReordering(!reordering)}
                />
              ),
            })}
      />
      {unavailable ? (
        <FieldError message={unavailable} />
      ) : (
        <>
          {draft && !reordering && (
            <Text style={styles.hint}>Logged sets become targets for the new routine.</Text>
          )}
          {!reordering && (
            <RoutineDetailsFields
              title={name}
              setTitle={setName}
              folders={folders}
              folderId={folder}
              setFolderId={setFolder}
              notes={notes}
              setNotes={setNotes}
              autoFocus={focusName}
            />
          )}
          <RoutinePlanEditor
            plan={plan}
            setPlan={setPlan}
            effortScale={effortScale}
            setEffortScale={setEffortScale}
            settings={settings}
            reordering={reordering}
            onReorder={() => setReordering(true)}
            onReorderDragChange={setReorderGripHeld}
          />
          {!reordering && (
            <View style={styles.foot}>
              {problem ? (
                <View style={styles.errorCard}>
                  <ErrorRow message={problem} style={styles.errorBand} />
                </View>
              ) : null}
              <CommitButton
                label="Save routine"
                detail={planSummary(plan)}
                icon={<CheckIcon color={c.commitInk} size={26} strokeWidth={2.4} />}
                onPress={save}
              />
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
const sheet = themedStyles((c) => ({
  page: { flex: 1, backgroundColor: c.bg },
  content: { paddingHorizontal: space.md, gap: space.md },
  hint: { ...type.caption, color: c.fg2, paddingHorizontal: 6 },
  foot: { gap: space.sm, marginTop: space.sm },
  errorCard: { borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: c.line },
  errorBand: { borderTopWidth: 0 },
}));
