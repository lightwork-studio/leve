// Run in the browser console on the active workout screen of the web preview.
// Measure each painted frame while minimising, then resume the same workout.
(async () => {
  const minimise = document.querySelector('[aria-label="Minimise workout"]');
  if (!minimise) throw new Error("Open an active workout before running this test.");
  const activePath = location.pathname;
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const deadline = performance.now() + 5000;
  const gaps = [];
  let resume;
  let start;
  minimise.click();
  while (performance.now() < deadline) {
    await frame();
    const tabs = document
      .querySelector('[aria-label="Progress"][role="tab"]')
      ?.closest('[role="tablist"]');
    // The floating control contains an elapsed clock.
    resume = [...document.querySelectorAll('[aria-label^="Resume "]')].find(
      (el) => el.textContent.includes(":") && el.getBoundingClientRect().height > 0,
    );
    if (!tabs || !resume || !tabs.getBoundingClientRect().height) continue;
    start ??= performance.now();
    gaps.push(tabs.getBoundingClientRect().top - resume.getBoundingClientRect().bottom);
    if (performance.now() - start >= 700) break;
  }
  if (!resume || gaps.length < 2) throw new Error("Could not observe the Resume transition.");
  const clearance = Math.min(...gaps);
  if (clearance < 0) throw new Error(`Resume overlapped the tab bar by ${-clearance} px.`);
  const box = resume.getBoundingClientRect();
  // The disc at the left end opens the workout (the round button at the right end logs or skips).
  const target = document.elementFromPoint(box.left + 33, box.top + box.height / 2);
  if (!resume.contains(target)) throw new Error("The Resume action is covered.");
  target.click();
  const timeout = performance.now() + 3000;
  while (location.pathname !== activePath && performance.now() < timeout) await frame();
  if (location.pathname !== activePath)
    throw new Error("The tap did not reopen the active workout.");
  return { frames: gaps.length, minimumClearance: clearance, resumed: location.pathname };
})();
