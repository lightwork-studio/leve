/** Give a requested UI update a frame before running synchronous work. */
export function afterFeedback(run: () => void): () => void {
  let frame: number | undefined;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    clearTimeout(fallback);
  };
  const finish = () => {
    cancel();
    run();
  };
  // Browser frames can stop when the app is backgrounded.
  const fallback = setTimeout(finish, 100);
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(finish);
  });
  return cancel;
}
