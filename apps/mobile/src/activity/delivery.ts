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
  function drain() {
    if (!ready) return draining;
    draining = draining
      .then(async () => {
        await ready;
        // A failed native inbox write still opens the workout, even if reads also fail.
        if (foreground() && inbox.takeLeveReviewRequest()) review();
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
          await inbox.finishLeveActivityTap(tap.id, applied, reviewed);
        }
      })
      .catch(() => {
        // Unacknowledged tickets remain on disk for the next foreground delivery.
      });
    return draining;
  }
  return {
    drain,
    publish(frame: ActivityFrame | null, retry = false) {
      const first = !ready;
      ready = session.publish(frame, retry);
      return first || retry ? drain() : ready;
    },
  };
}

/** ActivityKit has already consumed a rest tap. Reconcile the app's timer when it is visible. */
export function activityUpdates({
  isActive,
  refreshRest,
  refreshActivity,
  drain,
}: {
  isActive(): boolean;
  refreshRest(): void;
  refreshActivity(): void;
  drain(): void;
}) {
  return {
    appStateChanged(state: string) {
      if (state === "active") {
        refreshRest();
        refreshActivity();
      }
    },
    interacted(event: { target?: string }) {
      if (event.target === "LeveRestChanged") {
        if (isActive()) refreshRest();
      } else {
        drain();
      }
    },
  };
}
