import { LIMITS } from "@leve/core";
import { useState } from "react";
import { Dialog, DialogField } from "./dialog.tsx";
import { haptic } from "./haptics.ts";

/**
 * Names a new folder, or renames one (opening with its name selected). The name is checked when
 * it is saved: `onFinish` throws to refuse it, and the field then shows why. Dismissing it in any
 * way finishes with null.
 */
export function NewFolderDialog({
  initialName,
  routineCount,
  onFinish,
}: {
  initialName?: string;
  /** For a rename: how many routines the folder holds. */
  routineCount?: number;
  onFinish: (name: string | null) => void;
}) {
  const renaming = initialName !== undefined;
  const [name, setName] = useState(initialName ?? "");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const length = name.trim().length;
  const submit = () => {
    try {
      onFinish(name);
    } catch (problem) {
      haptic.warning();
      setError(problem instanceof Error ? problem.message : "Couldn't save the folder.");
      setAttempt((n) => n + 1);
    }
  };
  return (
    <Dialog
      eyebrow={renaming ? "Rename folder" : "New folder"}
      onClose={() => onFinish(null)}
      confirm={{ label: renaming ? "Rename" : "Create folder", onPress: submit }}
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
