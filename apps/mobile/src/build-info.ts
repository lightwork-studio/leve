import { channel } from "expo-updates";

/** Which build is running: set by the build (`EXPO_PUBLIC_COMMIT`), so a preview can be identified. */
const webDemo = process.env.EXPO_PUBLIC_WEB_DEMO === "1";
const sampleData = webDemo || process.env.EXPO_PUBLIC_SAMPLE_DATA !== "off";

export const buildInfo = {
  webDemo,
  commit: process.env.EXPO_PUBLIC_COMMIT ?? "local",
  label: webDemo ? "Landing page demo" : (process.env.EXPO_PUBLIC_BUILD_LABEL ?? "development"),
  releaseNumber: process.env.EXPO_PUBLIC_RELEASE_NUMBER,
  /** Whether a new install starts with made-up data. Off (`EXPO_PUBLIC_SAMPLE_DATA=off`) for TestFlight. */
  sampleData,
  /**
   * Whether Settings also offers to start again with the made-up data, in a build that starts empty:
   * TestFlight, known by the update channel built into it, so its over-the-air updates keep the
   * offer and an App Store build ("production") never has it.
   */
  sampleDataOnRequest: !sampleData && channel === "preview",
} as const;
