// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountProvider } from "../src/account/account-provider.tsx";
import { AccountSection, signInProblem } from "../src/account/account-section.tsx";
import { signInReminderDue } from "../src/sync/sync-preferences.ts";
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
const syncing = vi.hoisted(() => ({ on: false, unsynced: 0 }));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncEnabled: () => syncing.on,
  syncServerUrl: "",
}));
vi.mock("../src/data/app-data.tsx", () => ({ useAppData: () => ({ store: {} }) }));
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
  expect(signInReminderDue(Date.now())).toBe(true);

  syncing.unsynced = 2;
  await tap("Sign out");
  expect(clerk.calls.at(-1)).not.toBe("signOut");
  // The dialog is a modal, drawn outside the section.
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
  expect(dialog()?.textContent).toContain("2 changes haven't synced yet.");
  expect(dialog()?.textContent).toContain("Signing in with a different account deletes them.");
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
  expect(signInReminderDue(Date.now())).toBe(false);

  // Nothing waiting: signing out doesn't ask.
  syncing.unsynced = 0;
  await tap("Sign in with Apple");
  await tap("Sign out");
  expect(clerk.calls.at(-1)).toBe("signOut");
  expect(dialog()).toBeNull();
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
