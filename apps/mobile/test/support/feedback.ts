/** Replace the feedback scheduler with a controlled interval between feedback and the write. */
export function feedbackScheduler() {
  let holding = false;
  const pending = new Set<() => void>();
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const run of pending) run();
    },
    afterFeedback: (run: () => void) => {
      const finish = () => {
        if (pending.delete(finish)) run();
      };
      pending.add(finish);
      if (!holding) queueMicrotask(finish);
      return () => pending.delete(finish);
    },
  };
}
