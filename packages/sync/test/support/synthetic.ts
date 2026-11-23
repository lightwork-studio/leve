import {
  type Contract,
  type ContractDefinition,
  createContract,
  LEVE_CONTRACT_DEFINITION,
  type ReleaseId,
  s,
} from "@leve/contract";
import type { FrozenContract } from "../../../contract/history/1.0/peer.ts";
import { describeFrozenRelease } from "../../../contract/src/frozen.ts";

/*
 * SYNTHETIC EVOLUTION REHEARSAL. Not a real protocol release and never frozen or shipped.
 *
 * It adds release 1.1 with one optional, nullable field (`workout.effortRating`, 0..10) and a
 * feature for it, the way a real minor release would, so the tests can rehearse how today's
 * client and server handle a newer and an older side.
 */

export const REHEARSAL_FEATURE = "effort_rating";

export const REHEARSAL_DEFINITION: ContractDefinition = {
  ...LEVE_CONTRACT_DEFINITION,
  releases: ["1.0", "1.1"],
  kinds: {
    ...LEVE_CONTRACT_DEFINITION.kinds,
    workout: {
      ...LEVE_CONTRACT_DEFINITION.kinds.workout,
      fields: {
        ...LEVE_CONTRACT_DEFINITION.kinds.workout.fields,
        effortRating: { schema: s.nullable(s.integer(0, 10)), since: "1.1" },
      },
    },
  },
  features: {
    ...LEVE_CONTRACT_DEFINITION.features,
    [REHEARSAL_FEATURE]: {
      since: "1.1",
      description: "Rehearsal only: how hard the workout felt",
      fields: [["workout", "effortRating"]],
    },
  },
};

export const rehearsalContract: Contract = createContract(REHEARSAL_DEFINITION);

/** A frozen-style description of the rehearsal release, for a 1.1 peer built only for tests. */
export const rehearsalFrozen = (release: ReleaseId = "1.1"): FrozenContract =>
  describeFrozenRelease(rehearsalContract, release) as unknown as FrozenContract;
