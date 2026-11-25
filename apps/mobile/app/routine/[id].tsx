import type { JsonObject } from "@leve/contract";
import { type EffortScale, LIMITS } from "@leve/core";
import { router, useLocalSearchParams } from "expo-router";
import { type ReactNode, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../../src/data/app-data.tsx";
import { deleteRoutine, organizeRoutine } from "../../src/data/organize-routine.ts";
import { readSettings } from "../../src/data/read.ts";
import {
  createRoutine,
  openPlan,
  type StoredPlan,
  writePlan,
} from "../../src/data/routine-actions.ts";
import { routineEffortScale } from "../../src/model/effort.ts";
import { space, type } from "../../src/theme.ts";
import { DestructiveButton } from "../../src/ui/action-sheet.tsx";
import { Button } from "../../src/ui/buttons.tsx";
import { CommitButton } from "../../src/ui/commit-button.tsx";
import { Dialog, DialogField } from "../../src/ui/dialog.tsx";
import { EditorSyncReview, hasEditorConflict } from "../../src/ui/editor-sync-review.tsx";
import { ErrorRow } from "../../src/ui/field.tsx";
import { haptic } from "../../src/ui/haptics.ts";
import { CheckIcon } from "../../src/ui/icons.tsx";
import { Banner } from "../../src/ui/notice.tsx";
import {
  planSummary,
  ReorderTile,
  RoutineDetailsFields,
  RoutinePlanEditor,
} from "../../src/ui/routine-plan-editor.tsx";
import { ScreenHeader } from "../../src/ui/screen.tsx";
import { themedStyles, useColors, useStyles } from "../../src/ui/themed.ts";

export default function RoutineDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RoutineForm key={id} id={id} />;
}
function RoutineForm({ id }: { id: string }) {
  const { store } = useAppData();
  const record = store.get("routine", id);
  const content = record && !record.deleted ? record.content : null;
  const conflict = hasEditorConflict(record);
  const [reviewing, setReviewing] = useState(conflict);
  const [initial, setInitial] = useState(content);
  if (reviewing && !conflict) {
    setReviewing(false);
    setInitial(content);
  }
  if (!initial && content) setInitial(content);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
  if (conflict && reviewing) {
    return (
      <Page>
        <ScreenHeader
          title="Edit routine"
          backLabel="Train"
          backAccessibilityLabel="Back to Train"
          back={back}
        />
        <EditorSyncReview record={record} onResolved={back} />
        <Button label="Edit a copy" onPress={() => setReviewing(false)} />
      </Page>
    );
  }
  // Once open, the editor stays: a routine that goes and comes back keeps the edits made to it.
  // When sync finds another version, the draft stays open until it is saved or discarded.
  if (initial)
    return (
      <RoutineEditor
        id={id}
        initial={initial}
        available={!!content}
        back={back}
        onReview={conflict ? () => setReviewing(true) : null}
      />
    );
  return <Unavailable back={back} />;
}

function Unavailable({ back }: { back: () => void }) {
  const styles = useStyles(sheet);
  return (
    <Page>
      <ScreenHeader
        title="Edit routine"
        backLabel="Train"
        backAccessibilityLabel="Back to Train"
        back={back}
      />
      <Text style={styles.text}>This routine is no longer available.</Text>
    </Page>
  );
}

/** The scrolling page both states of the screen sit on. */
function Page({
  children,
  scrollEnabled = true,
}: {
  children: ReactNode;
  scrollEnabled?: boolean;
}) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.page}
      scrollEnabled={scrollEnabled}
      keyboardShouldPersistTaps="handled"
      // The keyboard pushes the page up, so the last sets stay visible while they are typed in.
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xxl },
      ]}
    >
      {children}
    </ScrollView>
  );
}

