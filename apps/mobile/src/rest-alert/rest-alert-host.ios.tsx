import { useEffect, useState } from "react";
import { Alert, AppState } from "react-native";
import {
  type RestAlertSetting,
  saveRestAlertSetting,
  useRestAlertSetting,
} from "../data/rest-alert-setting.ts";
import { useWorkoutPlayer } from "../ui/live/use-workout-player.ts";
import { showToast } from "../ui/notice.tsx";
import { restAlertNative } from "./native";
import { restAlertPlan, restAlerts, turnOnRestAlert } from "./rest-alerts.ts";

// Create once when a scene or successful Log takes ownership of the rest alert.
let alerts: ReturnType<typeof restAlerts> | undefined;
let offered = false;

export const DENIED_MESSAGE = "Notifications for Leve are off in iOS Settings.";

/** Whether notifications for Leve are off in iOS Settings, checked again whenever Leve returns. */
export function useNotificationsBlocked() {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const native = restAlertNative;
    if (!native) return;
    let live = true;
    const check = () => {
      native.permission().then(
        (status) => {
          if (live) setBlocked(status === "denied");
        },
        () => {},
      );
    };
    check();
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      live = false;
      app.remove();
    };
  }, []);
  return blocked;
}

export function RestAlertHost() {
  return restAlertNative ? <RestAlert /> : null;
}

export function showRestAlert(
  player: ReturnType<typeof useWorkoutPlayer>,
  setting: RestAlertSetting,
) {
  const plan =
    player && setting === "on"
      ? restAlertPlan(
          player.rest,
          { exercise: player.name, set: player.setName, values: player.measurements },
          Date.now(),
        )
      : null;
  if (!restAlertNative) return;
  alerts ??= restAlerts(restAlertNative);
  return alerts.show(plan);
}

function RestAlert() {
  const player = useWorkoutPlayer();
  const setting = useRestAlertSetting();
  const rest = player?.rest ?? null;
  // Runs after every render. Unchanged plans cost nothing.
  useEffect(() => {
    void showRestAlert(player, setting);
  });
  useEffect(
    () => () => {
      void alerts?.show(null);
    },
    [],
  );
  // Offer it once, at the first rest, while Leve is on screen.
  const resting = !!rest;
  useEffect(() => {
    if (setting !== "unset" || !resting || offered || AppState.currentState !== "active") return;
    const native = restAlertNative;
    if (!native) return;
    offered = true;
    Alert.alert(
      "Alert when rest ends?",
      "Leve can tell you when a rest is over and which set is next, on this iPhone and on a paired Apple Watch. You can change this in Settings.",
      [
        { text: "Not now", style: "cancel", onPress: () => saveRestAlertSetting(false) },
        {
          text: "Turn on",
          onPress: () => {
            void turnOnRestAlert(native, saveRestAlertSetting)
              .then((on) => {
                if (!on) showToast(DENIED_MESSAGE);
              })
              .catch(() => showToast(DENIED_MESSAGE));
          },
        },
      ],
      { cancelable: false },
    );
  }, [setting, resting]);
  return null;
}
