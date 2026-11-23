import type { UpgradeStep } from "../../upgrade.ts";

// Logical record fields are stored in JSON. The version fence keeps older writers from
// opening a database containing set effort values they cannot preserve.
export const storeSetEffort: UpgradeStep = {
  from: 2,
  description: "Preserve reps in reserve on workout sets",
  run(db) {
    db.exec("ALTER TABLE receipts ADD COLUMN wrote_revision INTEGER CHECK (wrote_revision = 1)");
  },
};

// Previously a partial marker or an omitted field on an in-flight submission
// could mean either a deliberate edit or a cached value. Compare both on the
// first richer download; the old database cannot reconstruct that intent.
export const trackUncertainFields: UpgradeStep = {
  from: 2,
  description: "Keep the evidence for fields that a sync receipt could not confirm",
  run(db) {
    db.exec("ALTER TABLE records ADD COLUMN uncertain_fields TEXT");
    db.exec("ALTER TABLE submissions ADD COLUMN choice_after_dispatch INTEGER NOT NULL DEFAULT 0");
    // Version 2 did not distinguish a normal later edit from a choice made
    // while its earlier upload was outstanding. Preserve ambiguous decisions.
    db.exec(`UPDATE submissions SET choice_after_dispatch = 1 WHERE op = 'put' AND EXISTS (
      SELECT 1 FROM records r WHERE r.kind = submissions.kind AND r.id = submissions.id
      AND r.local_seq > submissions.local_seq AND r.observed_release > submissions.release
    )`);
    db.exec(`UPDATE records SET uncertain_fields = (
      SELECT json_group_array(DISTINCT value) FROM (
        SELECT value FROM json_each(records.partial_fields)
        UNION ALL SELECT fields.value FROM submissions s, json_each(s.omitted) fields
        WHERE s.kind = records.kind AND s.id = records.id
        UNION ALL SELECT local.key FROM json_each(records.local_content) local
        WHERE records.server_revision IS NOT NULL
        AND (records.observed_release IS NULL OR records.observed_release = '1.0')
        AND ((records.kind = 'workout' AND local.key = 'initialPlan')
          OR (records.kind = 'workout_set' AND local.key = 'planSlot'))
        AND local.value IS NOT json_extract(records.server_content, '$.' || local.key)
      )
    ) WHERE local_state = 'live' `);
  },
};
