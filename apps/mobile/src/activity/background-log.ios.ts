import { requireOptionalNativeModule } from "expo";
import { AppRegistry } from "react-native";
import { beforeWorkoutScene } from "../data/app-data.tsx";
import { readAppearanceSetting } from "../data/appearance-setting.ts";
import { workoutFrame } from "./frame.ts";
import { playerWithoutScene, refreshAfterLog } from "./log-player.ios.ts";
import { widgets } from "./workout-activity.ios.tsx";

function EmptyBackgroundRoot() {
  return null;
}

AppRegistry.registerComponent("LeveActivityBackground", () => EmptyBackgroundRoot);

const background = requireOptionalNativeModule<{ wasRequested(): boolean }>(
  "LeveActivityBackground",
);

function logWithoutScene() {
  const loaded = widgets;
  if (!loaded || !background?.wasRequested()) return;
  void beforeWorkoutScene(async (store) => {
    const existing = new Set(
      loaded.workoutActivity.getInstances().map((activity) => activity.getId()),
    );
    const taps = await loaded.inbox.pendingLeveActivityTaps();
    const tap = taps.find((tap) => existing.has(tap.source) && !tap.reviewOnly);
    if (!tap) return;
    const frame = workoutFrame(
      playerWithoutScene(store),
      Date.now(),
      true,
      readAppearanceSetting(),
    );
    if (!frame) return;
    await loaded.session.recover(frame, tap.source, () => refreshAfterLog(store, loaded.activity));
  });
}

if (widgets && background) {
  widgets.addUserInteractionListener((event) => {
    if (event.target?.endsWith(":log")) logWithoutScene();
  });
  logWithoutScene();
}
