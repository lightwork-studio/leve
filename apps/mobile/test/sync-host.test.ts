// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conflict } from "../src/data/conflicts.ts";
import {
  forgetDevicePreferences,
  writeDevicePreference,
} from "../src/data/device-preference-store.ts";
import {
  chooseBuiltInServer,
  chooseOwnServer,
  forgetServerChoice,
  ownServer,
} from "../src/sync/own-server-store.ts";
import { turnSyncOff } from "../src/sync/sync-destination.ts";
import { SyncHost } from "../src/sync/sync-host.tsx";
import {
  setSignedOutOnPurpose,
  setSyncPaused,
  signedOutOnPurpose,
  syncPaused,
} from "../src/sync/sync-preferences.ts";
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
/** Whether the build has a sync server of its own. */
const config = vi.hoisted(() => ({ builtIn: true }));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncEnabled: () => true,
  syncServerUrl: "https://sync.test",
  builtInServerConfigured: () => config.builtIn,
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
  config.builtIn = true;
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

it("stops the session in local mode and does not restart it with the retained Apple account", async () => {
  data.account = "user_1";
  data.server = "https://sync.test";
  await render();
  const active = session();
  await act(async () => turnSyncOff());
  expect(active.calls).toContain("stop");
  expect(screen()).toContain("Changes stay on this phone");
  expect(clerk.signedIn).toBe(true);

  // The local destination, rather than the pause bit or the Apple session, gates syncing.
  await act(async () => setSyncPaused(false));
  forgetDevicePreferences();
  forgetServerChoice();
  await render();
  expect(sessions.created).toHaveLength(1);
  expect(screen()).not.toContain("Your sign-in has run out");
});
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

