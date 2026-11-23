import type { JsonObject } from "@leve/contract";
import {
  type FrozenContract,
  HistoricalPeer,
  loadContract,
} from "../../../contract/history/1.0/peer.ts";
import type { Transport } from "../../src/transport.ts";

/* Common logical content for sync scenarios. */

export const STARTED = "2026-11-10T18:00:00.000Z";
export const ENDED = "2026-11-10T19:05:00.000Z";

export const workout = (title: string, extra: JsonObject = {}): JsonObject => ({
  title,
  description: "",
  startedAt: STARTED,
  endedAt: null,
  routineId: null,
  ...extra,
});

export const entry = (workoutId: string, exerciseName: string, extra: JsonObject = {}) => ({
  workoutId,
  exerciseId: "bench-press-barbell",
  exerciseName,
  exerciseType: "weight_reps",
  position: 1,
  supersetId: null,
  restSeconds: 90,
  notes: [],
  doubleDumbbellVolume: false,
  ...extra,
});

export const set = (workoutExerciseId: string, extra: JsonObject = {}): JsonObject => ({
  workoutExerciseId,
  position: 1,
  type: "normal",
  weightKg: 80,
  reps: 5,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: null,
  ...extra,
});

export const bodyMeasurement = (bodyweightKg: number | null): JsonObject => ({
  takenAt: STARTED,
  bodyweightKg,
  fatPercent: null,
});

export const HISTORY = new URL("../../../contract/history/", import.meta.url);

export function archivedContract(release: string): FrozenContract {
  return loadContract(new URL(`${release}/`, HISTORY));
}

/**
 * The archived 1.0 peer with deterministic submission ids. Like a real client it connects (hello,
 * which gives it the account's lineage) before its first upload or download.
 */
export class Peer1 extends HistoricalPeer {
  #n = 0;
  readonly prefix: string;
  constructor(transport: Transport, prefix = "peer", contract = archivedContract("1.0")) {
    super(contract, transport);
    this.prefix = prefix;
  }
  override put(kind: string, id: string, content: JsonObject, submissionId?: string): JsonObject {
    const fields = this.contract.kinds[kind]?.content.properties ?? {};
    const complete = { ...content };
    for (const field of ["initialPlan", "planSlot", "repsInReserve", "trackRepsInReserve"]) {
      if (Object.hasOwn(fields, field) && !Object.hasOwn(complete, field)) complete[field] = null;
    }
    return super.put(kind, id, complete, submissionId);
  }
  override newSubmissionId(): string {
    return `${this.prefix}-${++this.#n}`;
  }
  override async push(submissions: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    if (this.lineage === "") await this.hello();
    return super.push(submissions);
  }
  override async pull(limit?: number): Promise<Record<string, unknown>[]> {
    if (this.lineage === "") await this.hello();
    return super.pull(limit);
  }
}
