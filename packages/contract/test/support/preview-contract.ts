import type { FrozenContract } from "../../history/1.0/peer.ts";
import { describeFrozenRelease } from "../../src/frozen.ts";
import {
  type ContractDefinition,
  contractThrough,
  createContract,
  LEVE_CONTRACT_DEFINITION,
  type ReleaseId,
} from "../../src/index.ts";

const { kinds, features } = LEVE_CONTRACT_DEFINITION;

/** A kind that every profile before the last stands in for a server without. */
function inLastProfile<K extends { fields: Record<string, object> }>(kind: K) {
  return {
    ...kind,
    since: "2.0" as const,
    fields: Object.fromEntries(
      Object.entries(kind.fields).map(([key, field]) => [key, { ...field, since: "2.0" as const }]),
    ),
  };
}

/** Test profiles for the old development rollout's feature boundaries. */
const definition = {
  releases: ["1.0", "1.1", "1.2", "2.0"],
  kinds: {
    ...kinds,
    workout: {
      ...kinds.workout,
      fields: {
        ...kinds.workout.fields,
        initialPlan: { ...kinds.workout.fields.initialPlan, since: "1.1" },
      },
    },
    routine: {
      ...kinds.routine,
      fields: {
        ...kinds.routine.fields,
        effortScale: { ...kinds.routine.fields.effortScale, since: "2.0" },
      },
    },
    workout_set: {
      ...kinds.workout_set,
      fields: {
        ...kinds.workout_set.fields,
        planSlot: { ...kinds.workout_set.fields.planSlot, since: "1.1" },
        repsInReserve: { ...kinds.workout_set.fields.repsInReserve, since: "1.2" },
      },
    },
    workout_note: inLastProfile(kinds.workout_note),
    workout_note_comment: inLastProfile(kinds.workout_note_comment),
    exercise_note: inLastProfile(kinds.exercise_note),
    exercise_note_comment: inLastProfile(kinds.exercise_note_comment),
    workout_rest: {
      ...kinds.workout_rest,
      since: "2.0",
      fields: {
        workoutId: { ...kinds.workout_rest.fields.workoutId, since: "2.0" },
        seconds: { ...kinds.workout_rest.fields.seconds, since: "2.0" },
      },
    },
    // Arrived after the drafts were folded into 1.0; placed in the last profile so the earlier
    // ones stand in for a server without it.
    settings: {
      ...kinds.settings,
      fields: {
        ...kinds.settings.fields,
        trackRepsInReserve: { ...kinds.settings.fields.trackRepsInReserve, since: "2.0" },
      },
    },
  },
  features: {
    ...features,
    reps_in_reserve: { ...features.reps_in_reserve, since: "1.2" },
    workout_journal: { ...features.workout_journal, since: "2.0" },
    exercise_notes: { ...features.exercise_notes, since: "2.0" },
    workout_rest: { ...features.workout_rest, since: "2.0" },
    track_reps_in_reserve: { ...features.track_reps_in_reserve, since: "2.0" },
  },
} as const satisfies ContractDefinition;

export const previewContract = createContract(definition);
export const previewContractThrough = (release: ReleaseId) => contractThrough(release, definition);

export const previewFrozen = (release: ReleaseId): FrozenContract =>
  describeFrozenRelease(previewContract, release) as unknown as FrozenContract;
