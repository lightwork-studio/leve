import type { DeviceStore } from "@leve/storage";
import { readAppearanceSetting } from "../data/appearance-setting.ts";
import { applyAppChange, liveData, readAllWorkoutTrees } from "../data/read.ts";
import { readRestAlertSetting } from "../data/rest-alert-setting.ts";
import { readWorkoutRest } from "../data/rest-timer.ts";
import { noteWorkoutHere } from "../data/workout-here.ts";
import { showRestAlert } from "../rest-alert/rest-alert-host.ios.tsx";
import { dockTarget } from "../ui/live/targets.ts";
import { buildWorkoutPlayer } from "../ui/live/use-workout-player.ts";
import { workoutInputs } from "../ui/use-workout-inputs.ts";
import { workoutSelection } from "../ui/use-workout-selection.ts";
import { workoutFrame } from "./frame.ts";
import type { workoutSession } from "./session.ts";

export function playerWithoutScene(store: DeviceStore) {
  const live = liveData(store);
  if (!live) return null;
  const workoutId = live.tree.workout.id;
  const inputs = workoutInputs(store);
  const { drafts, distanceUnits } = inputs.read(workoutId);
  const selection = workoutSelection(store, live.tree);
  return buildWorkoutPlayer({
    store,
    change: (write, scope) => {
      const { result } = applyAppChange(store, write, scope);
      if (scope === "active-workout") noteWorkoutHere(store);
      return result;
    },
    live,
    history: readAllWorkoutTrees(store),
    rest: readWorkoutRest(store, workoutId),
    target: dockTarget(live.tree, selection.focusIndex, selection.pickedSetId),
    drafts,
    setDrafts: (update) =>
      inputs.update(workoutId, (values) => ({ ...values, drafts: update(values.drafts) })),
    distanceUnits,
    focusExercise: selection.focusExercise,
    resume: () => {
      // The native intent can open the workout for review if this tap cannot be saved.
    },
  });
}

/** Publish before the intent's receipt allows iOS to suspend Leve. */
export async function refreshAfterLog(
  store: DeviceStore,
  activity: ReturnType<typeof workoutSession>,
): Promise<void> {
  const player = playerWithoutScene(store);
  const frame = workoutFrame(player, Date.now(), true, readAppearanceSetting());
  await Promise.all([activity.publish(frame), showRestAlert(player, readRestAlertSetting())]);
}
