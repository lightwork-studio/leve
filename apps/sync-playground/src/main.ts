// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from "node:path";
import { clearPlaygroundData, startPlayground } from "./playground.ts";

// Starts the playground: `pnpm dev:sync [--fresh]`. PORT and LEVE_PLAYGROUND_DIR override the
// defaults. The data lives in a gitignored folder and can be wiped from the page.

const directory = resolve(
  process.env.LEVE_PLAYGROUND_DIR ??
    new URL("../../../.data/sync-playground-protocol-1", import.meta.url).pathname,
);
if (process.argv.includes("--fresh")) clearPlaygroundData(directory);

const playground = await startPlayground({
  directory,
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
});
console.log(`Leve sync playground: ${playground.url}`);
console.log(`Data: ${directory} (development only; reset it from the page at any time)`);

const stop = async () => {
  await playground.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
