// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import {
  chooseOwnServer,
  forgetServerChoice,
  ownServer,
  previousServer,
  readServerChoice,
} from "../src/sync/own-server-store.ts";
import { syncPaused } from "../src/sync/sync-preferences.ts";
import { SyncServerSection } from "../src/sync/sync-server-section.tsx";
import { clerk } from "./support/clerk-expo.ts";
import { files } from "./support/expo-file-system.ts";
import { keychain } from "./support/expo-secure-store.ts";

/* The one destination shown and chosen in Settings. */

const CODE = "R0zFbfeNwBJAytY_ILQ3qw";
const offered = vi.hoisted(() => ({ own: true, builtIn: true }));
const bound = vi.hoisted(() => ({
  server: null as string | null,
  account: null as string | null,
  waiting: 0,
}));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncServerUrl: "https://sync.leve.example",
  builtInServerConfigured: () => offered.builtIn,
  leveSyncAvailable: () => offered.builtIn,
  ownServerAvailable: () => offered.own,
}));
vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-constants", () => ({ default: { deviceName: "Alice's iPhone" } }));
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({ store: { syncState: () => bound } }),
}));
vi.mock("../src/sync/sync-session.ts", () => ({ unsyncedChanges: () => bound.waiting }));
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
  withSequence: (...values: number[]) => values.at(-1),
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
let requests: { url: string; body: unknown }[];
let answer: () => Response;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  keychain.reset();
  forgetServerChoice();
  files.clear();
  forgetDevicePreferences();
  clerk.reset();
  Object.assign(bound, { server: null, account: null, waiting: 0 });
  offered.own = true;
  offered.builtIn = true;
  requests = [];
  answer = () =>
    new Response(
      JSON.stringify({
        account: "acc-1",
        accountName: "Alice",
        device: "d",
        token: "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg",
      }),
    );
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return answer();
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (link?: { server: string; code: string }) =>
  act(() => root.render(h(SyncServerSection, link ? { link } : {})));
