import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const support = (file: string) => fileURLToPath(new URL(`./test/support/${file}`, import.meta.url));

export default defineProject({
  resolve: {
    alias: [
      { find: "node:sqlite", replacement: support("node-sqlite.ts") },
      // Native-only modules get Node stand-ins in tests.
      { find: "expo-crypto", replacement: support("expo-crypto.ts") },
      { find: "expo-file-system", replacement: support("expo-file-system.ts") },
      { find: "expo-updates", replacement: support("expo-updates.ts") },
      { find: "expo-secure-store", replacement: support("expo-secure-store.ts") },
      {
        find: /^(@clerk\/expo(\/apple|\/token-cache|\/resource-cache)?|expo-apple-authentication)$/,
        replacement: support("clerk-expo.ts"),
      },
    ],
  },
  test: { name: "mobile", include: ["test/**/*.test.ts"] },
});
