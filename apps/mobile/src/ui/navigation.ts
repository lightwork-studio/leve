import { router } from "expo-router";

/** Back to the tabs, leaving nothing of a workout behind on the stack. */
export function goHome(): void {
  if (router.canDismiss()) router.dismissAll();
  else router.replace("/");
}
