// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Conflict } from "../src/data/conflicts.ts";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import { SyncHost } from "../src/sync/sync-host.tsx";
import { signInReminderDue } from "../src/sync/sync-preferences.ts";
import type { SyncSessionOptions, SyncStatus } from "../src/sync/sync-session.ts";
import { clerk } from "./support/clerk-expo.ts";
import { files } from "./support/expo-file-system.ts";

/* The prompts sync shows, driven by a stand-in session whose status the tests set. */

const sessions = vi.hoisted(() => ({
  created: [] as {
    options: SyncSessionOptions;
    calls: string[];
    report(status: Partial<SyncStatus>): void;
  }[],
}));
vi.mock("../src/sync/sync-session.ts", () => ({
  unsyncedChanges: () => data.unsyncedCount,
  SyncSession: class {
    calls: string[] = [];
    constructor(public options: SyncSessionOptions) {
      sessions.created.push({
        options,
        calls: this.calls,
        report: (status) =>
          options.onStatus({ prompt: null, lastSynced: null, failingSince: null, ...status }),
      });
    }
    start() {}
    stop() {
      this.calls.push("stop");
    }
    setForeground() {}
    nudge() {
      this.calls.push("nudge");
    }
    combine() {
      this.calls.push("combine");
    }
    replaceLocalData() {
      this.calls.push("replace");
    }
    retry() {
      this.calls.push("retry");
    }
  },
}));
const pending = vi.hoisted(() => ({
  conflicts: [] as Conflict[],
  settled: [] as [string, string][],
  refuse: null as string | null,
}));
vi.mock("../src/data/conflicts.ts", () => ({
  conflicts: () => pending.conflicts,
  settleConflict: (_store: unknown, shown: Conflict, side: string) => {
    if (pending.refuse) throw Error(pending.refuse);
    pending.settled.push([shown.key, side]);
    pending.conflicts = pending.conflicts.filter((item) => item.key !== shown.key);
  },
}));
const route = vi.hoisted(() => ({ path: "/", pushed: [] as unknown[] }));
vi.mock("expo-router", () => ({
  router: {
    push: (target: unknown) => {
      route.pushed.push(target);
    },
  },
  usePathname: () => route.path,
}));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncEnabled: () => true,
  syncServerUrl: "https://sync.test",
}));
const data = vi.hoisted(() => ({
  account: null as string | null,
  workout: false,
  unsynced: false,
  workouts: 3,
  version: 1,
  exported: 0,
  resets: [] as boolean[],
  unsyncedCount: 0,
  store: {
    activeWorkout: () => (data.workout ? { id: "w" } : null),
    syncState: () => ({ account: data.account }),
    hasUnsyncedWork: () => data.unsynced,
    db: { get: () => ({ n: data.workouts }) },
  },
}));
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({
    // The same store on every render, as the app's is until it starts over.
    store: data.store,
    version: data.version,
    change: (fn: () => unknown) => fn(),
    reset: async (sampleData: boolean) => {
      data.resets.push(sampleData);
      return true;
    },
    exportData: async () => {
      data.exported += 1;
    },
  }),
}));
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", async () => {
  const web = await vi.importActual<Record<string, unknown>>("react-native-web");
  return {
    ...web,
    AppState: {
      currentState: "active",
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appState.listeners.add(listener);
        return { remove: () => appState.listeners.delete(listener) };
      },
    },
  };
});
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));
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
vi.mock("../src/ui/motion.ts", () => ({
  emphasised: undefined,
  pressScale: 1,
  spring: {},
  fade: undefined,
}));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children, ...props }: { children?: ReactNode; role?: string }) =>
    h("div", { role: props.role }, children),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  files.clear();
  forgetDevicePreferences();
  clerk.reset();
  clerk.signedIn = true;
  Object.assign(data, {
    account: null,
    workout: false,
    unsynced: false,
    workouts: 3,
    version: 1,
    exported: 0,
    resets: [],
    unsyncedCount: 0,
  });
  Object.assign(pending, { conflicts: [], settled: [], refuse: null });
  Object.assign(route, { path: "/", pushed: [] });
  sessions.created.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const render = () => act(() => root.render(h(SyncHost)));
