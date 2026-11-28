import type { ActivityFrame, workoutSession } from "./session.ts";

export interface ActivityTapInbox {
  pendingLeveActivityTaps(): Promise<
    { id: string; source: string; target: string; timestamp: number; reviewOnly: boolean }[]
  >;
  finishLeveActivityTap(id: string, applied: boolean, reviewed: boolean): Promise<void>;
  takeLeveReviewRequest(): boolean;
}

// Serialize app startup and native wakeups. A cold foreground handoff can include an unlock.
export function activityDelivery(
  session: ReturnType<typeof workoutSession>,
  inbox: ActivityTapInbox,
  foreground: () => boolean,
  review: () => void,
) {
  let ready: Promise<void> | undefined;
  let draining = Promise.resolve();
  function drain(afterApply?: () => Promise<void>) {
    if (!ready) return draining;
    draining = draining
      .then(async () => {
        await ready;
        // A failed native inbox write still opens the workout, even if reads also fail.
        if (foreground() && inbox.takeLeveReviewRequest()) review();
        const deferred: string[] = [];
        for (const tap of await inbox.pendingLeveActivityTaps()) {
          await ready;
          const age = Date.now() - tap.timestamp;
          const applied =
            !tap.reviewOnly &&
            age >= 0 &&
            age < 120_000 &&
            session.interact(tap.source, tap.target);
          const reviewed = !applied && foreground();
          if (reviewed) review();
          if (applied && afterApply) deferred.push(tap.id);
          else await inbox.finishLeveActivityTap(tap.id, applied, reviewed);
        }
        if (afterApply && deferred.length) {
          // iOS may suspend a headless host as soon as the intent receives its receipt.
          try {
            await afterApply();
          } finally {
            for (const id of deferred) await inbox.finishLeveActivityTap(id, true, false);
          }
        }
      })
      .catch(() => {
        // Unacknowledged tickets remain on disk for the next foreground delivery.
      });
    return draining;
  }
  return {
    drain,
    publish(frame: ActivityFrame | null, retry = false, afterApply?: () => Promise<void>) {
      const first = !ready;
      ready = session.publish(frame, retry);
      return first || retry ? drain(afterApply) : ready;
    },
  };
}
