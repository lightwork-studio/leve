import { useAuth, useUser } from "@clerk/expo";
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { router, usePathname } from "expo-router";
import { channel } from "expo-updates";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppState, Linking, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signInProblem, useAppleSignIn } from "../account/apple-sign-in.ts";
import { buildInfo } from "../build-info.ts";
import { useAppData } from "../data/app-data.tsx";
import { conflicts, type ReviewTarget } from "../data/conflicts.ts";
import { subscribeDevicePreferences } from "../data/device-preference-store.ts";
import { startNotingWorkoutHere, workoutHere } from "../data/workout-here.ts";
import { gutter, radius, space, type } from "../theme.ts";
import { Button } from "../ui/buttons.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { themedStyles, useAppearance, useStyles } from "../ui/themed.ts";
import { ConflictPrompt } from "./conflict-prompt.tsx";
import { type OwnServer, serverLabel } from "./own-server.ts";
import {
  canRestorePairedServer,
  chooseBuiltInServer,
  restorePairedServer,
  switchBack,
} from "./own-server-store.ts";
import {
  builtInServerConfigured,
  ownServerAvailable,
  syncEnabled,
  syncServerUrl,
} from "./sync-config.ts";
import { publishSyncNote, SyncLine, type SyncNote } from "./sync-note.tsx";
import {
  readLastSynced,
  setSignedOutOnPurpose,
  setSyncPaused,
  signedOutOnPurpose,
  syncPaused,
  syncPauseIsTemporary,
  writeLastSynced,
} from "./sync-preferences.ts";
import { SyncSession, type SyncStatus, unsyncedChanges } from "./sync-session.ts";
import { useServerChoice } from "./use-server-choice.ts";

/** The path expo-router reports while `target` is open. */
function reviewPath(target: ReviewTarget): string {
  return target.pathname === "/workout/[id]" ? `/workout/${target.params.id}` : "/history";
}

/** How long sync may fail before the app says that changes aren't syncing. */
export const STALE_AFTER_MS = 24 * 60 * 60_000;
/** How often the time of the last sync is saved, so the note survives a restart. */
const SAVE_SYNCED_MS = 5 * 60_000;

const IDLE: SyncStatus = { prompt: null, lastSynced: null, failingSince: null };

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** How many workouts the phone holds, for the questions below. */
function workoutCount(store: ReturnType<typeof useAppData>["store"]): number {
  return Number(store.db.get("SELECT count(*) AS n FROM records WHERE kind = 'workout'")?.n ?? 0);
}

/** Paths of the workout's own screens, where nothing may cover the logging. */
const LOGGING_PATHS = new Set(["/workout/active", "/workout/finish"]);

/** Where a paired server is connected again. */
const SETTINGS = "/settings";

/**
 * Syncs this phone with the signed-in account while the app runs. It never stops silently:
 * anything that stops sync, for the whole app or for one record, is put to the person, and can't
 * be put off. It asks whether to combine this phone's data with an account that has data, whether
 * to delete unsynced changes when another account signs in, to sign in again, to update the app,
 * and about each conflict. Where an answer can't be given yet, the way out is pausing sync (or,
 * for another account's data, signing out), and while sync isn't running every screen says so.
 * Being offline or a server that is briefly down shows nothing; only a day without syncing does,
 * as a note. Nothing covers a workout being logged on this phone: its questions wait, said in a
 * note, until it ends.
 */
export function SyncHost() {
  const pairing = ownServerAvailable();
  const builtIn = builtInServerConfigured();
  const choice = useServerChoice(pairing || (builtIn && syncEnabled()));
  // If the keychain is locked, wait before choosing which account to sync.
  if (choice === undefined) return null;
  if (choice === "local") return <Disconnected local />;
  const own = pairing && typeof choice === "object" ? choice : null;
  // A new pairing is a new session, even with the same account id.
  if (own && syncEnabled()) {
    const key = `${own.server} ${own.device}`;
    return builtIn ? (
      <PairedSyncWithClerk key={key} own={own} />
    ) : (
      <Sync key={key} connection={ownConnection(own)} />
    );
  }
  if (builtIn && syncEnabled()) return <ClerkSync />;
  // No server to sync with: a paired one was left in a build without one of its own. Data that
  // belongs to an account says so, never silently.
  return pairing ? <Disconnected /> : null;
}

/**
 * This phone's data belongs to a server it isn't syncing with now (left in Settings, or the
 * build's own server chosen without signing in): a note on every screen, with the way back.
 */
