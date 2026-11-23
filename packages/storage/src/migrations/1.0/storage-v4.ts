import type { UpgradeStep } from "../../upgrade.ts";

// Notes live in logical JSON records. Prevent an older database writer from dropping their fields.
export const storeWorkoutJournals: UpgradeStep = {
  from: 3,
  description: "Preserve workout notes and their linked replies",
  run() {},
};
