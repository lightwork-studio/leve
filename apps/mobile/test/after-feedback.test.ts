import { afterEach, expect, it, vi } from "vitest";
import { afterFeedback } from "../src/ui/after-feedback.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("leaves a frame for feedback and runs the write once", () => {
  vi.useFakeTimers();
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const write = vi.fn();
  afterFeedback(write);
  frames.get(1)?.();
  expect(write).not.toHaveBeenCalled();
  frames.get(2)?.();
  expect(write).toHaveBeenCalledTimes(1);
  vi.runAllTimers();
  expect(write).toHaveBeenCalledTimes(1);
});

it("runs when frames pause and can be cancelled before leaving the screen", () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const write = vi.fn();
  afterFeedback(write);
  const cancelled = vi.fn();
  afterFeedback(cancelled)();
  vi.runAllTimers();
  expect(write).toHaveBeenCalledTimes(1);
  expect(cancelled).not.toHaveBeenCalled();
});