function useElsewhereNote(
  bound: { server: string | null; account: string | null } | null,
): SyncNote | null {
  const [failedServer, setFailedServer] = useState<string | null>(null);
  if (!bound || bound.server === null || bound.account === null) return null;
  const server = bound.server;
  const label = serverLabel(server);
  const restore = switchBackToData(bound, null);
  const problem =
    restore && failedServer === server ? " Switching back didn't work. Try again." : "";
  return {
    label: "Not syncing",
    tone: "problem",
    tag: "Not syncing",
    short: `data on ${label}`,
    message: `This phone's data belongs to ${label}. Changes stay on this phone until it syncs there again.${problem}`,
    action: restore
      ? {
          label: "Switch back",
          hint: `Returns to ${label}`,
          onPress: () => {
            try {
              restore();
              setFailedServer(null);
            } catch {
              setFailedServer(server);
            }
          },
        }
      : {
          label: "Settings",
          hint: "Opens Settings to connect a server",
          onPress: () => router.push(SETTINGS),
        },
  };
}

function Disconnected({ local = false }: { local?: boolean }) {
  const { store } = useAppData();
  const boundNote = useElsewhereNote(store.syncState());
  const note: SyncNote | null =
    boundNote ??
    (local
      ? {
          label: "Sync off",
          tone: "quiet",
          tag: "Sync off",
          message: "New workouts and changes stay on this phone.",
          action: {
            label: "Settings",
            hint: "Opens Settings to choose where to sync",
            onPress: () => router.push(SETTINGS),
          },
        }
      : null);
  useEffect(() => publishSyncNote(note));
  useEffect(() => () => publishSyncNote(null), []);
  return note ? <NotSyncing note={note} /> : null;
}

/** Who the phone syncs as, and with which server. */
interface Connection {
  /** The build's own server with a Clerk sign-in, or a server the person paired. */
  kind: "built_in" | "own";
  server: string;
  accountName?: string | undefined;
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  getToken(fresh: boolean): Promise<string | null>;
  signOut(): Promise<void>;
}

/**
 * Whether switching back to the choice before reaches the server and account this phone's data
 * belongs to. Anything else would only move the question to another server.
 */
function switchBackToData(
  bound: { server: string | null; account: string | null },
  builtInAccount: string | null,
): (() => void) | null {
  if (!ownServerAvailable()) return null;
  if (canRestorePairedServer(bound)) return () => restorePairedServer(bound);
  if (builtInAccount !== null && bound.server === syncServerUrl && bound.account === builtInAccount)
    return chooseBuiltInServer;
  return null;
}

/** A paired server: always signed in, with the device token it gave this phone. */
function ownConnection(own: OwnServer): Connection {
  return {
    kind: "own",
    server: own.server,
    accountName: own.accountName ?? own.account,
    isLoaded: true,
    isSignedIn: true,
    userId: own.account,
    getToken: async () => own.token,
    signOut: async () => switchBack(),
  };
}

function PairedSyncWithClerk({ own }: { own: OwnServer }) {
  const { isSignedIn, userId } = useAuth();
  return (
    <Sync connection={ownConnection(own)} builtInAccount={isSignedIn ? (userId ?? null) : null} />
  );
}

function ClerkSync() {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  const { user } = useUser();
  return (
    <Sync
      connection={{
        kind: "built_in",
        server: syncServerUrl,
        accountName: user?.primaryEmailAddress?.emailAddress ?? userId ?? undefined,
        isLoaded,
        isSignedIn: !!isSignedIn,
        userId: userId ?? null,
        getToken: (fresh) => getToken(fresh ? { skipCache: true } : undefined),
        signOut: () => signOut(),
      }}
    />
  );
}

