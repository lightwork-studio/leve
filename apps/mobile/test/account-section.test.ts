// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSection, signInProblem } from "../src/account/account-section.tsx";
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
vi.mock("react-native-svg", () => ({ default: "svg", Path: "path" }));
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
  expect(text()).toContain("Everything keeps working without an account.");

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

it("stays quietly signed out when the Apple sheet is dismissed", async () => {
  clerk.appleFlow = async () => ({ createdSessionId: null });
  await render();
  await tap("Sign in with Apple");
  expect(clerk.calls).toEqual(["apple"]);
  expect(text()).toContain("Everything keeps working without an account.");
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

it("explains that sign-in needs a connection while Clerk can't load", async () => {
  clerk.loaded = false;
  await render();
  expect(text()).toContain("Sign-in needs a connection.");
});

it("words Clerk's errors for people", () => {
  expect(signInProblem(new ClerkAPIResponseError([{ message: "short" }]))).toBe("short");
  expect(signInProblem(new ClerkAPIResponseError([]))).toBe("Sign-in didn't work. Try again.");
  expect(signInProblem("odd")).toContain("Check the connection");
});
