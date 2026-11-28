// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Config = Record<string, unknown> & { env?: Record<string, Record<string, unknown>> };

/** Reads wrangler.jsonc, which uses whole-line `//` comments only. */
function readConfig(): Config {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const json = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(json) as Config;
}

// Keys an environment takes from the top level, or that exist only there (`migrations`).
const INHERITED = new Set([
  "$schema",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "observability",
  "migrations",
]);
// Keys Wrangler doesn't inherit: each environment must repeat them, or its Worker lacks them.
const NOT_INHERITED = new Set([
  "define",
  "vars",
  "durable_objects",
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "services",
  "queues",
  "workflows",
  "ai",
  "analytics_engine_datasets",
  "hyperdrive",
  "vectorize",
  "secrets_store_secrets",
  "tail_consumers",
]);

/** Returns the keys of `top` that an environment has to repeat but `env` doesn't match. */
function unmatchedKeys(top: Config, env: Record<string, unknown>): string[] {
  return Object.keys(top).filter(
    (key) => NOT_INHERITED.has(key) && JSON.stringify(env[key]) !== JSON.stringify(top[key]),
  );
}

describe("wrangler.jsonc", () => {
  const config = readConfig();
  const production = config.env?.production ?? {};

  it("names a development and a production Worker", () => {
    expect(config.name).toBe("leve-sync");
    expect(production.name).toBe("leve-sync-prod");
    expect(Object.keys(config.env ?? {})).toEqual(["production"]);
  });

  it("serves production, and only production, at its custom domain", () => {
    expect(production.routes).toEqual([{ pattern: "sync.leve.timweb.app", custom_domain: true }]);
    expect(production.workers_dev).toBe(false);
    // Routes are inherited: one at the top level would point the development Worker at it too.
    expect(config.routes).toBeUndefined();
    expect(config.route).toBeUndefined();
  });

  it("gives production every binding the development Worker has", () => {
    expect(config.durable_objects).toBeDefined();
    expect(unmatchedKeys(config, production)).toEqual([]);
  });

  it("knows whether each top-level key is inherited", () => {
    const unknown = Object.keys(config).filter(
      (key) => key !== "name" && key !== "env" && !INHERITED.has(key) && !NOT_INHERITED.has(key),
    );
    // A new key must be sorted into INHERITED or NOT_INHERITED, so production can't miss it.
    expect(unknown).toEqual([]);
  });

  it("catches a binding added to the development Worker only", () => {
    const withQueue = {
      ...config,
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
    };
    expect(unmatchedKeys(withQueue, production)).toEqual(["queues"]);
    const changed = {
      ...config,
      durable_objects: { bindings: [{ name: "ACCOUNTS", class_name: "AccountObject" }] },
    };
    expect(unmatchedKeys(changed, production)).toEqual(["durable_objects"]);
  });
});
