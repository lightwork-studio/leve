import { MAX_POSITION } from "@leve/contract";
import { LIMITS } from "@leve/core";
import type { Folder, WithId } from "../model/types.ts";
import type { AppData } from "./app-data.tsx";
import { newId } from "./ids.ts";

/** The naming dialog returns null when dismissed, including by the system back button. */
export function finishFolderCreation(change: AppData["change"], name: string | null): void {
  if (name === null) return;
  const title = folderTitle(name);
  change((store) => {
    const last = store.list("routine_folder").at(-1);
    const lastPosition = Number(last?.content?.position ?? 0);
    const id = newId();
    if (store.get("routine_folder", id)) throw new Error("Please try creating the folder again.");
    store.put("routine_folder", id, { title, position: Math.min(lastPosition + 1, MAX_POSITION) });
  });
}

function folderTitle(name: string) {
  const title = name.trim();
  if (!title) throw new Error("Enter a folder name.");
  if (title.length > LIMITS.folderTitleLength) {
    throw new Error(`Use at most ${LIMITS.folderTitleLength} characters for the folder name.`);
  }

  return title;
}

export function finishFolderRename(
  change: AppData["change"],
  folder: WithId<Folder>,
  name: string | null,
) {
  if (name === null) return;
  const title = folderTitle(name);
  change((store) => {
    const current = store.get("routine_folder", folder.id);
    if (!current?.content || current.deleted || current.content.title !== folder.content.title) {
      throw new Error("This folder changed. Close the dialog and reopen it to rename.");
    }
    if (current.problem || current.fromRestore)
      throw new Error("Resolve the sync issue on this folder before renaming it.");
    if (title !== current.content.title)
      store.put("routine_folder", folder.id, { ...current.content, title });
  });
}
