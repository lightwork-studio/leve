import { requireOptionalNativeModule } from "expo";
import type { RestAlertNative } from "./rest-alerts.ts";

// Absent from Expo Go and from binaries built before the module existed.
export const restAlertNative = requireOptionalNativeModule<RestAlertNative>("LeveRestAlert");
