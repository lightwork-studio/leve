import { join } from "node:path";
import { openDeviceStore } from "../src/device-store.ts";
import { readStorageMeta } from "../src/meta.ts";
import { createDeviceFixture, engine, OLD_APP, tempDir } from "../src/test-support/fixtures.ts";
import type { LogicalDevice } from "../src/test-support/logical.ts";
import { fixtureContract } from "../src/test-support/versions.ts";
import type { FixtureMeaning } from "./expected-fixture.ts";

/** What the data means, leaving out which version holds it and the raw text. */
export function meaning(logical: LogicalDevice): FixtureMeaning {
  const { storageVersion: _version, appVersion: _app, rawContent: _raw, ...rest } = logical;
  return rest;
}

/** Resolves with the error a promise rejects with; fails if it resolves. */
export function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the operation to fail");
    },
    (error: unknown) => error,
  );
}

/** A fresh copy of the version-1 device fixture in its own directory. */
export async function deviceFixture(): Promise<string> {
  const path = join(tempDir(), "device.db");
  await createDeviceFixture(path);
  return path;
}

/** A fresh phone database with an injected clock and ids, and its persisted unsynced flag. */
export async function openPhone(contract = fixtureContract) {
  const path = join(tempDir(), "phone.db");
  let ids = 0;
  const store = await openDeviceStore({
    engine,
    path,
    appVersion: OLD_APP,
    contract,
    now: () => "2026-11-10T08:00:00.000Z",
    randomId: () => `id-${++ids}`,
  });
  /** The flag as persisted, read through a separate connection. */
  const flag = () => {
    const db = engine.open(path, { readOnly: true });
    try {
      return readStorageMeta(db)?.unsyncedWork;
    } finally {
      db.close();
    }
  };
  return { store, flag, path };
}