const screen = () => document.body.textContent ?? "";
async function tap(label: string) {
  const buttons = [...document.querySelectorAll<HTMLElement>("button, [role=button]")];
  // An exact label first: "Connect" is also the start of other buttons.
  const target =
    buttons.find(
      (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
    ) ?? buttons.find((b) => b.textContent?.includes(label));
  if (!target) throw Error(`Missing ${label}`);
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function type(text: string) {
  const input = document.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("no field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("starts with local workouts and offers both sync destinations", async () => {
  await render();
  expect(screen()).toContain("On this iPhone");
  expect(screen()).toContain("Sync off");
  expect(screen()).toContain("Use your own server");
  expect(screen()).toContain("Sync with Leve");
  expect(screen()).not.toContain("Pause sync");
});

it("pairs with a pasted link, naming the server before it connects", async () => {
  await render();
  await tap("Use your own server");
  await tap("Review server");
  expect(screen()).toContain("Paste the whole pairing link");
  expect(requests).toEqual([]);

  await type(`https://sync.home.example/connect#code=${CODE}`);
  await tap("Review server");
  expect(screen()).toContain("This phone will sync its workouts with sync.home.example");
  expect(requests).toEqual([]);
  await tap("Connect to sync.home.example");
  expect(requests).toEqual([
    {
      url: "https://sync.home.example/auth/pair",
      body: { code: CODE, device: "Alice's iPhone" },
    },
  ]);
  expect(ownServer()).toMatchObject({ server: "https://sync.home.example", account: "acc-1" });
  expect(screen()).toContain("Account Alice");
  expect(screen()).not.toContain("Connect to a sync server");
});

it("asks before connecting from a link that opened the app, and says why it failed", async () => {
  answer = () => new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
  await render({ server: "https://sync.home.example", code: CODE });
  // Nothing is sent until the person confirms the server it names.
  expect(screen()).toContain("This phone will sync its workouts with sync.home.example");
  expect(requests).toEqual([]);
  await tap("Connect to sync.home.example");
  expect(screen()).toContain("This link has been used or has run out");
  expect(ownServer()).toBeNull();
});

it("switches back to Leve with a retained Apple sign-in, remembering the paired server", async () => {
  const home = { server: "https://sync.home.example", account: "a", device: "d", token: "t" };
  chooseOwnServer(home);
  clerk.signedIn = true;
  clerk.email = "alice@example.net";
  await render();
  expect(screen()).toContain("sync.home.example");
  expect(screen()).toContain("Idle");
  await tap("Change destination");
  await tap("Leve");
  expect(ownServer()).toEqual(home);
  await tap("Switch to Leve");
  expect(ownServer()).toBeNull();
  expect(previousServer()).toEqual(home);
  expect(screen()).toContain("alice@example.net");
  expect(screen()).not.toContain("Idle");
  expect(clerk.calls).toEqual([]);
});

it("pauses and resumes sync with a paired server, which has no account section", async () => {
  forgetDevicePreferences();
  await render();
  expect(screen()).not.toContain("Pause sync");
  chooseOwnServer({ server: "https://sync.home.example", account: "a", device: "d", token: "t" });
  await render();
  await tap("Pause sync");
  expect(syncPaused()).toBe(true);
  expect(screen()).toContain("Paused · changes wait here");
  await tap("Resume sync");
  expect(syncPaused()).toBe(false);
});

it("offers local mode in a self-hosted-only build and hides destinations that are unavailable", async () => {
  offered.builtIn = false;
  chooseOwnServer({ server: "https://sync.home.example", account: "a", device: "d", token: "t" });
  await render();
  await tap("Change destination");
  expect(screen()).not.toContain("Sign in with Apple");
  await tap("On this iPhone");
  await tap("Turn sync off");
  expect(ownServer()).toBeNull();
  expect(readServerChoice()).toBe("local");
  expect(screen()).toContain("Workouts stay on this phone");

  offered.own = false;
  await render();
  expect(screen()).toBe("");
});

it("keeps the previous destination when turning sync off cannot be saved", async () => {
  chooseOwnServer({ server: "https://sync.home.example", account: "a", device: "d", token: "t" });
  await render();
  await tap("Change destination");
  await tap("On this iPhone");
  keychain.failWrites = true;
  await tap("Turn sync off");
  expect(screen()).toContain("This phone couldn't save the change");
  expect(ownServer()).toMatchObject({ server: "https://sync.home.example" });
  expect(syncPaused()).toBe(false);
});

it("keeps Leve signed in but off across a restart until the user chooses it again", async () => {
  clerk.signedIn = true;
  clerk.email = "alice@example.net";
  await render();
  await tap("Change destination");
  await tap("On this iPhone");
  await tap("Pause instead");
  expect(readServerChoice()).toBeNull();
  expect(syncPaused()).toBe(true);
  await tap("Change destination");
  await tap("On this iPhone");
  await tap("Turn sync off");
  forgetServerChoice();
  forgetDevicePreferences();
  await render();
  expect(readServerChoice()).toBe("local");
  expect(syncPaused()).toBe(true);
  expect(screen()).toContain("On this iPhone");
  expect(screen()).toContain("Idle");
  expect(screen()).not.toContain("Resume sync");
  await tap("Sync with Leve");
  await tap("Switch to Leve");
  expect(readServerChoice()).toBe("leve");
  expect(syncPaused()).toBe(false);
  expect(clerk.calls).toEqual([]);
});

it("keeps the destination visible after a legacy Leve sign-in runs out", async () => {
  Object.assign(bound, { server: "https://sync.leve.example", account: clerk.userId });
  await render();
  expect(screen()).toContain("Sign-in needed");
  expect(screen()).not.toContain("On this iPhone");
  await tap("Change destination");
  await tap("On this iPhone");
  await tap("Turn sync off");
  expect(readServerChoice()).toBe("local");
});

it("warns that pending work waits for the retained Leve account before idle sign-out", async () => {
  clerk.signedIn = true;
  Object.assign(bound, { server: "https://sync.leve.example", account: clerk.userId, waiting: 2 });
  chooseOwnServer({ server: "https://sync.home.example", account: "a", device: "d", token: "t" });
  await render();
  await tap("Sign out of Leve");
  expect(screen()).toContain("2 changes haven't synced");
  expect(screen()).toContain("wait for this Leve account");
  expect(clerk.calls).toEqual([]);
  bound.account = "another-leve-user";
  await render();
  expect(screen()).not.toContain("changes haven't synced");
});

it("keeps a paired server selected when Apple sign-in is cancelled", async () => {
  const home = { server: "https://sync.home.example", account: "a", device: "d", token: "t" };
  chooseOwnServer(home);
  clerk.appleFlow = async () => ({ createdSessionId: null });
  await render();
  await tap("Change destination");
  await tap("Leve");
  await tap("Sign in with Apple");
  expect(clerk.calls).toEqual(["apple"]);
  expect(ownServer()).toEqual(home);
  expect(screen()).toContain("Back up with Apple");
});

it("keeps a first-time Apple sign-in idle when saving the new destination fails", async () => {
  clerk.appleFlow = async () => {
    keychain.failWrites = true;
    return { createdSessionId: "sess_1" };
  };
  await render();
  await tap("Sync with Leve");
  await tap("Sign in with Apple");
  expect(clerk.signedIn).toBe(true);
  expect(readServerChoice()).toBe("local");
  expect(syncPaused()).toBe(true);
  expect(screen()).toContain("This phone couldn't save the change");
  expect(screen()).toContain("Idle");
  expect(screen()).toContain("Sync off");
});

it("asks for a new link when the pairing worked but the phone couldn't keep it", async () => {
  await render({ server: "https://sync.home.example", code: CODE });
  keychain.failWrites = true;
  await tap("Connect to sync.home.example");
  expect(screen()).toContain("Ask for a new pairing link");
  expect(ownServer()).toBeNull();
});
