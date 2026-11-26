import { EXERCISE_CATALOG as catalog, EXERCISE_TYPES, MUSCLE_GROUPS } from "@leve/core";
import { describe, expect, it } from "vitest";
import {
  builtInExercise,
  EXERCISES,
  exerciseLibrary,
  findExercises,
  findLoggedExercises,
} from "../src/data/exercises.ts";

describe("workout exercise library", () => {
  it("preserves the existing exercise identities, logging types and bodyweight flags", () => {
    for (const seeded of Object.values(EXERCISES))
      expect(builtInExercise(seeded.id)).toMatchObject(seeded);
    expect(new Set(exerciseLibrary.map((e) => e.id)).size).toBe(exerciseLibrary.length);
  });

  it("ships the 876 distinct source movements with supported logging fields", () => {
    const sourced = exerciseLibrary.filter((item) => item.sourceId !== undefined);
    expect(sourced).toHaveLength(876);
    expect(new Set(sourced.map((item) => item.sourceId)).size).toBe(876);
    for (const item of exerciseLibrary) expect(EXERCISE_TYPES).toContain(item.type);
    expect(builtInExercise("builtin:running-treadmill")?.type).toBe("distance_duration");
    expect(builtInExercise("builtin:farmers-walk")?.type).toBe("weight_distance");
    expect(builtInExercise("builtin:weighted-pull-ups")).toMatchObject({
      type: "weighted_bodyweight",
      usesBodyweight: true,
    });
    expect(builtInExercise("builtin:pushups")?.type).toBe("bodyweight_reps");
    expect(findExercises("halo with overhead", "triceps")[0]?.primaryMuscles).toEqual([
      "shoulders",
      "triceps",
    ]);
  });

  it("offers reps for stationary bench sprints and dynamic stretches, and load for weighted sit-ups", () => {
    for (const id of ["bench-sprint", "frog-hops", "split-squats", "dynamic-chest-stretch"])
      expect(builtInExercise(`builtin:${id}`)?.type).toBe("bodyweight_reps");
    expect(builtInExercise("builtin:otis-up")?.type).toBe("weight_reps");
    expect(builtInExercise("builtin:weighted-ball-side-bend")?.type).toBe("weight_reps");
    expect(builtInExercise("builtin:cat-stretch")?.type).toBe("duration");
  });

  it("finds the same pull-up movements across spellings and respects the muscle filter", () => {
    const ids = (query: string) => findExercises(query, "lats").map((exercise) => exercise.id);
    const matches = ids("pullup");
    expect(matches).toContain(EXERCISES.pullup.id);
    expect(matches).toContain("builtin:weighted-pull-ups");
    expect(matches).not.toContain(EXERCISES.facepull.id);
    for (const query of ["pull up", "Pull-Up", "pull‑up", "pull ups", "pullups"])
      expect(ids(query)).toEqual(matches);
    expect(findExercises("weighted pullup", "abductors")).toEqual([]);
    expect(ids("ups")).toContain("builtin:weighted-pull-ups");
  });

  it("puts the exact movement before variations when searching the larger library", () => {
    expect(findExercises("push ups", "")[0]?.id).toBe("builtin:pushups");
    expect(findExercises("Farmer’s walk", "")[0]?.id).toBe("builtin:farmers-walk");
    expect(findExercises("", "")[0]?.id).toBe(EXERCISES.bench.id);
  });

  it("finds the original catalog name while keeping the familiar display name and ID", () => {
    for (const query of [
      "Barbell Bench Press - Medium Grip",
      "medium-grip bench",
      "benchpress medium grip",
    ])
      expect(findExercises(query, "triceps")).toContainEqual(builtInExercise(EXERCISES.bench.id));
    expect(findExercises("bent over barbell row", "upper_back")).toContainEqual(
      builtInExercise(EXERCISES.row.id),
    );
    expect(builtInExercise(EXERCISES.bench.id)?.name).toBe("Bench Press");
  });

  it("finds lifts by search and primary or secondary muscle together, without losing the seed's familiar name", () => {
    expect(findExercises("  chEst bench ", "triceps").map((e) => e.name)).toContain("Bench Press");
    expect(findExercises("chest flyes", "chest").map((e) => e.name)).toContain("Dumbbell Flyes");
    expect(findExercises("plank", "triceps").map((e) => e.id)).toEqual([
      "builtin:plank-shoulder-tap",
      "builtin:plank-up-down",
      "builtin:push-up-to-side-plank",
    ]);
    expect(findExercises("bench", "unknown group")).toEqual([]);
    expect(findExercises("pull-up", "upper_back").map((e) => e.id)).toContain(EXERCISES.pullup.id);
    expect(builtInExercise("builtin:dumbbell-flyes")?.type).toBe("weight_reps");
  });
});

