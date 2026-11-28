// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  accountDeletionState,
  forgetAccountDeletionStates,
} from "../src/account/account-deletion.ts";
import { AccountProvider } from "../src/account/account-provider.tsx";
import { AccountSection, signInProblem } from "../src/account/account-section.tsx";
import {
  accountBeingDeleted,
  setAccountBeingDeleted,
  signedOutOnPurpose,
  syncPaused,
} from "../src/sync/sync-preferences.ts";
import { ClerkAPIResponseError, clerk } from "./support/clerk-expo.ts";
import { files } from "./support/expo-file-system.ts";

const platform = vi.hoisted(() => ({ OS: "ios" }));
const key = vi.hoisted(() => ({ value: "pk_test_x" }));
vi.mock("react-native", async () => {
  const web = await vi.importActual<Record<string, unknown>>("react-native-web");
  return {
    ...web,
    Platform: {
      ...(web.Platform as object),
      get OS() {
        return platform.OS;
      },
    },
  };
});
vi.mock("../src/account/clerk-key.ts", () => ({
  get clerkPublishableKey() {
    return key.value;
  },
}));
const syncing = vi.hoisted(() => ({ on: false, unsynced: 0, builtIn: true }));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncEnabled: () => syncing.on,
  syncServerUrl: "https://sync.test",
  builtInServerConfigured: () => syncing.builtIn,
  ownServerAvailable: () => true,
}));
/** The phone's data, bound to the signed-in account; forgetting it is all the section does to it. */
const data = vi.hoisted(() => ({
  bound: { server: "https://sync.test", account: "user_1" } as {
    server: string | null;
    account: string | null;
  },
  forgotten: 0,
}));
vi.mock("../src/data/app-data.tsx", () => {
  const store = {
    syncState: () => data.bound,
    forgetAccount: () => {
      data.forgotten += 1;
      data.bound = { server: null, account: null };
    },
  };
  return { useAppData: () => ({ store, change: (fn: (s: typeof store) => unknown) => fn(store) }) };
});
vi.mock("../src/sync/sync-session.ts", () => ({ unsyncedChanges: () => syncing.unsynced }));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));
vi.mock("../src/ui/focus.ts", () => ({ announce: () => {} }));
vi.mock("react-native-reanimated", () => ({
  default: {
    createAnimatedComponent: (component: unknown) => component,
    View: ({ children }: { children?: ReactNode }) => children ?? null,
  },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
  withSpring: (value: number) => value,
  useReducedMotion: () => false,
  interpolateColor: () => "#000",
}));
vi.mock("react-native-svg", () => ({
  default: "svg",
  Path: "path",
  Circle: "circle",
  Line: "line",
  Polyline: "polyline",
  Rect: "rect",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children, ...props }: { children?: ReactNode; role?: string }) =>
    h("div", { role: props.role }, children),
}));
vi.mock("../src/ui/motion.ts", () => ({
  emphasised: undefined,
  pressScale: 1,
  spring: {},
  fade: undefined,
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  files.clear();
  clerk.reset();
  platform.OS = "ios";
  key.value = "pk_test_x";
  syncing.on = false;
  syncing.unsynced = 0;
  syncing.builtIn = true;
  data.bound = { server: "https://sync.test", account: "user_1" };
  data.forgotten = 0;
  forgetAccountDeletionStates();
  setAccountBeingDeleted(null);
  vi.unstubAllGlobals();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const render = () => act(() => root.render(h(AccountSection)));
const text = () => host.textContent ?? "";
async function tap(label: string) {
  const target = [...host.querySelectorAll<HTMLElement>("button, [role=button]")].find(
    (element) =>
      element.textContent?.includes(label) || element.getAttribute("aria-label") === label,
  );
  if (!target) throw Error(`Missing ${label}`);
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await render();
}

it("isn't there without a Clerk instance or off iOS", async () => {
  key.value = "";
  await render();
  expect(text()).toBe("");
  key.value = "pk_test_x";
  platform.OS = "android";
  await render();
  expect(text()).toBe("");
});

it("signs in with Apple, then shows who is signed in and signs out again", async () => {
  await render();
  expect(text()).toContain("Account");
  expect(text()).toContain("Everything works without an account.");
  // Not promising a backup that doesn't exist yet.
  expect(text()).toContain("your workouts stay on this phone");

  clerk.email = "abc@privaterelay.appleid.com";
  await tap("Sign in with Apple");
  expect(clerk.calls).toEqual(["apple", "setActive sess_1"]);
  expect(text()).toContain("Signed in with Apple");
  expect(text()).toContain("abc@privaterelay.appleid.com");
  expect(text()).toContain("Signing out keeps everything here.");

  await tap("Sign out");
  expect(clerk.calls.at(-1)).toBe("signOut");
  expect(text()).toContain("Sign in with Apple");
  expect(text()).not.toContain("Signed in with Apple");
});

it("in a build that syncs, warns before signing out with unsynced changes", async () => {
  syncing.on = true;
  await render();
  expect(text()).toContain("Sign in to back up your workouts");
  await tap("Sign in with Apple");
  expect(text()).toContain("Your workouts sync with this account.");
  expect(signedOutOnPurpose()).toBe(false);

  syncing.unsynced = 2;
  await tap("Sign out");
  expect(clerk.calls.at(-1)).not.toBe("signOut");
  // The dialog is a modal, drawn outside the section.
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
  expect(dialog()?.textContent).toContain("2 changes haven't synced yet.");
  expect(dialog()?.textContent).toContain(
    "Signing in with a different account asks what to do with them first.",
  );
  await act(async () => {
    [...(dialog()?.querySelectorAll<HTMLElement>("[role=button]") ?? [])]
      .find((element) => element.textContent?.includes("Sign out"))
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await render();
  expect(clerk.calls.at(-1)).toBe("signOut");
  expect(dialog()).toBeNull();
  // Signed out on purpose: the app won't ask to sign in again.
  expect(signedOutOnPurpose()).toBe(true);

  // Nothing waiting: signing out doesn't ask.
  syncing.unsynced = 0;
  await tap("Sign in with Apple");
  await tap("Sign out");
  expect(clerk.calls.at(-1)).toBe("signOut");
  expect(dialog()).toBeNull();
});

it("in a build that syncs, pauses and resumes sync, and says while it is paused", async () => {
  syncing.on = true;
  await render();
  await tap("Sign in with Apple");
  await tap("Pause sync");
  expect(syncPaused()).toBe(true);
  expect(text()).toContain("Sync is paused.");
  await tap("Resume sync");
  expect(syncPaused()).toBe(false);
  expect(text()).toContain("Your workouts sync with this account.");
});

it("stays quietly signed out when the Apple sheet is dismissed", async () => {
  clerk.appleFlow = async () => ({ createdSessionId: null });
  await render();
  await tap("Sign in with Apple");
  expect(clerk.calls).toEqual(["apple"]);
  expect(text()).toContain("Everything works without an account.");
});

it("says what went wrong when signing in fails", async () => {
  clerk.appleFlow = async () => {
    throw new ClerkAPIResponseError([
      { message: "not allowed", longMessage: "Sign-ups are closed for now." },
    ]);
  };
  await render();
  await tap("Sign in with Apple");
  expect(text()).toContain("Sign-ups are closed for now.");
  expect(text()).not.toContain("Signed in with Apple");

  clerk.appleFlow = async () => {
    throw new TypeError("Network request failed");
  };
  await tap("Sign in with Apple");
  expect(text()).toContain("Check the connection and try again.");
});

it("shows no button while Clerk is still loading", async () => {
  clerk.loaded = false;
  await render();
  expect(text()).toContain("Checking your account…");
  expect(text()).not.toContain("Sign in with Apple");
  clerk.loaded = true;
  await render();
  expect(text()).toContain("Sign in with Apple");
});

it("says so when Clerk couldn't finish making the account", async () => {
  clerk.appleFlow = async () => ({
    createdSessionId: null,
    signUp: { status: "missing_requirements" },
  });
  await render();
  await tap("Sign in with Apple");
  expect(text()).toContain("couldn't finish setting up the account");
});

it("keeps the account and says why when signing out fails", async () => {
  clerk.signedIn = true;
  clerk.signOutFails = true;
  await render();
  await tap("Sign out");
  expect(text()).toContain("Signing out didn't work.");
  expect(text()).toContain("Signed in with Apple");
});

it("keeps the session in the keychain and starts offline from Clerk's saved state", async () => {
  await act(() => root.render(h(AccountProvider, null, h("p", null, "app"))));
  expect(text()).toBe("app");
  expect(clerk.providerProps).toMatchObject({
    publishableKey: "pk_test_x",
    tokenCache: { name: "tokenCache" },
    __experimental_resourceCache: expect.any(Function),
    __experimental_disableNativeClientSync: true,
    updateRequiredViewEnabled: false,
  });

  key.value = "";
  clerk.providerProps = null;
  await act(() => root.render(h(AccountProvider, null, h("p", null, "app"))));
  expect(text()).toBe("app");
  expect(clerk.providerProps).toBeNull();
});

it("words Clerk's errors for people", () => {
  expect(signInProblem(new ClerkAPIResponseError([{ message: "short" }]))).toBe("short");
  expect(signInProblem(new ClerkAPIResponseError([]))).toBe("Sign-in didn't work. Try again.");
  expect(signInProblem("odd")).toContain("Check the connection");
});

it("steps aside while the phone syncs with a server the person paired", async () => {
  const store = await import("../src/sync/own-server-store.ts");
  const { keychain } = await import("./support/expo-secure-store.ts");
  keychain.reset();
  store.forgetServerChoice();
  await render();
  expect(text()).toContain("Account");
  await act(async () =>
    store.chooseOwnServer({
      server: "https://sync.home.example",
      account: "a",
      device: "d",
      token: "t",
    }),
  );
  expect(text()).toBe("");
  await act(async () => store.chooseBuiltInServer());
  expect(text()).toContain("Account");
});

/** The deletion requests the phone sent, answered by `answer`. */
function deletionServer(answer: () => Promise<Response>) {
  const sent: { url: string; authorization: string | null; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url,
      authorization: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    });
    return answer();
  });
  return sent;
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
async function confirmDeletion() {
  await act(async () => {
    [...(dialog()?.querySelectorAll<HTMLElement>("[role=button]") ?? [])]
      .find((element) => element.textContent?.includes("Delete account"))
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await render();
}

it("deletes the account after a clear warning and Apple, keeps the phone's data and signs out", async () => {
  syncing.on = true;
  clerk.signedIn = true;
  const sent = deletionServer(async () => Response.json({ deleted: true }));
  await render();
  await tap("Delete account");
  // Nothing happens before the person confirms.
  expect(sent).toEqual([]);
  expect(clerk.calls).toEqual([]);
  expect(dialog()?.textContent).toContain("everything synced to it");
  expect(dialog()?.textContent).toContain("It can't be undone.");
  expect(dialog()?.textContent).toContain("Your workouts stay on this phone");

  await confirmDeletion();
  expect(clerk.calls).toEqual(["apple sheet", "signOut"]);
  expect(sent).toEqual([
    {
      url: "https://sync.test/account/delete",
      authorization: "Bearer token-user_1",
      body: { appleAuthorizationCode: "apple-code", appleClientId: "app.leve.dev" },
    },
  ]);
  expect(data.forgotten).toBe(1);
  expect(accountDeletionState("user_1")).toBe("deleted");
  expect(accountBeingDeleted()).toBeNull();
  expect(signedOutOnPurpose()).toBe(false);
  expect(dialog()).toBeNull();
  expect(text()).toContain("Your Leve account is deleted. Your workouts stay on this phone");
  expect(text()).toContain("Sign in with Apple");
});

it("deletes nothing when the Apple sheet is dismissed", async () => {
  clerk.signedIn = true;
  clerk.appleSheet = async () => {
    throw Object.assign(new Error("canceled"), { code: "ERR_REQUEST_CANCELED" });
  };
  const sent = deletionServer(async () => Response.json({ deleted: true }));
  await render();
  await tap("Delete account");
  await confirmDeletion();
  expect(sent).toEqual([]);
  expect(data.forgotten).toBe(0);
  expect(accountBeingDeleted()).toBeNull();
  expect(text()).toContain("Signed in with Apple");
});

it("forgets the account but stays signed in when only the sign-in part failed, so it can be retried", async () => {
  clerk.signedIn = true;
  deletionServer(async () =>
    Response.json(
      { error: { code: "unavailable", message: "x" }, step: "sign_in" },
      { status: 503 },
    ),
  );
  await render();
  await tap("Delete account");
  await confirmDeletion();
  expect(data.forgotten).toBe(1);
  expect(accountDeletionState("user_1")).toBe("deleted");
  expect(accountBeingDeleted()).toBeNull();
  expect(clerk.calls).not.toContain("signOut");
  expect(text()).toContain("Try again to finish it.");
  expect(text()).toContain("Delete account");
});

it("changes nothing on the phone when the server wasn't set up to delete", async () => {
  clerk.signedIn = true;
  deletionServer(async () =>
    Response.json(
      { error: { code: "unavailable", message: "x" }, step: "configuration" },
      { status: 503 },
    ),
  );
  await render();
  await tap("Delete account");
  await confirmDeletion();
  expect(data.forgotten).toBe(0);
  expect(accountDeletionState("user_1")).toBeNull();
  expect(accountBeingDeleted()).toBeNull();
  expect(text()).toContain("isn't available right now");
});

it("leaves it to sync to find out whether a deletion without an answer happened", async () => {
  clerk.signedIn = true;
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Network request failed");
  });
  await render();
  await tap("Delete account");
  await confirmDeletion();
  expect(data.forgotten).toBe(0);
  // Sync runs again, and the phone remembers to check.
  expect(accountDeletionState("user_1")).toBeNull();
  expect(accountBeingDeleted()).toBe("user_1");
  expect(text()).toContain("Leve couldn't delete your account.");
});

it("leaves another server's data alone", async () => {
  clerk.signedIn = true;
  data.bound = { server: "https://elsewhere.test", account: "someone" };
  deletionServer(async () => Response.json({ deleted: true }));
  await render();
  await tap("Delete account");
  await confirmDeletion();
  expect(data.forgotten).toBe(0);
  expect(accountDeletionState("user_1")).toBe("deleted");
});

it("offers no deletion in a build without a server of its own", async () => {
  syncing.builtIn = false;
  clerk.signedIn = true;
  await render();
  expect(text()).toContain("Signed in with Apple");
  expect(text()).not.toContain("Delete account");
});

it("keeps an earlier unanswered deletion to settle when a retry gets nowhere", async () => {
  clerk.signedIn = true;
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Network request failed");
  });
  await render();
  await tap("Delete account");
  await confirmDeletion();
  expect(accountBeingDeleted()).toBe("user_1");

  // The first request did arrive and deleted the sign-in: no new token for the retry.
  clerk.noToken = true;
  await tap("Delete account");
  await confirmDeletion();
  expect(accountBeingDeleted()).toBe("user_1");
  expect(data.forgotten).toBe(0);
});

it("deletes nothing when Apple doesn't confirm the account's Apple ID", async () => {
  clerk.signedIn = true;
  const sent = deletionServer(async () =>
    Response.json(
      { error: { code: "invalid_request", message: "x" }, step: "apple" },
      { status: 400 },
    ),
  );
  await render();
  await tap("Delete account");
  await confirmDeletion();
  expect(sent[0]?.body).toMatchObject({ appleAuthorizationCode: "apple-code" });
  expect(data.forgotten).toBe(0);
  expect(accountBeingDeleted()).toBeNull();
  expect(text()).toContain("Try again with the Apple ID you use for Leve.");
});
