import type { UpgradeStep } from "../../upgrade.ts";

export const addReleaseRefresh: UpgradeStep = {
  from: 1,
  description: "Remember which release a full download is replacing",
  run(db) {
    db.exec("ALTER TABLE sync_state ADD COLUMN refresh_from TEXT");
    db.exec("ALTER TABLE records ADD COLUMN observed_release TEXT");
  },
};

// Version 1 already stores logical JSON. The version bump prevents older writers from
// opening records with workout plans. Leave every revision, payload and receipt intact.
export const serverWorkoutPlans: UpgradeStep = {
  from: 1,
  description: "Allow workout plans in stored logical records",
  run() {},
};
