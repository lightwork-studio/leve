import type { DeviceStore } from "@leve/storage";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { activityUpdates } from "../src/activity/delivery.ts";
import { readLiveActivityRest } from "../src/data/live-activity-rest";
import { adjustRest, restProgress, restTimer, useRest } from "../src/data/rest-timer.ts";

describe("rest timer adjustments", () => {
  const rest = { endsAt: 60000, totalSeconds: 60, label: "Bench Press" };

  it("skips 15 seconds of progress at second two without changing the pace", () => {
    const shortened = adjustRest(rest, -15, 2000);
    expect(shortened.totalSeconds).toBe(60);
    const after = restProgress(shortened, 2000);
    expect(after.left).toBe(43000);
    expect(after.fraction).toBeCloseTo(17 / 60);
    expect(restProgress(shortened, 3000).fraction).toBeCloseTo(18 / 60);
  });

  it("finishes immediately when the reduction exceeds the time left", () => {
    expect(restProgress(adjustRest(rest, -15, 55000), 55000)).toEqual({ left: 0, fraction: 1 });
  });

  it("still extends the interval when time is added", () => {
    const extended = adjustRest(rest, 15, 2000);
    expect(extended.totalSeconds).toBe(75);
    expect(restProgress(extended, 2000).left).toBe(73000);
  });
});

it("never shows more than the configured rest when the screen clock is one tick behind", () => {
  expect(restProgress({ endsAt: 121500, totalSeconds: 120 }, 700)).toEqual({
    left: 120000,
    fraction: 0,
  });
});

vi.mock("../src/data/live-activity-rest", () => ({ readLiveActivityRest: vi.fn(() => null) }));

function RestProbe({
  store,
  show,
}: {
  store: DeviceStore;
  show(rest: ReturnType<typeof useRest>): void;
}) {
  show(useRest(store, "workout", 0));
  return null;
}

it("adopts lock-screen changes on resume without echoing background taps", () => {
  const store = {
    get(kind: string) {
      if (kind === "workout") return { content: { endedAt: null } };
      if (kind === "workout_exercise") return { content: { workoutId: "workout" } };
      return { content: { workoutExerciseId: "entry", completedAt: "done" } };
    },
    syncState: () => ({ server: null, account: null, lineage: null }),
    list: () => [{ id: "set", content: { completedAt: "done" } }],
  } as unknown as DeviceStore;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  let view: ReactTestRenderer | undefined;
  let shown: ReturnType<typeof useRest> = null;
  const snapshot = () => shown;
  let active = false;
  const refreshActivity = vi.fn();
  const drain = vi.fn();
  const updates = activityUpdates({
    isActive: () => active,
    refreshRest: restTimer.refresh,
    refreshActivity,
    drain,
  });
  const restTap = { target: "LeveRestChanged" };
  try {
    restTimer.start(store, "workout", "set", 60);
    act(() => {
      view = create(
        createElement(RestProbe, {
          store,
          show: (rest) => {
            shown = rest;
          },
        }),
      );
    });
    const initial = snapshot();
    if (!initial) throw Error("Missing rest");
    let change = { start: 85_000, end: 145_000 };
    vi.mocked(readLiveActivityRest).mockImplementation((key) =>
      key === initial.key ? change : null,
    );
    act(() => updates.interacted(restTap));
    expect(snapshot()).toBe(initial);
    expect(refreshActivity).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    updates.interacted({ target: "leve1.ticket:log" });
    expect(drain).toHaveBeenCalledOnce();

    active = true;
    act(() => updates.appStateChanged("active"));
    expect(refreshActivity).toHaveBeenCalledOnce();
    expect(snapshot()).toMatchObject({ key: initial.key, endsAt: 145_000, totalSeconds: 60 });
    expect(restTimer.expire(store, initial)).toBe(false);

    change = { start: 0, end: 0 };
    act(() => updates.interacted(restTap));
    expect(refreshActivity).toHaveBeenCalledOnce();
    expect(snapshot()).toBeNull();
    act(() => restTimer.start(store, "workout", "set", 90));
    expect(snapshot()).toMatchObject({ endsAt: 190_000, totalSeconds: 90 });
    expect(snapshot()?.key).not.toBe(initial.key);
  } finally {
    act(() => view?.unmount());
    vi.mocked(readLiveActivityRest).mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