function RoutineEditor({
  id,
  initial,
  available,
  back,
  onReview,
}: {
  id: string;
  initial: JsonObject;
  available: boolean;
  back: () => void;
  /** Set while sync has found another version: discards this draft to review the saved ones. */
  onReview: (() => void) | null;
}) {
  const styles = useStyles(sheet);
  const c = useColors();
  const { store, change } = useAppData();
  const savedScale: EffortScale | null =
    initial.effortScale === "rir" || initial.effortScale === "rpe" ? initial.effortScale : null;
  const opened = {
    exercises: (initial.exercises ?? []) as StoredPlan,
    effortScale: savedScale,
    title: String(initial.title ?? ""),
    notes: String(initial.notes ?? ""),
    folderId: typeof initial.folderId === "string" ? initial.folderId : null,
  };
  const [settings] = useState(() => readSettings(store));
  const [plan, setPlan] = useState(() => openPlan(opened.exercises));
  const openedScale = routineEffortScale(opened);
  const [effortScale, setEffortScale] = useState(openedScale);
  const [title, setTitle] = useState(opened.title);
  const [notes, setNotes] = useState(opened.notes);
  const [folderId, setFolderId] = useState(opened.folderId);
  const [reordering, setReordering] = useState(false);
  const [reorderGripHeld, setReorderGripHeld] = useState(false);
  const [error, setError] = useState("");
  const [copyName, setCopyName] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const [copyAttempt, setCopyAttempt] = useState(0);
  const savingCopy = useRef(false);
  // Set once this editor deletes the routine, so it doesn't turn into "no longer available" on
  // the way out.
  const deleted = useRef(false);
  const folders = store
    .list("routine_folder")
    .map((folder) => ({ id: folder.id, title: String(folder.content?.title ?? "") }));
  const save = () => {
    try {
      const exercises = writePlan(plan, settings, effortScale);
      const scale =
        effortScale !== openedScale || routineEffortScale({ exercises }) !== effortScale
          ? effortScale
          : opened.effortScale;
      change((db) => {
        // A folder chosen here and deleted before saving leaves the routine in none, as the
        // editor then shows. A folder already gone when it opened stays as it was, unless moved.
        const target = folderId === null ? null : db.get("routine_folder", folderId);
        const filed =
          folderId === opened.folderId || (target?.content && !target.deleted) ? folderId : null;
        organizeRoutine(
          db,
          id,
          opened,
          { title, folderId: filed, notes, effortScale: scale },
          { opened: opened.exercises, next: exercises },
        );
      });
    } catch (e) {
      haptic.warning();
      setError((e as Error).message);
      return;
    }
    back();
  };
  const saveCopy = () => {
    if (savingCopy.current || copyName === null) return;
    savingCopy.current = true;
    try {
      change((db) => {
        // A folder deleted since the routine was filed in it leaves the copy in none, as it shows.
        const target = folderId === null ? null : db.get("routine_folder", folderId);
        const filed = target?.content && !target.deleted ? folderId : null;
        createRoutine(db, copyName, filed, plan, settings, notes, effortScale);
      });
    } catch (cause) {
      savingCopy.current = false;
      haptic.warning();
      setCopyError((cause as Error).message);
      setCopyAttempt((n) => n + 1);
      return;
    }
    back();
  };
  if (!available && !deleted.current) return <Unavailable back={back} />;
  return (
    <Page scrollEnabled={!reorderGripHeld}>
      <ScreenHeader
        title={reordering ? "Reorder" : "Edit routine"}
        backLabel="Train"
        backAccessibilityLabel="Back to Train"
        back={back}
        action={
          <ReorderTile
            reordering={reordering}
            disabled={!reordering && plan.length < 2}
            onToggle={() => setReordering(!reordering)}
          />
        }
      />
      {onReview && (
        <>
          <Banner
            label="Sync"
            message="Sync found another version. You can save your draft as a new routine before reviewing the saved versions."
          />
          <DestructiveButton
            label="Discard draft and review versions"
            message="Your unsaved changes to this routine will be lost. Then you can choose which saved version to keep."
            action="Discard draft"
            keep="Keep editing"
            onConfirm={onReview}
          />
        </>
      )}
      {!reordering && (
        <RoutineDetailsFields
          title={title}
          setTitle={setTitle}
          folders={folders}
          folderId={folderId}
          setFolderId={setFolderId}
          notes={notes}
          setNotes={setNotes}
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
      {/* Saving waits until the order is settled: Done first, then Save routine. */}
      {!reordering && (
        <View style={styles.foot}>
          {error ? (
            <View style={styles.errorCard}>
              <ErrorRow message={error} style={styles.errorBand} />
            </View>
          ) : null}
          <CommitButton
            label="Save routine"
            detail={planSummary(plan)}
            icon={<CheckIcon color={c.commitInk} size={26} strokeWidth={2.4} />}
            onPress={save}
          />
          <Button
            rank="text"
            label="Save as new routine"
            onPress={() => {
              const name = `${title.trim()} (copy)`;
              setCopyName(name.length <= LIMITS.titleLength ? name : "Routine copy");
              setCopyError("");
              setError("");
            }}
          />
          {/* A draft that sync found another version of is settled by review first. */}
          {!onReview && (
            <DestructiveButton
              label="Delete routine"
              message={`“${opened.title}” will be deleted. Workouts you logged from it stay in History.`}
              keep="Keep routine"
              onConfirm={() => {
                // A second confirm before the screen closes has nothing left to delete.
                if (deleted.current) return;
                try {
                  deleted.current = true;
                  change((db) => deleteRoutine(db, id, initial));
                } catch (cause) {
                  deleted.current = false;
                  haptic.warning();
                  setError((cause as Error).message);
                  return;
                }
                haptic.tap();
                back();
              }}
            />
          )}
        </View>
      )}
      {copyName !== null && (
        <Dialog
          eyebrow="Save as new routine"
          onClose={() => {
            setCopyName(null);
            setCopyError("");
          }}
          confirm={{ label: "Save copy", onPress: saveCopy }}
        >
          <DialogField
            autoFocus
            selectTextOnFocus
            accessibilityLabel="New routine name"
            value={copyName}
            onChangeText={(text) => {
              setCopyName(text);
              setCopyError("");
            }}
            returnKeyType="done"
            onSubmitEditing={saveCopy}
            hint="The original stays as it was"
            count={`${copyName.trim().length} / ${LIMITS.titleLength}`}
            over={copyName.trim().length > LIMITS.titleLength}
            error={copyError}
            attempt={copyAttempt}
          />
        </Dialog>
      )}
    </Page>
  );
}
const sheet = themedStyles((c) => ({
  page: { flex: 1, backgroundColor: c.bg },
  content: { paddingHorizontal: space.md, gap: space.md },
  text: { ...type.body, color: c.fg },
  foot: { gap: space.sm, marginTop: space.sm },
  errorCard: { borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: c.line },
  errorBand: { borderTopWidth: 0 },
}));
