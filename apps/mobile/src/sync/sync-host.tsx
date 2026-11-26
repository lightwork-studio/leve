import { useAuth } from "@clerk/expo";
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
import { workoutHere } from "../data/workout-here.ts";
import { gutter, radius, space, type } from "../theme.ts";
import { Button } from "../ui/buttons.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Banner } from "../ui/notice.tsx";
import { themedStyles, useAppearance, useStyles } from "../ui/themed.ts";
import { ConflictPrompt } from "./conflict-prompt.tsx";
import { syncEnabled, syncServerUrl } from "./sync-config.ts";
import { publishSyncNote, type SyncNote } from "./sync-note.tsx";
import {
  readLastSynced,
  setSignedOutOnPurpose,
  setSyncPaused,
  signedOutOnPurpose,
  syncPaused,
  writeLastSynced,
} from "./sync-preferences.ts";
import { SyncSession, type SyncStatus, unsyncedChanges } from "./sync-session.ts";

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

/** The path of the live workout screen, where nothing may cover the logging. */
const LOGGING_PATH = "/workout/active";

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
  if (!syncEnabled()) return null;
  return <Sync />;
}

function Sync() {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  const { store, version, change, reset, exportData } = useAppData();
  const [status, setStatus] = useState<SyncStatus>(IDLE);
  /** A conflict being reviewed on its own screen, and whether that screen has opened yet. */
  const [reviewing, setReviewing] = useState<{
    key: string;
    path: string;
    arrived: boolean;
  } | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    setReviewing((current) => {
      if (!current) return current;
      if (pathname === current.path)
        return current.arrived ? current : { ...current, arrived: true };
      // Left the review screen: the popup asks again if it's still unsettled.
      return current.arrived ? null : current;
    });
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
    !!store.activeWorkout() && (workoutHere(store) !== null || pathname === LOGGING_PATH);
  // The session outlives renders: it reaches these through refs, and restarts only for another
  // account or store, or when sync is paused or resumed.
  const latest = useRef({ getToken, change, reset, userId, logging });
  latest.current = { getToken, change, reset, userId, logging };

  useEffect(() => {
    // Paused: nothing syncs until the person resumes (every screen says so, see below).
    if (!isLoaded || !isSignedIn || !userId || paused) return;
    const running = new SyncSession({
      store,
      server: syncServerUrl,
      account: userId,
      app: `leve-preview ${buildInfo.commit}`,
      // Only the account this session syncs: a request still on its way when someone else signs in
      // fails as offline rather than reach the new account.
      token: async (fresh) => {
        if (latest.current.userId !== userId) throw new Error("another account signed in");
        const token = await latest.current.getToken(fresh ? { skipCache: true } : undefined);
        // Signed in but no token: Clerk couldn't be reached. Offline, not a sign-in problem.
        if (!token) throw new Error("no session token");
        return token;
      },
      onPulled: () => latest.current.change(() => undefined),
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
  }, [isLoaded, isSignedIn, userId, store, paused]);

  // Every change to the data passes here; the session sends it shortly, if there is any to send.
  useEffect(() => {
    if (version > 0) session.current?.nudge();
  }, [version]);

  // This phone's data belongs to an account, so its changes are meant to sync.
  const accountData = store.syncState().account !== null;
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
          onCombine={() => session.current?.combine()}
          onReplace={() => session.current?.replaceLocalData()}
          onSignOut={signOutHere}
          exportData={exportData}
        />
      );
    if (prompt?.kind === "switch")
      return (
        <SwitchPrompt
          reason={prompt.reason}
          // Counted now, not when sync asked: work done meanwhile is lost too.
          unsynced={unsyncedChanges(store)}
          onSwitch={() => session.current?.replaceLocalData()}
          onSignOut={signOutHere}
          exportData={exportData}
        />
      );
    // The sign-in ran out (or the server refused it): asked every time, never set aside.
    if (prompt?.kind === "sign_in" || (isLoaded && !isSignedIn && accountData))
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
    // Conflicts are settled here and now: one at a time, before the app goes on.
    const pending = conflicts(store);
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
    if (paused && (isSignedIn || accountData))
      return {
        question: null,
        note: {
          label: "Sync paused",
          message: "New workouts and changes stay on this phone until you resume.",
          action: {
            label: "Resume",
            hint: "Syncs this phone with your account again",
            onPress: () => setSyncPaused(false),
          },
        },
      };
    if (isLoaded && !isSignedIn && accountData && signedOutOnPurpose())
      return {
        question: null,
        note: {
          label: "Signed out",
          message: "Changes stay on this phone and sync once you sign in again with your account.",
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
          message: "Sync has a question for you. It comes up once this workout ends.",
        },
      };
    if (question) return { question, note: null };
    // The server is too old for this app: nothing the phone can do but wait or pause, so it says
    // so straight away, not only after a day.
    if (status.serverOutdated)
      return {
        question: null,
        note: {
          label: "Not syncing",
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
          message: `Changes haven't synced since ${day}. They're safe on this phone, and Leve keeps trying.`,
        },
      };
    }
    return none;
  };
  const { question, note } = decide();
  // Screens drawn above this one (the live workout and finishing it are native modals) show the
  // same note themselves.
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
  onCombine,
  onReplace,
  onSignOut,
  exportData,
}: {
  workouts: number;
  onCombine: () => void;
  onReplace: () => void;
  onSignOut: () => Promise<void>;
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
      eyebrow="Your account already has data"
      confirm={{ label: "Add to my account", onPress: onCombine }}
      footer={
        <View style={styles.actions}>
          <Button
            rank="text"
            label="Replace with my account's data"
            onPress={() => setReplacing(true)}
          />
          <Button
            rank="text"
            label={`Keep ${one ? "it" : "them"} here and sign out`}
            onPress={() => {
              setProblem(null);
              onSignOut().catch(() =>
                setProblem("Signing out didn't work. Check the connection and try again."),
              );
            }}
          />
        </View>
      }
    >
      <Body
        text={`This phone has ${what} that ${one ? "isn't" : "aren't"} in your account yet. Add ${one ? "it" : "them"} to your account, or replace ${one ? "it" : "them"} with what's in your account. Nothing syncs until you choose. Signing out keeps ${one ? "it" : "them"} on this phone only.`}
      />
      {problem ? <Body text={problem} /> : null}
    </Dialog>
  );
}

