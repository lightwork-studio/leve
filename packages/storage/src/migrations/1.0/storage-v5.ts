import type { UpgradeStep } from "../../upgrade.ts";

export const rememberRoutineEditBase: UpgradeStep = {
  from: 4,
  description: "Keep the server version a pending routine edit started from",
  run(db) {
    // Existing drafts have no saved starting copy. Leave them for ordinary conflict review.
    db.exec("ALTER TABLE records ADD COLUMN routine_base_content TEXT");
  },
};
