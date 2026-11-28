import { describe, expect, it, vi } from "vitest";
import {
  REST_ALERT_ID,
  type RestAlertNative,
  restAlertPlan,
  restAlerts,
  turnOnRestAlert,
} from "../src/rest-alert/rest-alerts.ts";

/** iOS's pending alerts for Leve, as the native module leaves them. */
function phone(permission: "granted" | "denied" | "undetermined" = "granted") {
  const pending = new Map<string, { title: string; body: string; at: number }>();
  const native = {
    permission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => true),
    schedule: vi.fn(async (id: string, title: string, body: string, at: number) => {
      pending.set(id, { title, body, at });
    }),
    cancel: vi.fn((id: string) => {
      pending.delete(id);
    }),
  } satisfies RestAlertNative;
  return { native, pending };
}

const next = { exercise: "Bench press", set: "set 3", values: "80 kg × 8" };

describe("rest-end alert", () => {
  it("names the set that follows the rest, and only plans one for a running rest", () => {
    expect(restAlertPlan({ endsAt: 90_000 }, next, 60_000)).toEqual({
      at: 90_000,
      title: "Rest over",
      body: "Bench press · set 3 · 80 kg × 8",
    });
    expect(
      restAlertPlan({ endsAt: 90_000 }, { exercise: null, set: "", values: "" }, 60_000)?.body,
    ).toBe("Time for your next set");
    expect(restAlertPlan(null, next, 60_000)).toBeNull();
    expect(restAlertPlan({ endsAt: 60_000 }, next, 60_000)).toBeNull();
  });

  it("clears an alert left by an earlier process, whose rest ended with it", () => {
    const { native, pending } = phone();
    pending.set(REST_ALERT_ID, { title: "Rest over", body: "Squat", at: 1 });
    restAlerts(native);
    expect(pending.size).toBe(0);
  });

  it("follows the rest: schedules it once, moves it when rest changes and cancels it after", async () => {
    const { native, pending } = phone();
    const alerts = restAlerts(native);
    const plan = restAlertPlan({ endsAt: 90_000 }, next, 60_000);
    await alerts.show(plan);
    await alerts.show(restAlertPlan({ endsAt: 90_000 }, next, 61_000));
    expect(native.schedule).toHaveBeenCalledOnce();
    expect(pending.get(REST_ALERT_ID)?.at).toBe(90_000);
    // +15 s from the Live Activity, then the set is logged and the rest ends.
    await alerts.show(restAlertPlan({ endsAt: 105_000 }, next, 62_000));
    expect(pending.get(REST_ALERT_ID)?.at).toBe(105_000);
    await alerts.show(null);
    expect(pending.size).toBe(0);
    expect(native.schedule).toHaveBeenCalledTimes(2);
  });

  it("keeps native calls in order, so a skip during scheduling leaves no alert", async () => {
    const { native, pending } = phone();
    let finish = () => {};
    native.schedule.mockImplementationOnce(
      (id, title, body, at) =>
        new Promise<void>((resolve) => {
          finish = () => {
            pending.set(id, { title, body, at });
            resolve();
          };
        }),
    );
    const alerts = restAlerts(native);
    const scheduling = alerts.show(restAlertPlan({ endsAt: 90_000 }, next, 60_000));
    await Promise.resolve();
    const skipped = alerts.show(null);
    finish();
    await scheduling;
    await skipped;
    expect(pending.size).toBe(0);
  });

  it("skips a plan that a newer one replaced before it was scheduled", async () => {
    const { native, pending } = phone();
    const alerts = restAlerts(native);
    void alerts.show(restAlertPlan({ endsAt: 90_000 }, next, 60_000));
    await alerts.show(restAlertPlan({ endsAt: 75_000 }, next, 60_000));
    expect(native.schedule).toHaveBeenCalledExactlyOnceWith(
      REST_ALERT_ID,
      "Rest over",
      "Bench press · set 3 · 80 kg × 8",
      75_000,
    );
    expect(pending.get(REST_ALERT_ID)?.at).toBe(75_000);
  });

  it("tries the same plan again after iOS refused to schedule it", async () => {
    const { native, pending } = phone();
    native.schedule.mockRejectedValueOnce(Error("refused"));
    const alerts = restAlerts(native);
    const plan = restAlertPlan({ endsAt: 90_000 }, next, 60_000);
    await alerts.show(plan);
    expect(pending.size).toBe(0);
    await alerts.show(plan);
    expect(pending.get(REST_ALERT_ID)?.at).toBe(90_000);
  });

  it.each([
    ["granted", false, true],
    ["undetermined", true, true],
    ["denied", false, false],
  ] as const)(
    "turning it on with permission %s asks iOS: %s, ends on: %s",
    async (status, asks, on) => {
      const { native } = phone(status);
      const save = vi.fn();
      expect(await turnOnRestAlert(native, save)).toBe(on);
      expect(native.requestPermission).toHaveBeenCalledTimes(asks ? 1 : 0);
      expect(save).toHaveBeenCalledExactlyOnceWith(on);
    },
  );

  it("stays off when the person declines the system prompt", async () => {
    const { native } = phone("undetermined");
    native.requestPermission.mockResolvedValueOnce(false);
    const save = vi.fn();
    expect(await turnOnRestAlert(native, save)).toBe(false);
    expect(save).toHaveBeenCalledExactlyOnceWith(false);
  });
});
