/** Which build is running: set by the build (`EXPO_PUBLIC_COMMIT`), so a preview can be identified. */
const webDemo = process.env.EXPO_PUBLIC_WEB_DEMO === "1";

export const buildInfo = {
  webDemo,
  commit: process.env.EXPO_PUBLIC_COMMIT ?? "local",
  label: webDemo ? "Landing page demo" : (process.env.EXPO_PUBLIC_BUILD_LABEL ?? "development"),
  releaseNumber: process.env.EXPO_PUBLIC_RELEASE_NUMBER,
  /** Whether a new install starts with made-up data. Off (`EXPO_PUBLIC_SAMPLE_DATA=off`) for TestFlight. */
  sampleData: webDemo || process.env.EXPO_PUBLIC_SAMPLE_DATA !== "off",
} as const;