function Sync({
  connection,
  builtInAccount = null,
}: {
  connection: Connection;
  builtInAccount?: string | null;
}) {
  const { isLoaded, isSignedIn, userId, getToken, signOut, server } = connection;
  const own = connection.kind === "own";
  const { store, version, change, reset, exportData } = useAppData();
  const [status, setStatus] = useState<SyncStatus>(IDLE);
  /** A conflict being reviewed on its own screen, and whether that screen has opened yet. */
  const [reviewing, setReviewing] = useState<{
    key: string;
    path: string;
    arrived: boolean;
  } | null>(null);
  /** Settings, opened from "Connect again": on its way, or there. Leaving it asks again. */
  const [reconnecting, setReconnecting] = useState<"going" | "there" | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    setReviewing((current) => {
      if (!current) return current;
      if (pathname === current.path)
        return current.arrived ? current : { ...current, arrived: true };
      // Left the review screen: the popup asks again if it's still unsettled.
      return current.arrived ? null : current;
    });
    // Likewise for Settings, opened to connect a paired server again.
    // (Anywhere else it lands, Settings included and then left, the question comes back.)
    setReconnecting((current) => (current !== null && pathname === SETTINGS ? "there" : null));
  }, [pathname]);
  /** When the last sync was saved: every wait for changes ends in one, every 25 s or so. */
  const lastWritten = useRef(0);
  const session = useRef<SyncSession | null>(null);
  // Re-render when a note of this phone's changes: sync paused, signed out on purpose.
  const [, setPreferences] = useState(0);
  useEffect(() => subscribeDevicePreferences(() => setPreferences((n) => n + 1)), []);
  const paused = syncPaused();
  // A workout runs on every phone of the account once it syncs. Only one logged here (or open on
  // its live screen here) holds questions back; another phone's never does.
  const logging =
    !!store.activeWorkout() && (workoutHere(store) !== null || LOGGING_PATHS.has(pathname));
  // The session outlives renders: it reaches these through refs, and restarts only for another
  // account or store, or when sync is paused or resumed.
  const latest = useRef({ getToken, change, reset, userId, logging });
  latest.current = { getToken, change, reset, userId, logging };

  useEffect(() => {
    // Paused: nothing syncs until the person resumes (every screen says so, see below).
    if (!isLoaded || !isSignedIn || !userId || paused) return;
    const running = new SyncSession({
      store,
      server,
      account: userId,
      app: `leve-preview ${buildInfo.commit}`,
      // Only the account this session syncs: a request still on its way when someone else signs in
      // fails as offline rather than reach the new account.
      token: async (fresh) => {
        if (latest.current.userId !== userId) throw new Error("another account signed in");
        const token = await latest.current.getToken(fresh);
        // Signed in but no token: Clerk couldn't be reached. Offline, not a sign-in problem.
        if (!token) throw new Error("no session token");
        return token;
      },
      onStoreChanged: () => latest.current.change(() => undefined),
      onStatus: (next) => {
        setStatus(next);
        if (next.lastSynced !== null && next.lastSynced - lastWritten.current > SAVE_SYNCED_MS) {
          lastWritten.current = next.lastSynced;
          writeLastSynced(next.lastSynced);
        }
      },
      startOver: () => {
        writeLastSynced(null);
        void latest.current.reset(false);
      },
      lastSynced: readLastSynced(),
      loggingHere: () => latest.current.logging,
      log: (message) => console.warn(message),
    });
    session.current = running;
    running.setForeground(AppState.currentState === "active");
    running.start();
    const watch = AppState.addEventListener("change", (state) =>
      running.setForeground(state === "active"),
    );
    return () => {
      watch.remove();
      running.stop();
      session.current = null;
      setStatus(IDLE);
    };
  }, [isLoaded, isSignedIn, userId, store, server, paused]);

  // Every change to the data passes here; the session sends it shortly, if there is any to send.
  useEffect(() => {
    if (version > 0) session.current?.nudge();
    startNotingWorkoutHere(store);
  }, [version, store]);

  // This phone's data belongs to an account, so its changes are meant to sync.
  const bound = store.syncState();
  const accountData = bound.account !== null;
  const disconnected = useElsewhereNote(
    !own && isLoaded && !isSignedIn && bound.server !== server ? bound : null,
  );
  const prompt = status.prompt;
  const signOutHere = async () => {
    setSignedOutOnPurpose(true);
    try {
      await signOut();
    } catch (error) {
      setSignedOutOnPurpose(false);
      throw error;
    }
  };
  const pause = () => setSyncPaused(true);

  /** The question sync needs answered now, if any. */
  const ask = (): ReactNode => {
    if (prompt?.kind === "update") return <UpdatePrompt onPause={pause} />;
    if (prompt?.kind === "combine")
      return (
        <CombinePrompt
          workouts={workoutCount(store)}
          sampleData={prompt.sampleData === true}
          onCombine={() => session.current?.combine()}
          onReplace={() => session.current?.replaceLocalData()}
          // A paired server has no sign-out that keeps the data here (leaving it goes back to the
          // choice before, which may sync it): pausing sync does.
          {...(own ? {} : { onSignOut: signOutHere })}
          onPause={pause}
          exportData={exportData}
        />
      );
    if (prompt?.kind === "switch") {
      // Keeping the data means going back, when the choice before is where it belongs; on the
      // build's own server, otherwise, signing this account out. With neither, pausing sync.
      const restore = switchBackToData(store.syncState(), builtInAccount);
      const keep = restore ? { onSwitchBack: restore } : own ? {} : { onSignOut: signOutHere };
      if (prompt.reason === "server")
        return (
          <MovePrompt
            server={server}
            account={connection.accountName}
            unsynced={unsyncedChanges(store)}
            canMove={!store.hasUnavailableRecords()}
            onMove={() => session.current?.moveLocalData()}
            onStartOver={() => session.current?.replaceLocalData()}
            {...keep}
            onPause={pause}
            exportData={exportData}
          />
        );
      return (
        <SwitchPrompt
          // Counted now, not when sync asked: work done meanwhile is lost too.
          unsynced={unsyncedChanges(store)}
          onSwitch={() => session.current?.replaceLocalData()}
          {...keep}
          onPause={pause}
          exportData={exportData}
        />
      );
    }
    // A paired server refused this phone: only a new pairing connects it again. Settings, where
    // that happens, stays uncovered.
    if (own && prompt?.kind === "sign_in")
      return pathname === SETTINGS || reconnecting ? null : (
        <RefusedPrompt
          server={server}
          onSettings={() => {
            setReconnecting("going");
            router.push(SETTINGS);
          }}
          onPause={pause}
        />
      );
    // The sign-in ran out (or the server refused it): asked every time, never set aside.
    if (!own && (prompt?.kind === "sign_in" || (isLoaded && !isSignedIn && accountData)))
      return (
        <SignInPrompt
          signedIn={!!isSignedIn}
          signOut={signOut}
          onSignedIn={() => {
            setSignedOutOnPurpose(false);
            session.current?.retry();
          }}
          onPause={pause}
        />
      );
    // Conflicts are settled here and now: one at a time, before the app goes on. Not while the
    // phone's data belongs to another account or server: that question comes first.
    const switching =
      isSignedIn && bound.account !== null && (bound.server !== server || bound.account !== userId);
    const pending = switching ? [] : conflicts(store);
    if (pending.length === 0) return null;
    // While the person is on the screen a conflict sent them to, nothing covers it. Leaving it
    // with the conflict unsettled brings the popup back.
    if (reviewing && pending.some((item) => item.key === reviewing.key)) return null;
    return (
      <ConflictPrompt
        items={pending}
        onReview={(item) => {
          if (!item.review) return;
          const path = reviewPath(item.review.target);
          // Already there (History is a tab): it counts as arrived, so leaving asks again.
          setReviewing({ key: item.key, path, arrived: pathname === path });
          // Already there: no second copy of the screen.
          if (pathname !== path) router.push(item.review.target);
        }}
        onPause={pause}
      />
    );
  };

  /** What sync shows now: a question, or a note on every screen, or nothing. */
  const decide = (): { question: ReactNode; note: SyncNote | null } => {
    const none = { question: null, note: null };
    // Stopped by the person: every screen says so, with the way back. Nothing is asked meanwhile.
    if (paused && syncPauseIsTemporary())
      return {
        question: null,
        note: {
          label: "Sync paused for now",
          tone: "problem",
          tag: "Paused",
          short: "pause not saved",
          message:
            "Leve couldn't save the pause. Sync can restart when you reopen the app. Keep it open and try saving the pause again.",
          action: {
            label: "Save pause",
            hint: "Tries to keep sync paused after reopening",
            onPress: pause,
          },
        },
      };
    if (paused && (isSignedIn || accountData))
      return {
        question: null,
        note: {
          label: "Sync paused",
          tone: "quiet",
          tag: "Paused",
          message: "New workouts and changes stay on this phone until you resume.",
          action: {
            label: "Resume",
            hint: "Syncs this phone with your account again",
            onPress: () => setSyncPaused(false),
          },
        },
      };
    // The bound server matters even if the person deliberately signed out of Leve before pairing.
    if (disconnected) return { question: null, note: disconnected };
    if (isLoaded && !isSignedIn && accountData && signedOutOnPurpose())
      return {
        question: null,
        note: {
          label: "Signed out",
          tone: "quiet",
          tag: "Signed out",
          short: "not syncing",
          message: "New workouts and changes stay on this phone until you sign in.",
          action: {
            label: "Sign in",
            hint: "Opens Settings to sign in",
            onPress: () => router.push("/settings"),
          },
        },
      };
    const question = ask();
    // Nothing covers a workout being logged here: the question waits until it ends, and says so.
    // So does replacing this phone's data for another account, which waits for the same workout.
    if (logging && (question || status.heldForWorkout))
      return {
        question: null,
        note: {
          label: "Sync",
          tone: "quiet",
          tag: "Sync waits",
          short: question ? "question after this workout" : "waits for this workout",
          message: question
            ? "Sync has a question for you. It comes up once this workout ends."
            : "Sync is waiting for this workout to end.",
        },
      };
    if (question) return { question, note: null };
    // Settings stays usable for pairing, with the reason the phone needs to connect again.
    if (own && prompt?.kind === "sign_in")
      return {
        question: null,
        note: {
          label: "Not syncing",
          tone: "problem",
          tag: "Not syncing",
          short: "connect again",
          message: `${serverLabel(server)} no longer accepts this phone. Connect again in Settings using a new pairing link.`,
          action: { label: "Pause", hint: "Stops syncing until you resume it", onPress: pause },
        },
      };
    // The server is too old for this app: nothing the phone can do but wait or pause, so it says
    // so straight away, not only after a day.
    if (status.serverOutdated)
      return {
        question: null,
        note: {
          label: "Not syncing",
          tone: "problem",
          tag: "Not syncing",
          short: "server needs update",
          message:
            "Your sync server needs an update before this phone can sync. Changes stay on this phone, and Leve checks again every hour.",
          action: { label: "Pause", hint: "Stops syncing until you resume it", onPress: pause },
        },
      };
    const since = status.lastSynced ?? status.failingSince;
    if (
      isSignedIn &&
      since !== null &&
      Date.now() - since > STALE_AFTER_MS &&
      store.hasUnsyncedWork()
    ) {
      const day = new Date(since).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return {
        question: null,
        note: {
          label: "Not syncing",
          tone: "problem",
          tag: "Not synced",
          short: `since ${day}`,
          message: `Changes haven't synced since ${day}. They're safe on this phone, and Leve keeps trying.`,
        },
      };
    }
    return none;
  };
  const { question, note } = decide();
  // The week bar shows it as a tag on the tabs, and screens drawn above this one (the live workout
  // and finishing it are native modals) show the line themselves.
  useEffect(() => publishSyncNote(note));
  useEffect(() => () => publishSyncNote(null), []);
  if (question) return question;
  return note ? <NotSyncing note={note} /> : null;
}