/**
 * This phone's data belongs to another account or server, with changes that never synced. It
 * can't be put off: signing out keeps them here for the account they belong to.
 */
function SwitchPrompt({
  reason,
  unsynced,
  onSwitch,
  onSignOut,
  exportData,
}: {
  reason: "account" | "server";
  unsynced: number;
  onSwitch: () => void;
  onSignOut: () => Promise<void>;
  exportData: () => Promise<void>;
}) {
  const styles = useStyles(sheet);
  const saved = useExport(exportData);
  const [problem, setProblem] = useState<string | null>(null);
  const one = unsynced === 1;
  const it = one ? "it" : "them";
  return (
    <Dialog
      eyebrow={
        reason === "account" ? "Signed in with another account" : "This phone used another server"
      }
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
          <Button
            rank="text"
            label="Keep them and sign out"
            onPress={() => {
              setProblem(null);
              onSignOut().catch(() =>
                setProblem("Signing out didn't work. Check the connection and try again."),
              );
            }}
          />
        </View>
      }
    >
      <Body
        text={
          reason === "account"
            ? `${plural(unsynced, "change")} on this phone ${one ? "belongs" : "belong"} to the account that was signed in before and ${one ? "hasn't" : "haven't"} synced. Switching to this account deletes ${it} from this phone. To keep ${it}, sign out and sign in again with the other account.`
            : `${plural(unsynced, "change")} on this phone ${one ? "hasn't" : "haven't"} reached the sync server this phone used before, which this version of Leve doesn't use. Switching deletes ${it} from this phone. Signing out keeps ${it} here, unsynced.`
        }
      />
      {saved.note ? <Body text={saved.note} /> : null}
      {problem ? <Body text={problem} /> : null}
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

/**
 * Sync isn't running, or is waiting on the person: a note at the top of every screen, above the
 * app, until that changes. It can't be dismissed, only acted on.
 */
function NotSyncing({ note }: { note: SyncNote }) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.dock, { paddingTop: insets.top + space.sm }]}>
      <Banner
        label={note.label}
        message={note.message}
        {...(note.action ? { action: note.action } : {})}
      />
    </View>
  );
}

const sheet = themedStyles((c) => ({
  body: { ...type.body, fontSize: 15, lineHeight: 22, color: c.fg2, marginTop: space.sm },
  actions: { alignItems: "center", gap: 2 },
  apple: { marginTop: space.md, marginRight: 4 },
  appleButton: { height: 44, width: "100%" },
  waiting: { opacity: 0.5 },
  dock: {
    paddingHorizontal: gutter.group - 2,
    paddingBottom: space.sm,
    backgroundColor: c.bg,
  },
}));
