import { LIMITS } from "@leve/core";
import { useState } from "react";
import { DestructiveButton } from "./action-sheet.tsx";
import { Dialog, DialogField } from "./dialog.tsx";
import { haptic } from "./haptics.ts";

/**
 * Names a new folder, or edits one (opening with its name selected, and offering to delete it).
 * The name is checked when it is saved: `onFinish` throws to refuse it, and the field then shows
 * why. Dismissing it in any way finishes with null.
 */
export function NewFolderDialog({
  initialName,
  routineCount,
  onFinish,
  onDelete,
}: {
  initialName?: string;
  /** For an edit: how many routines the folder holds. */
  routineCount?: number;
  onFinish: (name: string | null) => void;
  /** For an edit: deletes the folder once confirmed. Throws to refuse, shown like a refused name. */
  onDelete?: () => void;
}) {
  const renaming = initialName !== undefined;
  const [name, setName] = useState(initialName ?? "");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const length = name.trim().length;
  const refuse = (problem: unknown, fallback: string) => {
    haptic.warning();
    setError(problem instanceof Error ? problem.message : fallback);
    setAttempt((n) => n + 1);
  };
  const submit = () => {
    try {
      onFinish(name);
    } catch (problem) {
      refuse(problem, "Couldn't save the folder.");
    }
  };
  const count = routineCount ?? 0;
  return (
    <Dialog
      eyebrow={renaming ? "Edit folder" : "New folder"}
      onClose={() => onFinish(null)}
      confirm={{ label: renaming ? "Save" : "Create folder", onPress: submit }}
      footer={
        renaming && onDelete ? (
          <DestructiveButton
            label="Delete folder"
            message={
              count === 0
                ? `“${initialName}” will be deleted.`
                : `“${initialName}” will be deleted. Its ${count === 1 ? "routine stays and moves" : `${count} routines stay and move`} to Not in a folder.`
            }
            keep="Keep folder"
            onConfirm={() => {
              try {
                onDelete();
              } catch (problem) {
                refuse(problem, "Couldn't delete the folder.");
              }
            }}
          />
        ) : null
      }
    >
      <DialogField
        autoFocus
        selectTextOnFocus={renaming}
        accessibilityLabel="Folder name"
        placeholder="Folder name"
        value={name}
        onChangeText={(text) => {
          setName(text);
          setError("");
        }}
        returnKeyType="done"
        onSubmitEditing={submit}
        hint={
          renaming
            ? routineCount === undefined
              ? ""
              : `${routineCount} ${routineCount === 1 ? "routine" : "routines"}`
            : "Routines move in from their Folder row"
        }
        count={`${length} / ${LIMITS.folderTitleLength}`}
        over={length > LIMITS.folderTitleLength}
        error={error}
        attempt={attempt}
      />
    </Dialog>
  );
}
