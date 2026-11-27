/** Runs `fn` when the app is idle (or after a moment where that can't be told); returns a cancel. */
export function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(fn, { timeout: 2500 });
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(fn, 1200);
  return () => clearTimeout(timer);
}