function Body({ text }: { text: string }) {
  const styles = useStyles(sheet);
  return <Text style={styles.body}>{text}</Text>;
}

/** An export before data is deleted, with what happened. */
function useExport(exportData: () => Promise<void>) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const run = async () => {
    if (state === "busy") return;
    setState("busy");
    try {
      await exportData();
      setState("done");
    } catch {
      setState("failed");
    }
  };
  const note =
    state === "done"
      ? "A copy is saved."
      : state === "failed"
        ? "The copy wasn't saved. Try again."
        : null;
  return { busy: state === "busy", note, run };
}

/**
 * Data on this phone that never synced, and an account that already has data. It can't be put
 * off: the way out without deciding is signing out, which keeps the data here, not syncing.
 */
function CombinePrompt({
  workouts,
  sampleData,
  onCombine,
  onReplace,
  onSignOut,
  onPause,
  exportData,
}: {
  workouts: number;
  sampleData: boolean;
  onCombine: () => void;
  onReplace: () => void;
  /** Keeps the data here by signing out of the build's own server. */
  onSignOut?: () => Promise<void>;
  /**
   * Keeps it here without signing out: offered on a paired server, and once signing out failed
   * (say, offline), so the question never traps anyone.
   */
  onPause: () => void;
  exportData: () => Promise<void>;
}) {
  const styles = useStyles(sheet);
  const [replacing, setReplacing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const saved = useExport(exportData);
  const what = workouts > 0 ? plural(workouts, "workout") : "data";
  // "1 workout" and "data" both read as one thing.
  const one = workouts <= 1;
  if (replacing) {
    return (
      <Dialog
        eyebrow="Replace this phone's data"
        onClose={() => setReplacing(false)}
        closeLabel="Back"
        confirm={{
          label: "Delete and replace",
          // Not while the copy is being written: it reads the files this deletes.
          onPress: () => {
            if (!saved.busy) onReplace();
          },
        }}
        footer={
          <View style={styles.actions}>
            <Button
              rank="text"
              label={saved.busy ? "Saving a copy…" : "Save a copy first"}
              busy={saved.busy}
              onPress={saved.run}
            />
          </View>
        }
      >
        <Body
          text={`This deletes everything on this phone${workouts > 0 ? `, including ${what}` : ""}, then downloads your account. It can't be undone.`}
        />
        {saved.note ? <Body text={saved.note} /> : null}
      </Dialog>
    );
  }
  return (
    <Dialog
      eyebrow={sampleData ? "This phone has sample data" : "Your account already has data"}
      confirm={{ label: "Add to my account", onPress: onCombine }}
      footer={
        <View style={styles.actions}>
          <Button
            rank="text"
            label="Replace with my account's data"
            onPress={() => setReplacing(true)}
          />
          {onSignOut ? (
            <Button
              rank="text"
              label={`Keep ${one ? "it" : "them"} here and sign out`}
              onPress={() => {
                setProblem(null);
                onSignOut().catch(() =>
                  setProblem(
                    "Signing out didn't work. Check the connection and try again, or pause sync until you can.",
                  ),
                );
              }}
            />
          ) : null}
          {problem || !onSignOut ? (
            <Button rank="text" label="Pause sync" onPress={onPause} />
          ) : null}
        </View>
      }
    >
      <Body
        text={
          sampleData
            ? `This phone has sample records from an earlier build. Adding this phone's data uploads the sample records along with anything you logged. Nothing syncs until you choose. ${onSignOut ? "Signing out" : "Pausing sync"} keeps everything on this phone only.`
            : `This phone has ${what} that ${one ? "isn't" : "aren't"} in your account yet. Add ${one ? "it" : "them"} to your account, or replace ${one ? "it" : "them"} with what's in your account. Nothing syncs until you choose. ${onSignOut ? "Signing out" : "Pausing sync"} keeps ${one ? "it" : "them"} on this phone only.`
        }
      />
      {problem ? <Body text={problem} /> : null}
    </Dialog>
  );
}

/**
 * The way to keep this phone's data without deciding now: going back to where it belongs, or
 * signing out. With neither (a paired server, with nothing to go back to), or once it failed (say,
 * offline), pausing sync, so the question never traps anyone.
 */
function KeepButtons({
  onSwitchBack,
  onSignOut,
  onPause,
  problem,
  setProblem,
}: {
  onSwitchBack?: (() => void) | undefined;
  onSignOut?: (() => Promise<void>) | undefined;
  onPause: () => void;
  problem: string | null;
  setProblem: (problem: string | null) => void;
}) {
  return (
    <>
      {onSwitchBack ? (
        <Button
          rank="text"
          label="Keep them and switch back"
          onPress={() => {
            setProblem(null);
            try {
              onSwitchBack();
            } catch {
              setProblem("Switching back didn't work. Try again, or pause sync until you can.");
            }
          }}
        />
      ) : onSignOut ? (
        <Button
          rank="text"
          label="Keep them and sign out"
          onPress={() => {
            setProblem(null);
            onSignOut().catch(() =>
              setProblem(
                "Signing out didn't work. Check the connection and try again, or pause sync until you can.",
              ),
            );
          }}
        />
      ) : null}
      {problem || (!onSwitchBack && !onSignOut) ? (
        <Button rank="text" label="Pause sync" onPress={onPause} />
      ) : null}
    </>
  );
}

/**
 * This phone's data belongs to another account on this server, with changes that never synced.
 * It can't be put off: going back to that account, or signing out, keeps them here for it.
 */
function SwitchPrompt({
  unsynced,
  onSwitch,
  onSignOut,
  onSwitchBack,
  onPause,
  exportData,
}: {
  unsynced: number;
  onSwitch: () => void;
  /** Keeps the changes by signing this account out (the build's own server)... */
  onSignOut?: () => Promise<void>;
  /** ... or by going back to the server or pairing the phone used before. */
  onSwitchBack?: () => void;
  onPause: () => void;
  exportData: () => Promise<void>;
}) {
  const styles = useStyles(sheet);
  const saved = useExport(exportData);
  const [problem, setProblem] = useState<string | null>(null);
  const one = unsynced === 1;
  const it = one ? "it" : "them";
  return (
    <Dialog
      eyebrow="Signed in with another account"
      confirm={{
        label: "Delete and switch",
        onPress: () => {
          if (!saved.busy) onSwitch();
        },
      }}
      footer={
        <View style={styles.actions}>
          <Button
            rank="text"
            label={saved.busy ? "Saving a copy…" : "Save a copy first"}
            busy={saved.busy}
            onPress={saved.run}
          />
          <KeepButtons
            onSwitchBack={onSwitchBack}
            onSignOut={onSignOut}
            onPause={onPause}
            problem={problem}
            setProblem={setProblem}
          />
        </View>
      }
    >
      <Body
        text={`${plural(unsynced, "change")} on this phone ${one ? "belongs" : "belong"} to the account that was signed in before and ${one ? "hasn't" : "haven't"} synced. Switching to this account deletes ${it} from this phone. ${onSwitchBack ? `To keep ${it}, switch back to the account ${one ? "it" : "they"} belong${one ? "s" : ""} to.` : onSignOut ? `To keep ${it}, sign out and sign in again with the other account.` : `To keep ${it}, pause sync: ${it} stay${one ? "s" : ""} on this phone, unsynced, until you decide.`}`}
      />
      {saved.note ? <Body text={saved.note} /> : null}
      {problem ? <Body text={problem} /> : null}
    </Dialog>
  );
}

/**
 * The phone's data belongs to another server than the one it now syncs with. Bringing it along is
 * the first choice: the old server keeps its copy either way, and nothing here is deleted unless
 * the person says so. It can't be put off: going back, signing out or pausing sync keeps the data
 * here without deciding.
 */
function MovePrompt({
  server,
  account,
  unsynced,
  canMove,
  onMove,
  onStartOver,
  onSwitchBack,
  onSignOut,
  onPause,
  exportData,
}: {
  server: string;
  account: string | undefined;
  unsynced: number;
  canMove: boolean;
  onMove: () => void;
  onStartOver: () => void;
  onSwitchBack?: () => void;
  onSignOut?: () => Promise<void>;
  onPause: () => void;
  exportData: () => Promise<void>;
}) {
  const styles = useStyles(sheet);
  const saved = useExport(exportData);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const here = serverLabel(server);
  const destination = account
    ? `account “${account}” on ${here}`
    : `your signed-in account on ${here}`;
  const one = unsynced === 1;
  if (confirmDelete && unsynced > 0) {
    return (
      <Dialog
        eyebrow="Delete unsynced changes?"
        onClose={() => setConfirmDelete(false)}
        confirm={{ label: "Delete and start over", onPress: onStartOver }}
      >
        <Body
          text={`This deletes ${plural(unsynced, "unsynced change")} from this phone and starts from what ${here} holds.`}
        />
      </Dialog>
    );
  }
  return (
    <Dialog
      eyebrow="This phone used another server"
      {...(canMove
        ? {
            confirm: {
              label: "Bring them to this server",
              onPress: () => {
                if (saved.busy) return;
                try {
                  onMove();
                } catch {
                  setProblem("This phone couldn't start moving them. Try again.");
                }
              },
            },
          }
        : {})}
      footer={
        <View style={styles.actions}>
          <Button
            rank="text"
            label={saved.busy ? "Saving a copy…" : "Save a copy first"}
            busy={saved.busy}
            onPress={saved.run}
          />
          <Button
            rank="text"
            label={
              unsynced > 0
                ? `Delete ${plural(unsynced, "change")} and start over`
                : `Start from ${here}'s data`
            }
            onPress={() => {
              if (saved.busy) return;
              if (unsynced > 0) setConfirmDelete(true);
              else onStartOver();
            }}
          />
          <KeepButtons
            onSwitchBack={onSwitchBack}
            onSignOut={onSignOut}
            onPause={onPause}
            problem={problem}
            setProblem={setProblem}
          />
        </View>
      }
    >
      <Body
        text={
          unsynced > 0
            ? `This phone has ${plural(unsynced, "change")} that ${one ? "hasn't" : "haven't"} reached the previous server. Starting from what ${here} holds deletes those changes from this phone.`
            : "This phone's workouts are on the sync server it used before. That server keeps its copy."
        }
      />
      <Body
        text={
          canMove
            ? `Bringing your data adds it to ${destination}. You can review conflicting records after syncing.`
            : "Update Leve before moving. This phone holds records this version can't read. Until then, pausing sync keeps everything on this phone."
        }
      />
      {saved.note ? <Body text={saved.note} /> : null}
      {problem ? <Body text={problem} /> : null}
    </Dialog>
  );
}

/**
 * A paired server refused this phone's token: its operator signed the phone out, or the account
 * is gone. The data stays; a new pairing link from the operator connects it again. It can't be
 * put off: the way out without connecting again is pausing sync.
 */
function RefusedPrompt({
  server,
  onSettings,
  onPause,
}: {
  server: string;
  onSettings: () => void;
  onPause: () => void;
}) {
  return (
    <Dialog
      eyebrow="Connect again"
      confirm={{ label: "Open Settings", onPress: onSettings }}
      footer={<Button rank="text" label="Pause sync" onPress={onPause} />}
    >
      <Body
        text={`${serverLabel(server)} no longer accepts this phone. Until you connect again with a new pairing link from whoever runs it, new workouts and changes stay only on this phone. If you can't connect now, pause sync until you can.`}
      />
    </Dialog>
  );
}

/**
 * The sign-in ran out, or the server refused it. It can't be put off: the way out without signing
 * in is pausing sync, which every screen then shows.
 */
function SignInPrompt({
  signedIn,
  signOut,
  onSignedIn,
  onPause,
}: {
  signedIn: boolean;
  signOut: () => Promise<void>;
  onSignedIn: () => void;
  onPause: () => void;
}) {
  const styles = useStyles(sheet);
  const appearance = useAppearance();
  const appleSignIn = useAppleSignIn();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      // The server refused this sign-in: start a new one.
      if (signedIn) await signOut();
      if (await appleSignIn()) onSignedIn();
    } catch (error) {
      setProblem(signInProblem(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      eyebrow="Sign in again"
      footer={
        <View style={styles.actions}>
          <Button rank="text" label="Pause sync" onPress={onPause} />
        </View>
      }
    >
      <Body text="Your sign-in has run out. Until you sign in again, new workouts and changes stay only on this phone and don't sync. If you can't sign in now, pause sync until you can." />
      {problem ? <Body text={problem} /> : null}
      <View style={[styles.apple, busy && styles.waiting]} pointerEvents={busy ? "none" : "auto"}>
        <AppleAuthenticationButton
          buttonType={AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={
            appearance === "paper"
              ? AppleAuthenticationButtonStyle.BLACK
              : AppleAuthenticationButtonStyle.WHITE
          }
          cornerRadius={radius.button}
          style={styles.appleButton}
          onPress={signIn}
        />
      </View>
    </Dialog>
  );
}

/**
 * Can't be put off: the way out without updating is pausing sync, which every screen then shows.
 * It never stands between someone and the workout they are logging (see Sync).
 */
function UpdatePrompt({ onPause }: { onPause: () => void }) {
  // TestFlight builds (the preview channel) update from TestFlight. Development builds are
  // rebuilt, and App Store builds don't sync yet.
  const testFlight = channel === "preview";
  return (
    <Dialog
      eyebrow="Update Leve"
      footer={<Button rank="text" label="Pause sync" onPress={onPause} />}
      {...(testFlight
        ? {
            confirm: {
              label: "Open TestFlight",
              onPress: () => void Linking.openURL("itms-beta://").catch(() => {}),
            },
          }
        : {})}
    >
      <Body text="This version of Leve can't sync anymore. Update it to keep syncing. If you can't update now, pause sync: everything you log stays on this phone until you update and resume." />
    </Dialog>
  );
}

/** The tabs, where the week bar carries the note as a tag instead. */
const TAB_PATHS = new Set(["/", "/history", "/progress"]);

/**
 * Sync isn't running, or is waiting on the person: a line at the top of every screen, above the
 * app, until that changes (on the tabs, a tag in the week bar). It can't be dismissed, only acted
 * on; tapping it shows the whole note.
 */
function NotSyncing({ note }: { note: SyncNote }) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  if (TAB_PATHS.has(pathname)) return null;
  return (
    <View style={[styles.dock, { paddingTop: insets.top }]}>
      <SyncLine note={note} rule />
    </View>
  );
}

const sheet = themedStyles((c) => ({
  body: { ...type.body, fontSize: 15, lineHeight: 22, color: c.fg2, marginTop: space.sm },
  actions: { alignItems: "center", gap: 2 },
  apple: { marginTop: space.md, marginRight: 4 },
  appleButton: { height: 44, width: "100%" },
  waiting: { opacity: 0.5 },
  dock: { paddingHorizontal: gutter.group, backgroundColor: c.bg },
}));
