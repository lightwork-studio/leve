// Metro selects rest-alert-host.ios.tsx for iPhone builds.
export function RestAlertHost() {
  return null;
}

export const DENIED_MESSAGE = "Notifications for Leve are off in iOS Settings.";

export function useNotificationsBlocked() {
  return false;
}
