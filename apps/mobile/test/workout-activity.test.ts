import { describe, expect, it, vi } from "vitest";
import { activityDelivery } from "../src/activity/delivery.ts";
import {
  type ActivityFrame,
  type ActivityMemory,
  type WorkoutContent,
  workoutSession,
} from "../src/activity/session.ts";

function frame(): ActivityFrame {
  return {
    workoutId: "session-A",
    selection: "set-A",
    binding: "session-A/set-A/version-1/50x8",
    act: vi.fn(() => true),
    display: {
      title: "Push A",
      exercise: "Press",
      set: "Set 2",
      compact: "50×8",
      measurements: "50 kg × 8 reps",
      previous: "47.5 × 8",
      volume: "400 kg",
      started: 1,
      done: 1,
      total: 3,
      restStart: 0,
      restEnd: 0,
      interactive: true,
      canLog: true,
      finish: false,
    },
  };
}
/** What the phone keeps across launches: the workout it last showed an activity for. */
function phoneMemory(): ActivityMemory {
  let shown: string | undefined;
  return {
    shown: () => shown,
    remember: (id) => {
      shown = id;
    },
    forget: () => {
      shown = undefined;
    },
  };
}
function harness(scheme = "leve-preview") {
  const memory = phoneMemory();
  const handle = {
    getId: () => "island-A",
    update: vi.fn(async (_props: WorkoutContent) => {}),
    end: vi.fn(async (_policy: "immediate") => {
      visible = false;
    }),
  };
  let visible = true;
  const factory = {
    getInstances: () => (visible ? [handle] : []),
    start: vi.fn((_props: WorkoutContent, _url: string, _stale?: Date) => {
      visible = true;
      return handle;
    }),
  };
  return {
    handle,
    factory,
    memory,
    session: workoutSession(factory, scheme, memory),
    dismiss: () => {
      visible = false;
    },
  };
}