it("can't put off combining: signing out keeps the data here, sending and deleting nothing", async () => {
  clerk.signedIn = true;
  await render();
  await report({ prompt: { kind: "combine" } });
  expect(screen()).not.toContain("Not now");
  expect(document.querySelector("[aria-label=Cancel]")).toBeNull();
  await tap("Keep them here and sign out");
  expect(clerk.calls).toContain("signOut");
  expect(session().calls).not.toContain("combine");
  expect(session().calls).not.toContain("replace");
  // The phone never synced: it is simply on its own again, with nothing to say.
  await render();
  expect(screen()).toBe("");
  expect(data.resets).toEqual([]);
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

it("can't put off the account question, and says so when signing out fails", async () => {
  clerk.signedIn = true;
  clerk.signOutFails = true;
  data.unsyncedCount = 2;
  await render();
  await report({ prompt: { kind: "switch", reason: "account" } });
  expect(screen()).not.toContain("Not now");
  await tap("Keep them and sign out");
  expect(screen()).toContain("Signing out didn't work.");
  // A failed sign-out isn't taken for one made on purpose.
  expect(signedOutOnPurpose()).toBe(false);
  // Still asking: nothing was decided.
  expect(screen()).toContain("Delete and switch");
  expect(session().calls).not.toContain("replace");
  // Offline, signing out may keep failing: pausing sync is the way out, deleting nothing.
  await tap("Pause sync");
  expect(syncPaused()).toBe(true);
  expect(screen()).toContain("Sync paused");
  expect(session().calls).not.toContain("replace");
});

it("says on every screen that changes kept for another account aren't syncing", async () => {
  clerk.signedIn = true;
  data.account = "user_0";
  data.unsyncedCount = 2;
  await render();
  await report({ prompt: { kind: "switch", reason: "account" } });
  await tap("Keep them and sign out");
  await render();
  expect(screen()).toContain("Signed out");
  expect(screen()).toContain("New workouts and changes stay on this phone until you sign in.");
  await tap("Sign in");
  expect(route.pushed).toEqual(["/settings"]);
});

it("holds questions back only for a workout logged on this phone, and says one is waiting", async () => {
  clerk.signedIn = true;
  // This phone has noted that no workout of its own runs.
  writeDevicePreference("sync.workoutHere", "");
  // A workout started on another phone synced here: it doesn't hold anything back.
  data.workout = true;
  await render();
  await report({ prompt: { kind: "update" } });
  expect(screen()).toContain("This version of Leve can't sync anymore.");
  expect(session().options.loggingHere?.()).toBe(false);

  // Logged on this phone: nothing covers it, and a note says a question waits.
  await act(async () => writeDevicePreference("sync.workoutHere", "w"));
  expect(screen()).not.toContain("This version of Leve can't sync anymore.");
  expect(screen()).toContain("Sync has a question for you. It comes up once this workout ends.");
  expect(session().options.loggingHere?.()).toBe(true);

  // Open on its live screen here counts too, even before anything is logged on it.
  await act(async () => writeDevicePreference("sync.workoutHere", ""));
  route.path = "/workout/active";
  await render();
  expect(screen()).toContain("It comes up once this workout ends.");

  // Ended: the question comes up straight away.
  data.workout = false;
  await render();
  expect(screen()).toContain("This version of Leve can't sync anymore.");
});

it("can't put off an update: pausing sync is the way out, and every screen says so", async () => {
  clerk.signedIn = true;
  await render();
  await report({ prompt: { kind: "update" } });
  expect(screen()).not.toContain("Not now");
  expect(document.querySelector("[aria-label='Not now']")).toBeNull();
  await tap("Pause sync");
  expect(syncPaused()).toBe(true);
  // The session stops, nothing is asked, and the note stays.
  expect(session().calls).toContain("stop");
  const sessionsWhilePaused = sessions.created.length;
  expect(screen()).toContain("Sync paused");
  expect(screen()).toContain("New workouts and changes stay on this phone until you resume.");
  await act(async () => {
    for (const listener of appState.listeners) listener("active");
  });
  await render();
  expect(sessions.created).toHaveLength(sessionsWhilePaused);
  expect(screen()).toContain("Sync paused");

  await tap("Resume");
  expect(syncPaused()).toBe(false);
  expect(sessions.created).toHaveLength(sessionsWhilePaused + 1);
  expect(screen()).not.toContain("Sync paused");
});

it("asks to sign in again whenever the sign-in ran out, with pausing as the way out", async () => {
  data.account = "user_1";
  clerk.signedIn = false;
  // What an earlier version's "Remind me later" or "Ignore" saved no longer holds the question back.
  writeDevicePreference("sync.signInReminder", new Date(Date.now() + 60 * 60_000).toISOString());
  await render();
  expect(screen()).toContain("Until you sign in again, new workouts and changes stay only on this");
  writeDevicePreference("sync.signInReminder", "off");
  await render();
  expect(screen()).toContain("Until you sign in again, new workouts and changes stay only on this");
  expect(screen()).not.toContain("Remind me later");
  expect(screen()).not.toContain("Ignore");

  await tap("Pause sync");
  await render();
  expect(screen()).toContain("Sync paused");
  await tap("Resume");
  await render();
  expect(screen()).toContain("Your sign-in has run out.");
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

it("says on every screen when the sync server needs an update, with pausing as the way out", async () => {
  clerk.signedIn = true;
  await render();
  await report({ serverOutdated: true });
  expect(screen()).toContain("Your sync server needs an update before this phone can sync.");
  await tap("Pause");
  expect(syncPaused()).toBe(true);
  expect(screen()).toContain("Sync paused");
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
    pending.conflicts = [folderConflict("folder", "Training")];
    expect(screen()).toContain("sync.home.example no longer accepts this phone");
    expect(screen()).not.toContain("Sign in again");
    await tap("Open Settings");
    expect(route.pushed).toEqual(["/settings"]);
    expect(screen()).not.toContain("Open Settings");
    expect(screen()).not.toContain("Training");
    route.path = "/settings";
    await act(async () => {
      for (const listener of appState.listeners) listener("active");
    });
    expect(screen()).toContain("Connect again in Settings using a new pairing link.");
    await report({ prompt: { kind: "combine" } });
    expect(screen()).toContain("Your account already has data");
    expect(screen()).toContain("Pausing sync keeps them on this phone only.");
  });

  it("can't put off connecting again: leaving Settings unconnected asks again, or sync pauses", async () => {
    chooseOwnServer(home);
    route.path = "/";
    await render();
    await report({ prompt: { kind: "sign_in" } });
    expect(screen()).not.toContain("Not now");
    await tap("Open Settings");
    route.path = "/history";
    await render();
    expect(screen()).toContain("Open Settings");
    await tap("Open Settings");
    route.path = "/settings";
    await render();
    expect(screen()).toContain("Connect again in Settings using a new pairing link.");
    expect(screen()).not.toContain("Open Settings");
    route.path = "/";
    await render();
    expect(screen()).toContain("no longer accepts this phone");
    await tap("Pause sync");
    await render();
    expect(syncPaused()).toBe(true);
    expect(screen()).toContain("Sync paused");
  });

  it("keeps never-synced data on the phone by pausing, not by leaving for another server", async () => {
    const other = { ...home, server: "https://other.example", device: "d2" };
    chooseOwnServer(other);
    chooseOwnServer(home);
    await render();
    await report({ prompt: { kind: "combine" } });
    expect(screen()).toContain("Pausing sync keeps them on this phone only.");
    expect(screen()).not.toContain("disconnect");
    expect(screen()).not.toContain("sign out");
    await tap("Pause sync");
    await render();
    expect(syncPaused()).toBe(true);
    expect(ownServer()).toEqual(home);
    expect(session().calls).not.toContain("combine");
    expect(session().calls).not.toContain("replace");
    forgetDevicePreferences();
    expect(syncPaused()).toBe(true);
  });

  it("warns when a paired Combine pause only lasts until restart and lets it be saved again", async () => {
    const preferences = "document/leve-device-preferences.json";
    files.set(preferences, "invalid");
    chooseOwnServer(home);
    await render();
    await report({ prompt: { kind: "combine" } });
    await tap("Pause sync");
    expect(session().calls).toContain("stop");
    expect(screen()).toContain("Sync can restart when you reopen the app.");
    files.set(preferences, "{}");
    await tap("Save pause");
    expect(screen()).not.toContain("Sync can restart when you reopen the app.");
    forgetDevicePreferences();
    expect(syncPaused()).toBe(true);
  });

  it.each([false, true])(
    "offers a way back when leaving for Leve while signed out (previous sign-out: %s)",
    async (signedOut) => {
      chooseOwnServer(home);
      chooseBuiltInServer();
      clerk.signedIn = false;
      setSignedOutOnPurpose(signedOut);
      data.server = home.server;
      data.account = home.account;
      await render();
      expect(screen()).not.toContain("Your sign-in has run out");
      expect(screen()).toContain("This phone's data belongs to sync.home.example");
      await tap("Switch back");
      expect(ownServer()).toEqual(home);
    },
  );

  it("says so when a paired server was left in a build without a server of its own", async () => {
    config.builtIn = false;
    chooseOwnServer(home);
    chooseBuiltInServer();
    data.server = home.server;
    data.account = home.account;
    await render();
    expect(screen()).toContain("Not syncing");
    expect(screen()).toContain("This phone's data belongs to sync.home.example");
    keychain.failWrites = true;
    await tap("Switch back");
    expect(ownServer()).toBeNull();
    expect(screen()).toContain("Switching back didn't work. Try again.");
    keychain.failWrites = false;
    await tap("Switch back");
    await render();
    expect(ownServer()).toEqual(home);
    expect(session().options).toMatchObject({ server: home.server });
  });

  it("offers pausing sync, not Not now, when another server's data has nowhere to go back to", async () => {
    chooseOwnServer(home);
    await render();
    // The data belongs to a server this phone no longer has a pairing for.
    data.server = "https://gone.example";
    data.account = "someone";
    data.unsyncedCount = 1;
    await report({ prompt: { kind: "switch", reason: "server" } });
    expect(screen()).toContain("Bring them to this server");
    expect(screen()).not.toContain("Not now");
    expect(screen()).not.toContain("switch back");
    await tap("Pause sync");
    await render();
    expect(syncPaused()).toBe(true);
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
    await tap("Keep them and switch back");
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
    await tap("Keep them and switch back");
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
    expect(screen()).not.toContain("switch back");
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
    expect(screen()).not.toContain("switch back");
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

it("waits for this phone's workout to end, and says why a choice was refused", async () => {
  pending.conflicts = [folderConflict("routine_folder:f1", "Push")];
  data.workout = true;
  writeDevicePreference("sync.workoutHere", "w");
  await render();
  expect(screen()).not.toContain("Changed in two places");
  expect(screen()).toContain("It comes up once this workout ends.");
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

it("can't keep a phone version that can't be kept", async () => {
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

it("offers trying a refused change again, saying so, with pausing still on offer", async () => {
  clerk.signedIn = true;
  pending.conflicts = [
    {
      ...folderConflict("routine_folder:f1", "Push"),
      phone: {
        lines: [{ label: "Name", value: "Push B (couldn't be saved)" }],
        choosable: true,
        confirm: "Try again",
        retry: "Your account didn't take this change. Trying again sends it unchanged.",
      },
      account: {
        lines: [{ label: "Name", value: "Push" }],
        choosable: true,
        confirm: "Undo my change",
      },
    },
  ];
  await render();
  expect(screen()).toContain("Trying again sends it unchanged.");
  expect(screen()).toContain("Pause sync");
  await tap("On this phone: Name Push B (couldn't be saved)");
  await tap("Try again");
  expect(pending.settled).toEqual([["routine_folder:f1", "phone"]]);
});

it("offers pausing sync for a conflict whose phone version can't be kept yet", async () => {
  clerk.signedIn = true;
  pending.conflicts = [
    {
      ...folderConflict("routine_folder:f1", "Push"),
      phone: {
        lines: [{ label: "Name", value: "Push B" }],
        choosable: false,
        confirm: "Keep this version",
        why: "Your sync server needs an update before it can take this version.",
      },
    },
  ];
  await render();
  expect(screen()).toContain("Your sync server needs an update");
  await tap("Pause sync");
  expect(pending.settled).toEqual([]);
  expect(screen()).not.toContain("Changed in two places");
  expect(screen()).toContain("Sync paused");
  // A conflict both sides of which can be kept offers no pause.
  await tap("Resume");
  pending.conflicts = [folderConflict("routine_folder:f2", "Pull")];
  await render();
  expect(screen()).toContain("Pull B");
  expect(screen()).not.toContain("Pause sync");
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
  // No choosing here: reviewing, or pausing sync if the review can't settle it yet.
  expect(screen()).not.toContain("Choose a version");
  expect(screen()).toContain("Pause sync");
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

it("asks once more, with a copy offered, before deleting work kept nowhere else", async () => {
  pending.conflicts = [
    {
      ...folderConflict("workout:w1|workout:w1", "Offline Day"),
      phone: {
        lines: [{ label: "Holds", value: "1 exercise · 3 sets" }],
        choosable: false,
        confirm: "Keep the workout",
        why: "This phone's change couldn't be saved in your account.",
      },
      account: {
        lines: [{ label: "Workout", value: "Not in your account" }],
        choosable: true,
        confirm: "Delete it",
        warning:
          "Your account has no copy of this phone's version, so deleting it can't be undone.",
      },
    },
  ];
  await render();
  await tap("In your account: Workout Not in your account");
  await tap("Delete it");
  expect(pending.settled).toEqual([]);
  expect(screen()).toContain("so deleting it can't be undone");
  // A double tap doesn't count as the second confirm.
  await tap("Delete it for good");
  expect(pending.settled).toEqual([]);
  await tap("Save a copy first");
  expect(data.exported).toBe(1);
  expect(screen()).toContain("A copy is saved.");
  await act(() => new Promise((resolve) => setTimeout(resolve, 650)));
  await tap("Delete it for good");
  expect(pending.settled).toEqual([["workout:w1|workout:w1", "account"]]);
});

it("shows the same note on screens drawn above the app, such as the live workout", async () => {
  clerk.signedIn = true;
  const { SyncNoteBanner } = await import("../src/sync/sync-note.tsx");
  const above = document.createElement("div");
  document.body.append(above);
  const modal = createRoot(above);
  await act(async () => modal.render(h(SyncNoteBanner)));
  expect(above.textContent).toBe("");
  data.workout = true;
  writeDevicePreference("sync.workoutHere", "w");
  await render();
  await report({ prompt: { kind: "update" } });
  expect(above.textContent).toContain("It comes up once this workout ends.");
  data.workout = false;
  await render();
  expect(above.textContent).toBe("");
  await act(async () => modal.unmount());
  above.remove();
});
