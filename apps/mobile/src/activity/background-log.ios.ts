import type { DeviceStore } from "@leve/storage";
import { requireOptionalNativeModule } from "expo";
import { AppRegistry } from "react-native";
import { beforeWorkoutScene } from "../data/app-data.tsx";
import { readAppearanceSetting } from "../data/appearance-setting.ts";
import { applyAppChange, liveData, readAllWorkoutTrees } from "../data/read.ts";
import { readWorkoutRest } from "../data/rest-timer.ts";
import { noteWorkoutHere } from "../data/workout-here.ts";
import { dockTarget } from "../ui/live/targets.ts";
import { buildWorkoutPlayer } from "../ui/live/use-workout-player.ts";
import { workoutInputs } from "../ui/use-workout-inputs.ts";
import { workoutSelection } from "../ui/use-workout-selection.ts";
import { workoutFrame } from "./frame.ts";
import { widgets } from "./workout-activity.ios.tsx";

function EmptyBackgroundRoot() {
  return null;
}

AppRegistry.registerComponent("LeveActivityBackground", () => EmptyBackgroundRoot);

const background = requireOptionalNativeModule<{ wasRequested(): boolean }>(
  "LeveActivityBackground",
);

function backgroundFrame(store: DeviceStore) {
  const live = liveData(store);
  if (!live) return null;
  const workoutId = live.tree.workout.id;
  const inputs = workoutInputs(store);
  const { drafts, distanceUnits } = inputs.read(workoutId);
  const selection = workoutSelection(store, live.tree);
  const player = buildWorkoutPlayer({
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
  return workoutFrame(player, Date.now(), true, readAppearanceSetting());
}

function logWithoutScene() {
  const loaded = widgets;
  if (!loaded || !background?.wasRequested()) return;
  void beforeWorkoutScene(async (store) => {
    const existing = new Set(
      loaded.workoutActivity.getInstances().map((activity) => activity.getId()),
    );
    const taps = await loaded.inbox.pendingLeveActivityTaps();
    if (!taps.some((tap) => existing.has(tap.source) && !tap.reviewOnly)) return;
    await loaded.session.publish(backgroundFrame(store), true, () =>
      loaded.activity.publish(backgroundFrame(store)),
    );
  });
}

if (widgets && background) {
  widgets.addUserInteractionListener((event) => {
    if (event.target?.endsWith(":log")) logWithoutScene();
  });
  logWithoutScene();
}