/** Everything on screen, modals included. */
const screen = () => document.body.textContent ?? "";
const session = () => {
  const current = sessions.created.at(-1);
  if (!current) throw new Error("no session");
  return current;
};
async function report(status: Partial<SyncStatus>) {
  await act(async () => session().report(status));
}
async function tap(label: string) {
  const target = [
    ...document.querySelectorAll<HTMLElement>("button, [role=button], [role=radio]"),
  ].find(
    (element) =>
      element.textContent?.includes(label) || element.getAttribute("aria-label") === label,
  );
  if (!target) throw Error(`Missing ${label}`);
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("runs a session for the signed-in account and shows nothing while all is well", async () => {
  await render();
  expect(session().options).toMatchObject({ account: "user_1", server: "https://sync.test" });
  expect(await session().options.token(false)).toBe("token-user_1");
  // Signed in but no token to be had: offline, not a sign-in problem.
  clerk.noToken = true;
  await expect(session().options.token(false)).rejects.toThrow();
  clerk.noToken = false;
  await report({ lastSynced: Date.now() });
  expect(screen()).toBe("");

  clerk.signedIn = false;
  await render();
  expect(session().calls).toContain("stop");
});

it("asks to combine, and answers with the person's choice", async () => {
  await render();
  await report({ prompt: { kind: "combine" } });
  expect(screen()).toContain("This phone has 3 workouts that aren't in your account yet.");
  await tap("Add to my account");
  expect(session().calls).toContain("combine");

  await tap("Replace with my account's data");
  expect(screen()).toContain("This deletes everything on this phone, including 3 workouts");
  await tap("Save a copy first");
  expect(data.exported).toBe(1);
  expect(screen()).toContain("A copy is saved.");
  await tap("Delete and replace");
  expect(session().calls).toContain("replace");
});

it("lets the combine question wait, sending and deleting nothing", async () => {
  await render();
  await report({ prompt: { kind: "combine" } });
  await tap("Not now");
  expect(screen()).toBe("");
  expect(session().calls).not.toContain("combine");
  expect(session().calls).not.toContain("replace");
});

it("asks the next account's question even after Not now on the last one", async () => {
  await render();
  await report({ prompt: { kind: "combine" } });
  await tap("Not now");
  expect(screen()).toBe("");
  clerk.userId = "user_2";
  await render();
  expect(session().options.account).toBe("user_2");
  await report({ prompt: { kind: "combine" } });
  expect(screen()).toContain("aren't in your account yet");
});

it("warns before another account's unsynced changes are deleted", async () => {
  await render();
  data.unsyncedCount = 4;
  await report({ prompt: { kind: "switch", reason: "account" } });
  expect(screen()).toContain(
    "4 changes on this phone belong to the account that was signed in before and haven't synced.",
  );
  // Counted when shown: work done since sync asked counts too.
  data.unsyncedCount = 30;
  await render();
  expect(screen()).toContain("30 changes on this phone belong");
  await tap("Keep them and sign out");
  expect(clerk.calls).toContain("signOut");
  expect(session().calls).not.toContain("replace");
});

it("lets the account question wait, deleting nothing", async () => {
  clerk.signOutFails = true;
  data.unsyncedCount = 2;
  await render();
  await report({ prompt: { kind: "switch", reason: "account" } });
  await tap("Keep them and sign out");
  expect(screen()).toContain("Signing out didn't work.");
  // A failed sign-out doesn't silence the sign-in reminder.
  expect(signInReminderDue(Date.now())).toBe(true);
  await tap("Not now");
  expect(screen()).toBe("");
  expect(session().calls).not.toContain("replace");
});

it("waits until the workout in progress ends", async () => {
  data.workout = true;
  await render();
  await report({ prompt: { kind: "update" } });
  expect(screen()).toBe("");
  data.workout = false;
  await render();
  expect(screen()).toContain("This version of Leve can't sync anymore.");
  // It can be put aside, so the app stays usable for logging, and comes back on return.
  await tap("Not now");
  expect(screen()).toBe("");
  await act(async () => {
    for (const listener of appState.listeners) listener("active");
  });
  expect(screen()).toContain("This version of Leve can't sync anymore.");
});

it("asks to sign in again when the sign-in ran out, and remembers later and ignore", async () => {
  data.account = "user_1";
  clerk.signedIn = false;
  await render();
  expect(screen()).toContain("Until you sign in again, new workouts and changes stay only on this");

  await tap("Remind me later");
  await render();
  expect(screen()).toBe("");
  expect(signInReminderDue(Date.now())).toBe(false);
  expect(signInReminderDue(Date.now() + 25 * 60 * 60_000)).toBe(true);

  files.clear();
  forgetDevicePreferences();
  await render();
  await tap("Ignore");
  await render();
  expect(screen()).toBe("");
  expect(signInReminderDue(Date.now() + 365 * 24 * 60 * 60_000)).toBe(false);
});

it("doesn't ask a phone that never synced to sign in", async () => {
  clerk.signedIn = false;
  await render();
  expect(screen()).toBe("");
});

it("signs in again from the prompt when the server refused the sign-in", async () => {
  data.account = "user_1";
  await render();
  await report({ prompt: { kind: "sign_in" } });
  expect(screen()).toContain("Your sign-in has run out.");
  await tap("Sign in with Apple");
  expect(clerk.calls).toEqual(["signOut", "apple", "setActive sess_1"]);
});

it("notes a day without syncing only when changes are waiting", async () => {
  await render();
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60_000;
  await report({ lastSynced: twoDaysAgo });
  expect(screen()).toBe("");
  data.unsynced = true;
  await report({ lastSynced: twoDaysAgo });
  expect(screen()).toContain("Changes haven't synced since");
  await report({ lastSynced: Date.now() });
  expect(screen()).toBe("");
});

const folderConflict = (key: string, title: string): Conflict => ({
  key,
  title,
  subtitle: "Folder",
  records: [],
  phone: {
    lines: [{ label: "Name", value: `${title} B` }],
    choosable: true,
    confirm: "Keep this version",
  },
  account: {
    lines: [{ label: "Name", value: `${title} A` }],
    choosable: true,
    confirm: "Keep this version",
  },
});

it("goes through conflicts one at a time, with nothing chosen in advance", async () => {
  pending.conflicts = [
    folderConflict("routine_folder:f1", "Push"),
    folderConflict("routine_folder:f2", "Pull"),
  ];
  await render();
  expect(screen()).toContain("Changed in two places");
  expect(screen()).toContain("1 of 2");
  expect(screen()).toContain("Push B");
  expect(screen()).toContain("Push A");
  // Nothing chosen yet: the confirm can't be pressed, and there is no way to put it off.
  await tap("Choose a version");
  expect(pending.settled).toEqual([]);
  expect(document.querySelector("[aria-label=Cancel]")).toBeNull();
  expect(screen()).not.toContain("Not now");

  await tap("In your account: Name Push A");
  await tap("Keep this version");
  expect(pending.settled).toEqual([["routine_folder:f1", "account"]]);
  await render();
  expect(screen()).toContain("2 of 2");
  expect(screen()).toContain("Pull B");
  // The next one starts with nothing chosen again.
  await tap("Choose a version");
  expect(pending.settled).toHaveLength(1);
  await tap("On this phone: Name Pull B");
  await tap("Keep this version");
  expect(pending.settled).toEqual([
    ["routine_folder:f1", "account"],
    ["routine_folder:f2", "phone"],
  ]);
  await render();
  expect(screen()).toBe("");
});

it("waits for the workout to end, and says why a choice was refused", async () => {
  pending.conflicts = [folderConflict("routine_folder:f1", "Push")];
  data.workout = true;
  await render();
  expect(screen()).toBe("");
  data.workout = false;
  await render();
  pending.refuse = "This changed in the meantime. Have a look at the latest versions.";
  await tap("On this phone: Name Push B");
  await tap("Keep this version");
  expect(screen()).toContain("This changed in the meantime.");
  expect(pending.settled).toEqual([]);
  // Nothing stays picked: the person looks again before choosing.
  expect(screen()).toContain("Choose a version");
});

it("can't keep a change the server refused", async () => {
  pending.conflicts = [
    {
      ...folderConflict("routine_folder:f1", "Push"),
      phone: {
        lines: [{ label: "Name", value: "Couldn't be saved" }],
        choosable: false,
        confirm: "",
        why: "This phone's change couldn't be saved in your account.",
      },
      account: {
        lines: [{ label: "Name", value: "Push" }],
        choosable: true,
        confirm: "Undo my change",
      },
    },
  ];
  await render();
  expect(screen()).toContain("couldn't be saved in your account");
  await tap("On this phone: Name Couldn't be saved");
  await tap("Choose a version");
  expect(pending.settled).toEqual([]);
  await tap("In your account: Name Push");
  await tap("Undo my change");
  expect(pending.settled).toEqual([["routine_folder:f1", "account"]]);
});

it("leads a conflict reviewed on its screen there, stays away meanwhile, and asks again on leaving", async () => {
  pending.conflicts = [
    {
      ...folderConflict("workout:w1", "Pull Day"),
      subtitle: null,
      review: {
        target: { pathname: "/workout/[id]", params: { id: "w1" } },
        message: "Deleted in your account, but this phone has changes in it.",
      },
    },
  ];
  await render();
  expect(screen()).toContain("Deleted in your account, but this phone has changes in it.");
  // No choosing here, and no way around it but reviewing.
  expect(screen()).not.toContain("Choose a version");
  await tap("Review it");
  expect(route.pushed).toEqual([{ pathname: "/workout/[id]", params: { id: "w1" } }]);
  expect(screen()).toBe("");
  route.path = "/workout/w1";
  await render();
  expect(screen()).toBe("");
  // Left the review with the conflict still there: the popup asks again.
  route.path = "/history";
  await render();
  await render();
  expect(screen()).toContain("Review it");
});