describe("Leve's own catalog additions", () => {
  const additions = catalog.filter((item) => !("sourceId" in item));
  const known = new Set([
    ...MUSCLE_GROUPS.map((group) => group.replaceAll("_", " ")),
    "middle back",
  ]);
  const equipment = new Set(catalog.filter((item) => "sourceId" in item).map((e) => e.equipment));

  it("adds common movements with their own ids, muscles and logging fields", () => {
    expect(additions).toHaveLength(160);
    for (const item of additions) {
      expect(item.id).toMatch(/^builtin:[a-z0-9-]+$/);
      expect(item.id.length).toBeLessThanOrEqual(64);
      expect(item.muscles).toHaveLength(1);
      expect(equipment).toContain(item.equipment);
      expect(EXERCISE_TYPES).toContain(item.type);
      for (const label of [...item.muscles, ...item.secondaryMuscles])
        expect(known).toContain(label.toLowerCase());
    }
    const names = exerciseLibrary.map((item) => item.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("logs each addition the way the movement is measured", () => {
    expect(builtInExercise("builtin:clamshell")).toMatchObject({
      type: "bodyweight_reps",
      primaryMuscles: ["glutes"],
    });
    expect(builtInExercise("builtin:running")?.type).toBe("distance_duration");
    expect(builtInExercise("builtin:wall-sit")?.type).toBe("duration");
    expect(builtInExercise("builtin:dumbbell-suitcase-carry")?.type).toBe("weight_distance");
    expect(builtInExercise("builtin:weighted-chin-up")).toMatchObject({
      type: "weighted_bodyweight",
      usesBodyweight: true,
    });
    expect(builtInExercise("builtin:assisted-pull-up")).toMatchObject({
      type: "assisted_bodyweight",
      usesBodyweight: true,
    });
    expect(
      additions
        .filter((item) => "usesBodyweight" in item && item.usesBodyweight)
        .map((item) => item.id),
    ).toEqual([
      "builtin:assisted-chest-dip",
      "builtin:assisted-chin-up",
      "builtin:assisted-pull-up",
      "builtin:assisted-triceps-dip",
      "builtin:floor-triceps-dip",
      "builtin:kipping-pull-up",
      "builtin:negative-pull-up",
      "builtin:ring-pull-up",
      "builtin:weighted-chest-dip",
      "builtin:weighted-chin-up",
      "builtin:weighted-triceps-dip",
    ]);
  });

  it("logs band resistance as weight for the band movements Leve adds or retypes", () => {
    for (const id of [
      "builtin:lateral-raise-with-bands",
      "builtin:squats-with-bands",
      "builtin:bench-press-with-bands",
      "builtin:band-chest-fly",
    ])
      expect(builtInExercise(id)?.type).toBe("weight_reps");
  });

  it("finds additions by name and muscle alongside the source movements", () => {
    expect(findExercises("clamshell", "")[0]?.id).toBe("builtin:clamshell");
    expect(findExercises("jumping jacks", "")[0]?.id).toBe("builtin:jumping-jacks");
    expect(findExercises("lateral raise", "shoulders").map((e) => e.id)).toEqual(
      expect.arrayContaining(["builtin:cable-lateral-raise", "builtin:lateral-raise"]),
    );
  });
});

describe("logged exercise search", () => {
  const recent = { exerciseId: "custom", name: "Band pull‑ups" };
  const older = { exerciseId: EXERCISES.pullup.id, name: "My old bar routine" };
  const bench = { exerciseId: EXERCISES.bench.id, name: "Bench Press" };
  const logged = [recent, bench, older];

  it("matches saved, current and original names and keeps recency, labels and identities", () => {
    expect(findLoggedExercises("pull up", logged)).toEqual([recent, older]);
    expect(findLoggedExercises("my old bar", logged)).toEqual([older]);
    expect(findLoggedExercises("barbell bench press — medium grip", logged)).toEqual([bench]);
    expect(findLoggedExercises("standing long jump", logged)).toEqual([]);
    expect(findLoggedExercises("  ", logged)).toBe(logged);
  });
});
