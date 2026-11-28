import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "sync-cloudflare" },
  // The Workers runtime's module, so the account object can run on Node in tests.
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/cloudflare-workers-fake.ts", import.meta.url),
      ),
    },
  },
});