describe("workout Live Activity", () => {
  it.each([
    ["leve-dev", "leve-dev:///workout/active", "leve-dev:///workout/finish"],
    ["leve-preview", "leve-preview:///workout/active", "leve-preview:///workout/finish"],
    ["leve", "leve:///workout/active", "leve:///workout/finish"],
  ])("routes the activity and its Finish button back to %s", async (scheme, active, finish) => {
    const { factory, handle, session } = harness(scheme);
    await session.publish(null);
    const next = frame();
    await session.publish(next);
    expect(factory.start.mock.calls[0]?.[1]).toBe(active);
    expect(factory.start.mock.calls[0]?.[0].openUrl).toBe(active);
    await session.publish({ ...next, display: { ...next.display, finish: true } });
    expect(handle.update.mock.calls[0]?.[0].openUrl).toBe(finish);
  });
  it("clears orphaned displays, shares only presentation fields, and ends the activity when the workout disappears", async () => {
    const { handle, factory, session } = harness();
    await session.publish(null);
    const next = frame();
    await session.publish(next);
    expect(handle.end).toHaveBeenCalledExactlyOnceWith("immediate");
    const content = factory.start.mock.calls[0]?.[0];
    expect(content).toEqual({
      ...next.display,
      token: expect.any(String),
      openUrl: "leve-preview:///workout/active",
    });
    expect(JSON.stringify(content)).not.toContain("session-A");
    await session.publish(next);
    expect(handle.update).not.toHaveBeenCalled();
    await session.publish(null);
    expect(handle.end).toHaveBeenCalledTimes(2);
    session.interact("island-A", `${content?.token}:log`);
    expect(next.act).not.toHaveBeenCalled();
  });
  it("rejects duplicate logs, old activities and taps on an identical-looking previous set", async () => {
    const { factory, session, handle } = harness();
    await session.publish(null);
    const next = frame();
    await session.publish(next);
    const first = `${factory.start.mock.calls[0]?.[0].token}:log`;
    session.interact("foreign", first);
    expect(next.act).not.toHaveBeenCalled();
    session.interact("island-A", first);
    session.interact("island-A", first);
    expect(next.act).toHaveBeenCalledExactlyOnceWith("log");
    const second = { ...next, selection: "set-B", binding: "set-B/v1", act: vi.fn(() => true) };
    const updating = session.publish(second);
    session.interact("island-A", first);
    await updating;
    session.interact("island-A", first);
    expect(second.act).not.toHaveBeenCalled();
    session.interact("island-A", `${handle.update.mock.calls[0]?.[0].token}:log`);
    expect(second.act).toHaveBeenCalledExactlyOnceWith("log");
  });
  it("accepts only rest controls while resting, and ignores them after the deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const { factory, session } = harness();
      await session.publish(null);
      const next = frame();
      Object.assign(next.display, { restStart: 90_000, restEnd: 115_000 });
      await session.publish(next);
      const [props, , stale] = factory.start.mock.calls[0]!;
      expect(stale?.getTime()).toBe(115_000);
      for (const action of ["log", "more", "less", "skip"])
        session.interact("island-A", `${props.token}:${action}`);
      vi.setSystemTime(115_001);
      session.interact("island-A", `${props.token}:more`);
      session.interact("island-A", `${props.token}:log`);
      expect(next.act).toHaveBeenCalledTimes(4);
      expect(vi.mocked(next.act).mock.calls).toEqual([["more"], ["less"], ["skip"], ["log"]]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("accepts the visible Log ticket after a resumed host republishes the expired rest", async () => {
    const { session, handle } = harness();
    const next = frame();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      await session.publish({
        ...next,
        display: { ...next.display, restStart: 90_000, restEnd: 115_000 },
      });
      const token = handle.update.mock.calls[0]![0].token;
      vi.setSystemTime(115_001);
      await session.publish(next);
      expect(session.interact(handle.getId(), token + ":more")).toBe(false);
      expect(session.interact(handle.getId(), token + ":log")).toBe(true);
      expect(next.act).toHaveBeenCalledExactlyOnceWith("log");
    } finally {
      vi.useRealTimers();
    }
  });
  it("recovers the identical unlogged set after relaunch and accepts the old tap exactly once", async () => {
    const { session, handle, factory, memory } = harness();
    const next = frame();
    await session.publish(next);
    const old = handle.update.mock.calls[0]?.[0].token;
    const resumed = workoutSession(factory, "leve-preview", memory);
    await resumed.publish(next);
    resumed.interact(handle.getId(), `${old}:log`);
    resumed.interact(handle.getId(), `${old}:log`);
    expect(next.act).toHaveBeenCalledExactlyOnceWith("log");
    expect(factory.start).not.toHaveBeenCalled();
    expect(handle.end).not.toHaveBeenCalled();
  });
  it("keeps a dismissed workout hidden after process replacement", async () => {
    const { factory, session, memory, dismiss } = harness();
    dismiss();
    await session.publish(null);
    await session.publish(frame());
    expect(factory.start).toHaveBeenCalledOnce();
    dismiss();
    const resumed = workoutSession(factory, "leve-preview", memory);
    await resumed.publish(frame());
    expect(factory.start).toHaveBeenCalledOnce();
    await resumed.publish({ ...frame(), workoutId: "new workout" });
    expect(factory.start).toHaveBeenCalledTimes(2);
  });
  it("starts an activity for a workout that was already running when the app launched", async () => {
    const { factory, memory, dismiss } = harness();
    // Begun before this launch (or before Live Activities shipped), so it never had one.
    dismiss();
    const launched = workoutSession(factory, "leve-preview", memory);
    await launched.publish(frame());
    expect(factory.start).toHaveBeenCalledOnce();
    expect(factory.start.mock.calls[0]?.[1]).toBe("leve-preview:///workout/active");
    // Once shown and then dismissed, the next launch leaves it hidden.
    dismiss();
    await workoutSession(factory, "leve-preview", memory).publish(frame());
    expect(factory.start).toHaveBeenCalledOnce();
  });
  it("keeps an activity left from an earlier build hidden once it is dismissed", async () => {
    // Visible at launch, though this phone has no record of showing it.
    const { factory, memory, dismiss } = harness();
    await workoutSession(factory, "leve-preview", memory).publish(frame());
    expect(factory.start).not.toHaveBeenCalled();
    dismiss();
    await workoutSession(factory, "leve-preview", memory).publish(frame());
    expect(factory.start).not.toHaveBeenCalled();
  });
  it("shows the workout again on a later launch when Leve ended its activity itself", async () => {
    const { factory, memory, session } = harness();
    await session.publish(null);
    await session.publish(frame());
    expect(factory.start).toHaveBeenCalledOnce();
    // The next launch can't open the workout's data, so it ends the activity it found.
    await workoutSession(factory, "leve-preview", memory).publish(null, true);
    // The launch after that can, and the workout is still running.
    await workoutSession(factory, "leve-preview", memory).publish(frame());
    expect(factory.start).toHaveBeenCalledTimes(2);
  });
  it("shows the workout again after a relaunch only if Leve, not the user, ended its activity", async () => {
    // Leve ends it (the workout's data closed), then the app is killed mid-workout.
    const ended = harness();
    await ended.session.publish(frame());
    await ended.session.publish(null);
    await workoutSession(ended.factory, "leve-preview", ended.memory).publish(frame());
    expect(ended.factory.start).toHaveBeenCalledOnce();
    // The user dismisses it first: nothing Leve does afterwards brings it back.
    const dismissed = harness();
    dismissed.dismiss();
    await dismissed.session.publish(frame());
    dismissed.dismiss();
    await dismissed.session.publish(null);
    await workoutSession(dismissed.factory, "leve-preview", dismissed.memory).publish(frame());
    expect(dismissed.factory.start).toHaveBeenCalledOnce();
  });
  it("tries again on a later launch when iOS refused the start in the background", async () => {
    const { factory, memory, dismiss } = harness();
    dismiss();
    factory.start.mockImplementationOnce(() => {
      throw Error("background");
    });
    await workoutSession(factory, "leve-preview", memory).publish(frame());
    expect(memory.shown()).toBeUndefined();
    await workoutSession(factory, "leve-preview", memory).publish(frame());
    expect(factory.start).toHaveBeenCalledTimes(2);
  });
  it("retries an unavailable foreground start and respects dismissal for that workout only", async () => {
    const { factory, session, dismiss } = harness();
    await session.publish(null);
    const next = frame();
    factory.start.mockImplementationOnce(() => {
      throw Error("background");
    });
    await session.publish(next);
    await session.publish(next, true);
    expect(factory.start).toHaveBeenCalledTimes(2);
    dismiss();
    await session.publish({ ...next, selection: "set-B" });
    expect(factory.start).toHaveBeenCalledTimes(2);
    await session.publish({ ...next, workoutId: "session-B" });
    expect(factory.start).toHaveBeenCalledTimes(3);
  });
});

it.each(["same", "changed", "expired"] as const)(
  "drains a %s tap queued before JS is ready",
  async (scenario) => {
    const { session, handle, factory } = harness();
    const before = frame();
    await session.publish(before);
    const token = handle.update.mock.calls[0]?.[0].token;
    if (!token) throw Error("Missing published ticket");
    const tap = {
      id: "tap",
      source: handle.getId(),
      target: token + ":log",
      timestamp: Date.now() - (scenario === "expired" ? 121_000 : 20_000),
      reviewOnly: false,
    };
    const records = [tap];
    const acknowledgements = vi.fn();
    let active = false;
    const review = vi.fn();
    const inbox = {
      pendingLeveActivityTaps: async () => records.slice(),
      async finishLeveActivityTap(id: string, applied: boolean, reviewed: boolean) {
        acknowledgements(id, applied, reviewed);
        if (applied || reviewed) records.pop();
        else tap.reviewOnly = true;
      },
      takeLeveReviewRequest: () => false,
    };
    const after = frame();
    if (scenario === "changed") after.binding = "set-A/version-2/50x10";
    const restored = activityDelivery(
      workoutSession(factory, "leve-preview", phoneMemory()),
      inbox,
      () => active,
      review,
    );
    await restored.drain();
    expect(records).toHaveLength(1);
    await restored.publish(after);
    expect(acknowledgements).toHaveBeenCalledExactlyOnceWith("tap", scenario === "same", false);
    expect(review).not.toHaveBeenCalled();
    active = true;
    // Rejecting a recovered ticket while in the background survives another process exit.
    const reopened = activityDelivery(
      workoutSession(factory, "leve-preview", phoneMemory()),
      inbox,
      () => active,
      review,
    );
    await reopened.publish(frame());
    expect(records).toHaveLength(0);
    expect(review).toHaveBeenCalledTimes(scenario === "same" ? 0 : 1);
    if (scenario !== "same") expect(acknowledgements).toHaveBeenLastCalledWith("tap", false, true);
    expect(after.act).toHaveBeenCalledTimes(scenario === "same" ? 1 : 0);
  },
);

it("opens the requested foreground review even when the native inbox cannot be read", async () => {
  const { session } = harness();
  const review = vi.fn();
  const delivery = activityDelivery(
    session,
    {
      pendingLeveActivityTaps: async () => {
        throw Error("unavailable");
      },
      finishLeveActivityTap: vi.fn(),
      takeLeveReviewRequest: () => true,
    },
    () => true,
    review,
  );
  await delivery.publish(frame());
  expect(review).toHaveBeenCalledOnce();
});
