// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  chooseOwnServer,
  forgetServerChoice,
  ownServer,
  previousServer,
} from "../src/sync/own-server-store.ts";
import { SyncServerSection } from "../src/sync/sync-server-section.tsx";
import { keychain } from "./support/expo-secure-store.ts";

/* Choosing the sync server in Settings: pairing with a link, and going back. */

const CODE = "R0zFbfeNwBJAytY_ILQ3qw";
const offered = vi.hoisted(() => ({ own: true, builtIn: true }));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncServerUrl: "https://sync.leve.example",
  builtInServerConfigured: () => offered.builtIn,
  ownServerAvailable: () => offered.own,
}));
vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-constants", () => ({ default: { deviceName: "Alice's iPhone" } }));
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
  offered.own = true;
  offered.builtIn = true;
  requests = [];
  answer = () =>
    new Response(
      JSON.stringify({ account: "acc-1", accountName: "Alice", device: "d", token: "t" }),
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

it("shows the build's own server until another is paired", async () => {
  await render();
  expect(screen()).toContain("Sync server");
  expect(screen()).toContain("sync.leve.example");
  expect(screen()).toContain("Connect to your own server");
  expect(screen()).not.toContain("Use Leve's server");
});

it("pairs with a pasted link, naming the server before it connects", async () => {
  await render();
  await tap("Connect to your own server");
  await tap("Connect");
  expect(screen()).toContain("Paste the whole pairing link");
  expect(requests).toEqual([]);

  await type(`https://sync.home.example/connect#code=${CODE}`);
  expect(screen()).toContain("This phone will sync its workouts with sync.home.example");
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

it("goes back to the build's own server, remembering the paired one", async () => {
  const home = { server: "https://sync.home.example", account: "a", device: "d", token: "t" };
  chooseOwnServer(home);
  await render();
  expect(screen()).toContain("sync.home.example");
  await tap("Use Leve's server");
  expect(ownServer()).toBeNull();
  expect(previousServer()).toEqual(home);
  expect(screen()).toContain("sync.leve.example");
});

it("offers to disconnect when the build has no server of its own, and is absent where not offered", async () => {
  offered.builtIn = false;
  chooseOwnServer({ server: "https://sync.home.example", account: "a", device: "d", token: "t" });
  await render();
  await tap("Disconnect");
  expect(ownServer()).toBeNull();
  expect(screen()).toContain("Workouts stay on this phone");

  offered.own = false;
  await render();
  expect(screen()).toBe("");
});

it("says so when the keychain refuses a change, and keeps the server", async () => {
  chooseOwnServer({ server: "https://sync.home.example", account: "a", device: "d", token: "t" });
  await render();
  keychain.failWrites = true;
  await tap("Use Leve's server");
  expect(screen()).toContain("This phone couldn't save the change");
  expect(ownServer()).toMatchObject({ server: "https://sync.home.example" });
});

it("asks for a new link when the pairing worked but the phone couldn't keep it", async () => {
  await render({ server: "https://sync.home.example", code: CODE });
  keychain.failWrites = true;
  await tap("Connect to sync.home.example");
  expect(screen()).toContain("Ask for a new pairing link");
  expect(ownServer()).toBeNull();
});
