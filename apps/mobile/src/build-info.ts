/** Which build is running: set by the build (`EXPO_PUBLIC_COMMIT`), so a preview can be identified. */
export const buildInfo = {
  commit: process.env.EXPO_PUBLIC_COMMIT ?? "local",
  label: process.env.EXPO_PUBLIC_BUILD_LABEL ?? "development",
  releaseNumber: process.env.EXPO_PUBLIC_RELEASE_NUMBER,
  /** Whether a new install starts with made-up data. Off (`EXPO_PUBLIC_SAMPLE_DATA=off`) for TestFlight. */
  sampleData: process.env.EXPO_PUBLIC_SAMPLE_DATA !== "off",
} as const;
