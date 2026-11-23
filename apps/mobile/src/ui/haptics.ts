import * as Haptics from "expo-haptics";

// Short taps of feedback for the moments that matter. On the web, expo-haptics falls back to the
// browser's vibration (or nothing), so these are safe everywhere; a failure is never worth a crash.
const quietly = (feedback: Promise<void>) => {
  feedback.catch(() => {});
};

export const haptic = {
  /** A tab or option was chosen. */
  select: () => quietly(Haptics.selectionAsync()),
  /** A set was logged or a step completed. */
  tap: () => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  /** Something finished well: a saved workout, the end of a rest. */
  success: () => quietly(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** An action was refused. */
  warning: () => quietly(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};
