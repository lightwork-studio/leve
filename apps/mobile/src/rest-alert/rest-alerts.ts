/** The one end-of-rest alert. A new rest replaces it, so there is never more than one. */
export const REST_ALERT_ID = "leve.rest";

export interface RestAlertNative {
  permission(): Promise<"granted" | "denied" | "undetermined">;
  requestPermission(): Promise<boolean>;
  schedule(id: string, title: string, body: string, at: number): Promise<void>;
  cancel(id: string): void;
}

export interface RestAlertPlan {
  at: number;
  title: string;
  body: string;
}

/**
 * The alert for a running rest, naming the set that follows it. Only what the Live Activity
 * already shows goes into it: no notes, history or account details.
 */
export function restAlertPlan(
  rest: { endsAt: number } | null,
  next: { exercise?: string | null; set?: string; values?: string },
  now: number,
): RestAlertPlan | null {
  if (!rest || rest.endsAt <= now) return null;
  const body = [next.exercise, next.set, next.values].filter(Boolean).join(" · ");
  return { at: rest.endsAt, title: "Rest over", body: body || "Time for your next set" };
}

/**
 * Keeps the scheduled alert equal to the latest plan. Native calls run in order, and a plan that
 * a newer one replaced before its turn is skipped. Creating it clears any alert left by an earlier
 * process: the rest timer doesn't survive a restart, so its alert mustn't either.
 */
export function restAlerts(native: RestAlertNative) {
  native.cancel(REST_ALERT_ID);
  // What is scheduled: "" for nothing, undefined when a native call failed and it is unknown.
  let wanted: string | undefined = "";
  let work = Promise.resolve();
  return {
    show(plan: RestAlertPlan | null) {
      const key = plan ? JSON.stringify(plan) : "";
      if (key === wanted) return work;
      wanted = key;
      work = work
        .then(async () => {
          if (key !== wanted) return;
          if (plan) await native.schedule(REST_ALERT_ID, plan.title, plan.body, plan.at);
          else native.cancel(REST_ALERT_ID);
        })
        .catch(() => {
          // Unknown now, so the next plan is applied even if it is the same one.
          if (key === wanted) wanted = undefined;
        });
      return work;
    },
  };
}

/**
 * Turns the alert on if iOS allows notifications, asking for permission only when the person
 * hasn't answered yet. Returns whether it is now on.
 */
export async function turnOnRestAlert(
  native: RestAlertNative,
  save: (on: boolean) => void,
): Promise<boolean> {
  const status = await native.permission();
  const granted =
    status === "granted" || (status === "undetermined" && (await native.requestPermission()));
  save(granted);
  return granted;
}
