// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { Change, JsonObject, ReleaseId } from "@leve/contract";
import {
  builtInExercise,
  defaultSettings,
  type WithId,
  type WorkoutContent,
  type WorkoutEntryContent,
  type WorkoutSetContent,
  type WorkoutTree,
} from "@leve/core";
import type { SyncService, WorkoutReadSelection } from "../service.ts";

/** Every kind an MCP read can show. */
const READ_KINDS = [
  "workout",
  "workout_exercise",
  "workout_set",
  "workout_rest",
  "workout_note",
  "workout_note_comment",
  "exercise_note",
  "exercise_note_comment",
  "routine",
  "routine_folder",
  "custom_exercise",
  "body_measurement",
  "settings",
] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/** A live record as MCP tools show it: its content, with its id and the revision to write against. */
export interface Shown {
  id: string;
  revision: number;
  content: JsonObject;
}

/** The settings MCP tools read, with the app's defaults for a fresh account. */
export interface ViewSettings extends JsonObject {
  weightUnit: string;
  distanceUnit: string;
  shortDistanceUnit: string;
  measurementUnit: string;
  firstWeekday: number;
  defaultRestSeconds: number;
  countWarmups: boolean;
  previousValues: string;
  trackRepsInReserve: boolean;
}

/**
 * One account's relevant records, read in one transaction, and the lookups the tool needs.
 */
export class AccountView {
  readonly #records: Map<ReadKind, Shown[]>;
  readonly #byId = new Map<string, Shown>();
  readonly #children = new Map<string, Shown[]>();

  constructor(records: Map<ReadKind, Shown[]>) {
    this.#records = records;
    for (const [kind, list] of records) {
      for (const record of list) this.#byId.set(`${kind}/${record.id}`, record);
    }
    const group = (kind: ReadKind, field: string) => {
      for (const record of this.list(kind)) {
        const parent = record.content[field];
        if (typeof parent !== "string") continue;
        const key = `${kind}<${parent}`;
        const list = this.#children.get(key) ?? [];
        list.push(record);
        this.#children.set(key, list);
      }
    };
    group("workout_exercise", "workoutId");
    group("workout_set", "workoutExerciseId");
    group("workout_note", "workoutId");
    group("workout_note_comment", "noteId");
    group("exercise_note", "workoutId");
    group("exercise_note_comment", "noteId");
  }

  static async load(
    service: SyncService,
    account: string,
    release: ReleaseId,
    kinds: readonly ReadKind[],
    workouts?: WorkoutReadSelection,
  ) {
    const changes = await service.readKinds(account, kinds, release, workouts);
    const shown = new Map<ReadKind, Shown[]>();
    for (const kind of kinds) {
      // Within one major release every live record is representable; anything else is skipped
      // rather than shown half-read.
      const live = (changes.get(kind) ?? []).flatMap((change: Change) =>
        change.state === "live"
          ? [{ id: change.id, revision: change.revision, content: change.content }]
          : [],
      );
      shown.set(kind, live);
    }
    return new AccountView(shown);
  }

  list(kind: ReadKind): Shown[] {
    return this.#records.get(kind) ?? [];
  }

  get(kind: ReadKind, id: string): Shown | undefined {
    return this.#byId.get(`${kind}/${id}`);
  }

  /** Children of `parentId` of a kind, in position order where the kind has one, else by time. */
  children(kind: ReadKind, parentId: string): Shown[] {
    const list = [...(this.#children.get(`${kind}<${parentId}`) ?? [])];
    return list.sort((a, b) => {
      const pa = a.content.position;
      const pb = b.content.position;
      if (typeof pa === "number" && typeof pb === "number" && pa !== pb) return pa - pb;
      const ca = String(a.content.createdAt ?? "");
      const cb = String(b.content.createdAt ?? "");
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  settings(): ViewSettings {
    const defaults = defaultSettings();
    const content = (this.get("settings", "settings")?.content ?? {}) as Partial<ViewSettings>;
    return {
      weightUnit: defaults.weightUnit,
      distanceUnit: defaults.distanceUnit,
      shortDistanceUnit: defaults.shortDistanceUnit,
      measurementUnit: defaults.measurementUnit,
      firstWeekday: defaults.firstWeekday,
      defaultRestSeconds: defaults.defaultRestSeconds,
      countWarmups: defaults.countWarmups,
      previousValues: defaults.previousValues,
      ...content,
      trackRepsInReserve: content.trackRepsInReserve === true,
    };
  }

  /** The workout with its entries and their sets, in position order, as core reads them. */
  tree(workout: Shown): WorkoutTree {
    return {
      workout: asWithId<WorkoutContent>(workout),
      entries: this.children("workout_exercise", workout.id).map((entry) => ({
        entry: asWithId<WorkoutEntryContent>(entry),
        sets: this.children("workout_set", entry.id).map((set) => asWithId<WorkoutSetContent>(set)),
      })),
    };
  }

  trees(): WorkoutTree[] {
    return this.list("workout").map((workout) => this.tree(workout));
  }

  /** The latest bodyweight measured at or before a moment (ms), as the app looks it up. */
  bodyweightAt(): (time: number) => number | null {
    const measured = this.list("body_measurement")
      .flatMap(({ content }) =>
        typeof content.bodyweightKg === "number"
          ? [{ at: Date.parse(String(content.takenAt)), kg: content.bodyweightKg }]
          : [],
      )
      .sort((a, b) => a.at - b.at);
    return (time) => {
      let low = 0;
      let high = measured.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const measurement = measured[middle];
        if (measurement && measurement.at <= time) low = middle + 1;
        else high = middle;
      }
      return measured[low - 1]?.kg ?? null;
    };
  }

  /** Whether an exercise's volume includes bodyweight: the custom exercise's flag, or the library's. */
  usesBodyweight(): (exerciseId: string) => boolean {
    const custom = new Map(
      this.list("custom_exercise").map((e) => [e.id, e.content.usesBodyweight === true]),
    );
    return (id) => custom.get(id) ?? builtInExercise(id)?.usesBodyweight ?? false;
  }
}

const asWithId = <T>(record: Shown): WithId<T> => ({
  id: record.id,
  content: record.content as unknown as T,
});
