import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { readDevicePreference, writeDevicePreference } from "../data/device-preference-store.ts";
import { useWorkoutPlayer } from "../ui/live/use-workout-player.ts";
import { showToast } from "../ui/notice.tsx";
import { type ActivityTapInbox, activityDelivery } from "./delivery.ts";
import { workoutFrame } from "./frame.ts";
import { workoutSession } from "./session.ts";

/** The workout this phone last showed a Live Activity for. */
const ACTIVITY_WORKOUT = "liveActivityWorkout";

function loadWidgets() {
  // Expo Go lacks the native extension. Import its module only in a capable binary.
  const inbox = requireOptionalNativeModule<ActivityTapInbox>("ExpoWidgets");
  const scheme = Constants.expoConfig?.scheme;
  if (!inbox?.pendingLeveActivityTaps || typeof scheme !== "string") return null;
  const { workoutActivity } = require("./layout.ios.tsx") as typeof import("./layout.ios.tsx");
  const { addUserInteractionListener } = require("expo-widgets") as typeof import("expo-widgets");
  const activity = workoutSession(workoutActivity, scheme, {
    shown: () => {
      const id = readDevicePreference(ACTIVITY_WORKOUT);
      return typeof id === "string" ? id : undefined;
    },
    remember: (id) => {
      if (readDevicePreference(ACTIVITY_WORKOUT) !== id)
        writeDevicePreference(ACTIVITY_WORKOUT, id);
    },
  });
  return {
    activity,
    session: activityDelivery(
      activity,
      inbox,
      () => AppState.currentState === "active",
      () => {
        router.navigate("/workout/active");
        showToast("Review the current set before logging.");
      },
    ),
    addUserInteractionListener,
  };
}
const widgets = loadWidgets();

export function UnavailableWorkoutActivity() {
  useEffect(() => {
    const clear = () => void widgets?.activity.publish(null, true);
    clear();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") clear();
    });
    return () => sub.remove();
  }, []);
  return null;
}

export function WorkoutActivityHost() {
  return widgets ? <LiveWorkout /> : null;
}

function LiveWorkout() {
  const player = useWorkoutPlayer();
  const [revision, refresh] = useState(0);
  const rest = player?.rest;
  useEffect(() => {
    if (!rest) return;
    const timer = setTimeout(
      () => refresh((n) => n + 1),
      Math.max(0, rest.endsAt - Date.now()) + 1,
    );
    return () => clearTimeout(timer);
  }, [rest]);
  useEffect(() => {
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh((n) => n + 1);
    });
    const events = widgets?.addUserInteractionListener(() => {
      void widgets.session.drain();
    });
    void widgets?.session.drain();
    return () => {
      app.remove();
      events?.remove();
    };
  }, []);
  const lastRevision = useRef(-1);
  useLayoutEffect(() => {
    if (!widgets) return;
    const frame = workoutFrame(
      player,
      Date.now(),
      Number.parseInt(String(Platform.Version), 10) >= 17,
    );
    void widgets.session.publish(frame, lastRevision.current !== revision);
    lastRevision.current = revision;
  });
  useLayoutEffect(
    () => () => {
      void widgets?.session.publish(null);
    },
    [],
  );
  return null;
}
