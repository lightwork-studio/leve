import type { RestAlertNative } from "./rest-alerts.ts";

// Metro selects native.ios.ts for iPhone builds. Other platforms have no rest alert yet.
export const restAlertNative: RestAlertNative | null = null;
