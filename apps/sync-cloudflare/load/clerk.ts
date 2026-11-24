// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test users for load tests, signed in through Clerk's Backend API so every request carries a real
 * session token. Use a development instance: each test user is a real user of the instance.
 */

const API = "https://api.clerk.com/v1";

export interface TestUser {
  /** The Clerk user id, which is also the sync account. */
  account: string;
  token(): Promise<string>;
}

export function clerkTestUsers(secretKey: string) {
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("load tests sign in test users: use a development instance's secret key");
  }
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Clerk ${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }

  const users = new Map<string, Promise<TestUser>>();

  async function signIn(name: string): Promise<TestUser> {
    const query = new URLSearchParams({ external_id: name });
    const [existing] = await api<{ id: string }[]>("GET", `/users?${query}`);
    const user =
      existing ??
      // Leve signs in only with Apple and Google, so a test user has no email or password.
      (await api<{ id: string }>("POST", "/users", {
        external_id: name,
        skip_password_requirement: true,
      }));
    const session = await api<{ id: string }>("POST", "/sessions", { user_id: user.id });
    let cached: { jwt: string; until: number } | null = null;
    return {
      account: user.id,
      async token() {
        // Session tokens live 60 seconds; fetch a new one well before that.
        if (!cached || cached.until < Date.now()) {
          const { jwt } = await api<{ jwt: string }>("POST", `/sessions/${session.id}/tokens`);
          cached = { jwt, until: Date.now() + 40_000 };
        }
        return cached.jwt;
      },
    };
  }

  return {
    /** The test user called `name`, created on first use. */
    user(name: string): Promise<TestUser> {
      let user = users.get(name);
      if (!user) {
        user = signIn(name);
        users.set(name, user);
      }
      return user;
    },
  };
}
