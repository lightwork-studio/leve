// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conflict } from "../src/data/conflicts.ts";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import {
  chooseBuiltInServer,
  chooseOwnServer,
  forgetServerChoice,
  ownServer,
} from "../src/sync/own-server-store.ts";
import { SyncHost } from "../src/sync/sync-host.tsx";
import { signInReminderDue } from "../src/sync/sync-preferences.ts";
import type { SyncSessionOptions, SyncStatus } from "../src/sync/sync-session.ts";
import { clerk } from "./support/clerk-expo.ts";
import { files } from "./support/expo-file-system.ts";
import { keychain } from "./support/expo-secure-store.ts";

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
    moveLocalData() {
      this.calls.push("move");
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
  builtInServerConfigured: () => true,
  ownServerAvailable: () => true,
}));
const data = vi.hoisted(() => ({
  account: null as string | null,
  /** The server the phone's data belongs to. */
  server: null as string | null,
  workout: false,
  unsynced: false,
  workouts: 3,
  version: 1,
  exported: 0,
  resets: [] as boolean[],
  unsyncedCount: 0,
  unavailableRecords: false,
  store: {
    activeWorkout: () => (data.workout ? { id: "w" } : null),
    syncState: () => ({ account: data.account, server: data.server }),
    hasUnsyncedWork: () => data.unsynced,
    hasUnavailableRecords: () => data.unavailableRecords,
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
    server: null,
    workout: false,
    unsynced: false,
    workouts: 3,
    version: 1,
    exported: 0,
    resets: [],
    unsyncedCount: 0,
    unavailableRecords: false,
  });
  Object.assign(pending, { conflicts: [], settled: [], refuse: null });
  Object.assign(route, { path: "/", pushed: [] });
  sessions.created.length = 0;
  keychain.reset();
  forgetServerChoice();
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

describe("a server the person paired", () => {
  const home = {
    server: "https://sync.home.example",
    account: "acc-home",
    device: "dev-1",
    token: "device-token",
  };

  it("syncs with it on the phone's own token, without a Clerk sign-in", async () => {
    clerk.signedIn = false;
    chooseOwnServer(home);
    await render();
    expect(session().options).toMatchObject({ server: home.server, account: "acc-home" });
    expect(await session().options.token(true)).toBe("device-token");
    // The token is kept in the keychain, for this phone only, readable once it has been unlocked.
    expect([...keychain.items.values()][0]?.options).toEqual({
      keychainAccessible: "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY",
    });
  });

  it("says when the server no longer accepts the phone, and offers no Apple sign-in", async () => {
    chooseOwnServer(home);
    await render();
    await report({ prompt: { kind: "sign_in" } });
    expect(screen()).toContain("sync.home.example no longer accepts this phone");
    expect(screen()).not.toContain("Sign in again");
    await tap("Open Settings");
    expect(route.pushed).toEqual(["/settings"]);
    expect(screen()).not.toContain("no longer accepts");
  });

  it("keeps unsynced changes by switching back to the server they belong to", async () => {
    chooseOwnServer(home);
    await render();
    // The data belongs to the build's own server, where switching back goes.
    data.server = "https://sync.test";
    data.account = "user_1";
    data.unsyncedCount = 2;
    await report({ prompt: { kind: "switch", reason: "server" } });
    expect(screen()).toContain("2 changes that haven't reached the previous server");
    expect(screen()).not.toContain("Keep them and sign out");
    await tap("Switch back");
    // Back on the build's own server, signed in with Clerk.
    expect(ownServer()).toBeNull();
    expect(session().options).toMatchObject({ server: "https://sync.test", account: "user_1" });
  });

  it("offers going back to the paired server after leaving it for the build's own", async () => {
    chooseOwnServer(home);
    chooseBuiltInServer();
    await render();
    data.server = home.server;
    data.account = home.account;
    data.unsyncedCount = 1;
    await report({ prompt: { kind: "switch", reason: "server" } });
    await tap("Switch back");
    expect(ownServer()).toEqual(home);
    expect(session().options).toMatchObject({ server: home.server });
  });

  it("restarts syncing when another server is paired", async () => {
    chooseOwnServer(home);
    await render();
    const first = session();
    await act(async () =>
      chooseOwnServer({
        ...home,
        server: "https://other.example",
        device: "d2",
        token: "other-token",
      }),
    );
    expect(first.calls).toContain("stop");
    expect(session().options.server).toBe("https://other.example");
    // The old session, should it still ask, gets the old server's token, never the new one's.
    expect(await first.options.token(false)).toBe("device-token");
    expect(await session().options.token(false)).not.toBe(await first.options.token(false));
  });

  it("offers switching back only to where the phone's data belongs", async () => {
    // Paired once, then back on the build's own server; the data is a Clerk account's.
    chooseOwnServer(home);
    chooseBuiltInServer();
    data.server = "https://sync.test";
    data.account = "user_0";
    await render();
    data.unsyncedCount = 1;
    await report({ prompt: { kind: "switch", reason: "account" } });
    expect(screen()).toContain("Keep them and sign out");
    expect(screen()).not.toContain("switch back");
  });

  it("offers no way back when the data belongs to a server neither choice is", async () => {
    chooseOwnServer({ ...home, server: "https://third.example", device: "d3" });
    chooseOwnServer(home);
    data.server = "https://sync.test";
    data.account = "user_1";
    await render();
    data.unsyncedCount = 1;
    await report({ prompt: { kind: "switch", reason: "server" } });
    expect(screen()).toContain("Bring them to this server");
    expect(screen()).not.toContain("Switch back");
  });

  it("syncs nowhere while the keychain can't be read", async () => {
    chooseOwnServer(home);
    forgetServerChoice();
    keychain.failReads = true;
    await render();
    expect(sessions.created).toEqual([]);
    keychain.failReads = false;
  });
  it("never falls back to Leve if the keychain unlocks between reads", async () => {
    chooseOwnServer(home);
    forgetServerChoice();
    keychain.failNextRead = true;

    await render();
    expect(sessions.created).toEqual([]);
    await act(async () => {
      for (const listener of appState.listeners) listener("active");
    });
    expect(sessions.created.map((entry) => entry.options.server)).toEqual([home.server]);
  });

  it("shows conflicts for the paired account after a server switch is settled", async () => {
    chooseOwnServer(home);
    data.account = "user_1";
    data.server = "https://sync.test";
    pending.conflicts = [folderConflict("folder", "Training")];
    await render();
    expect(screen()).not.toContain("Training");

    data.account = home.account;
    data.server = home.server;
    await report({ lastSynced: Date.now() });
    expect(screen()).toContain("Training");
  });

  it("doesn't offer to switch back into a different Clerk account", async () => {
    data.server = "https://sync.test";
    data.account = "user_0";
    data.unsyncedCount = 1;
    chooseOwnServer(home);
    await render();
    await report({ prompt: { kind: "switch", reason: "server" } });
    expect(screen()).not.toContain("Switch back");
  });

  it("offers to bring the phone's data along to another server, even with all of it synced", async () => {
    chooseOwnServer(home);
    data.server = "https://sync.test";
    data.account = "user_1";
    await render();
    data.unsyncedCount = 0;
    await report({ prompt: { kind: "switch", reason: "server" } });
    expect(screen()).toContain(
      "Bringing your data adds it to account “acc-home” on sync.home.example.",
    );
    expect(screen()).toContain("That server keeps its copy.");
    await tap("Bring them to this server");
    expect(session().calls).toContain("move");
    expect(session().calls).not.toContain("replace");
  });

  it("starts from the new server's data only when asked", async () => {
    chooseOwnServer(home);
    data.server = "https://sync.test";
    data.account = "user_1";
    await render();
    data.unsyncedCount = 3;
    await report({ prompt: { kind: "switch", reason: "server" } });
    await tap("Delete 3 changes and start over");
    expect(screen()).toContain("Delete unsynced changes?");
    expect(session().calls).not.toContain("replace");
    await tap("Delete and start over");
    expect(session().calls).toContain("replace");
    expect(session().calls).not.toContain("move");
  });
  it("asks for an update instead of offering to move unreadable records", async () => {
    chooseOwnServer(home);
    data.server = "https://sync.test";
    data.account = "user_1";
    data.unavailableRecords = true;
    try {
      await render();
      await report({ prompt: { kind: "switch", reason: "server" } });
      expect(screen()).toContain("Update Leve before moving");
      expect(screen()).not.toContain("Bring them to this server");
      expect(screen()).toContain("Save a copy first");
    } finally {
      data.unavailableRecords = false;
    }
  });
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

it("asks again after leaving a review screen it was already on", async () => {
  route.path = "/history";
  pending.conflicts = [
    {
      ...folderConflict("workout:w1", "Leg Day"),
      subtitle: null,
      review: {
        target: { pathname: "/(tabs)/history" },
        message: "Deleted on this phone, but changed in your account since.",
      },
    },
  ];
  await render();
  await tap("Review it");
  expect(screen()).toBe("");
  route.path = "/";
  await render();
  await render();
  expect(screen()).toContain("Review it");
});
