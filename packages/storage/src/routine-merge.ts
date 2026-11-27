import { type JsonObject, jsonEqual } from "@leve/contract";

interface RoutineVersions {
  phone: JsonObject;
  account: JsonObject;
}

/** The contract validates exercise and target-set shapes before they reach this comparison. */
type Exercise = JsonObject & { id: string; sets: { id: string }[] };

function plan({ exercises }: JsonObject): Exercise[] {
  return exercises as Exercise[];
}

function details({ exercises: _exercises, ...details }: JsonObject): JsonObject {
  return details;
}

function structure(exercises: Exercise[]) {
  return exercises.map(({ id, exerciseId, exerciseType, supersetId, sets }) => ({
    id,
    exerciseId,
    exerciseType,
    supersetId,
    sets: sets.map((set) => set.id),
  }));
}

/** Include independent exercise edits in both choices, keeping divergent edits on their own side. */
export function mergeRoutine(
  base: JsonObject,
  phone: JsonObject,
  account: JsonObject,
): RoutineVersions | null {
  const baseDetails = details(base);
  if (!jsonEqual(baseDetails, details(phone)) || !jsonEqual(baseDetails, details(account)))
    return null;
  const original = plan(base);
  const local = plan(phone);
  const remote = plan(account);
  const originalStructure = structure(original);
  if (
    new Set(original.map((exercise) => exercise.id)).size !== original.length ||
    original.some(({ sets }) => new Set(sets.map((set) => set.id)).size !== sets.length) ||
    !jsonEqual(originalStructure, structure(local)) ||
    !jsonEqual(originalStructure, structure(remote))
  )
    return null;

  const phonePlan = local.map((exercise, index) =>
    jsonEqual(exercise, original[index]) ? remote[index] : exercise,
  );
  const accountPlan = remote.map((exercise, index) =>
    jsonEqual(exercise, original[index]) ? local[index] : exercise,
  );
  return {
    phone: { ...phone, exercises: phonePlan },
    account: { ...account, exercises: accountPlan },
  };
}
