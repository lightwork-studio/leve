import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "node:sqlite": fileURLToPath(new URL("./test/support/node-sqlite.ts", import.meta.url)),
      // Native-only modules get Node stand-ins in tests.
      "expo-crypto": fileURLToPath(new URL("./test/support/expo-crypto.ts", import.meta.url)),
      "expo-file-system": fileURLToPath(
        new URL("./test/support/expo-file-system.ts", import.meta.url),
      ),
    },
  },
  test: { name: "mobile", include: ["test/**/*.test.ts"] },
});
