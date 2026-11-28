// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const profiles = JSON.parse(readFileSync(new URL("../eas.json", import.meta.url), "utf8")).build;

/** The Clerk Frontend API host a publishable key signs in with. */
function clerkHost(key: string): string {
  const decoded = Buffer.from(key.replace(/^pk_(live|test)_/, ""), "base64").toString("utf8");
  expect(decoded.endsWith("$")).toBe(true);
  return decoded.slice(0, -1);
}

it("signs App Store builds in with the production Clerk instance only", () => {
  const production = profiles.production.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  expect(production).toMatch(/^pk_live_/);
  expect(clerkHost(production)).toBe("clerk.leve.timweb.app");
  // Leve Dev and TestFlight previews keep the development instance, and their own accounts.
  for (const name of ["development", "preview"]) {
    const key = profiles[name].env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    expect(key).toMatch(/^pk_test_/);
    expect(clerkHost(key)).toMatch(/\.clerk\.accounts\.dev$/);
  }
});
