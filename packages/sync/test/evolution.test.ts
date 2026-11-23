import { describe, it } from "vitest";
import { checkNoCommonRelease, checkOmissionRule, checkPartialUpload } from "./support/checks.ts";

/*
 * Evolution rehearsal with a SYNTHETIC release 1.1 (see support/synthetic.ts): it is not a real
 * release. It rehearses what happens when one side is newer than the other.
 */

describe("evolution rehearsal (synthetic release 1.1)", () => {
  it("keeps a stored newer field when an archived 1.0 peer edits the record; null clears it", () =>
    checkOmissionRule());

  it("uploads to an older server as partially synced and resends in full after it upgrades", () =>
    checkPartialUpload());

  it("answers update_required naming the side behind and loses no local data", () =>
    checkNoCommonRelease());
});
