import { useAuth, useUser } from "@clerk/expo";
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { router, usePathname } from "expo-router";
import { channel } from "expo-updates";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signInProblem, useAppleSignIn } from "../account/apple-sign-in.ts";
import { buildInfo } from "../build-info.ts";
import { useAppData } from "../data/app-data.tsx";
import { conflicts, type ReviewTarget } from "../data/conflicts.ts";
import { subscribeDevicePreferences } from "../data/device-preference-store.ts";
import { gutter, radius, space, type } from "../theme.ts";
import { Button } from "../ui/buttons.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Banner } from "../ui/notice.tsx";
import { themedStyles, useAppearance, useStyles } from "../ui/themed.ts";
import { ConflictPrompt } from "./conflict-prompt.tsx";
import { type OwnServer, serverLabel } from "./own-server.ts";
import {
  previousServer,
  readServerChoice,
  subscribeServerChoice,
  switchBack,
} from "./own-server-store.ts";
import {
  builtInServerConfigured,
  ownServerAvailable,
  syncEnabled,
  syncServerUrl,
} from "./sync-config.ts";
import {
  REMIND_LATER_MS,
  readLastSynced,
  setSignInReminder,
  signInReminderDue,
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

/**
 * Syncs this phone with the signed-in account while the app runs, and asks only when the person
 * has to decide something: whether to combine this phone's data with an account that has data,
 * whether to delete unsynced changes when another account signs in, to sign in again, or to update
 * the app. Being offline or a server that is briefly down shows nothing; only a day without
 * syncing does, as a note. Nothing is asked during a workout: questions wait until it ends.
 */
export function SyncHost() {
  const own = useOwnServer();
  // If the keychain is locked, wait before choosing which account to sync.
  if (own === undefined || !syncEnabled()) return null;
  // A new pairing is a new session, even with the same account id.
  if (own) {
    const key = `${own.server} ${own.device}`;
    return builtInServerConfigured() ? (
      <PairedSyncWithClerk key={key} own={own} />
    ) : (
      <Sync key={key} connection={ownConnection(own)} />
    );
  }
  if (!builtInServerConfigured()) return null;
  return <ClerkSync />;
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

/** The paired server, while it is the phone's choice; follows changes made in Settings. */
function useOwnServer(): OwnServer | null | undefined {
  const [, setVersion] = useState(0);
  useEffect(() => subscribeServerChoice(() => setVersion((n) => n + 1)), []);
  // A keychain that couldn't be read (a locked phone) is read again when the app comes back.
  useEffect(() => {
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") setVersion((n) => n + 1);
    });
    return () => watch.remove();
  }, []);
  return ownServerAvailable() ? readServerChoice() : null;
}

/**
 * Whether switching back to the choice before reaches the server and account this phone's data
 * belongs to. Anything else would only move the question to another server.
 */
function switchesBackToData(
  bound: { server: string | null; account: string | null },
  builtInAccount: string | null,
): boolean {
  if (!ownServerAvailable()) return false;
  const previous = previousServer();
  if (previous) return previous.server === bound.server && previous.account === bound.account;
  // The build's own server, if the current choice is a paired one.
  return (
    builtInAccount !== null && bound.server === syncServerUrl && bound.account === builtInAccount
  );
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
  /** "Not now" on a question: hidden until the session restarts; sync stays paused meanwhile. */
  const [later, setLater] = useState(false);
  /** "Not now" on the update question: hidden until the app next comes to the front. */
  const [updateLater, setUpdateLater] = useState(false);
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
  useEffect(() => {
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") setUpdateLater(false);
    });
    return () => watch.remove();
  }, []);
  /** When the last sync was saved: every wait for changes ends in one, every 25 s or so. */
  const lastWritten = useRef(0);
  const session = useRef<SyncSession | null>(null);
  // The session outlives renders: it reaches these through refs, and restarts only for another
  // account or store.
  const latest = useRef({ getToken, change, reset, userId });
  latest.current = { getToken, change, reset, userId };
  // Re-render when a reminder choice is saved.
  const [, setPreferences] = useState(0);
  useEffect(() => subscribeDevicePreferences(() => setPreferences((n) => n + 1)), []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
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
      log: (message) => console.warn(message),
    });
    session.current = running;
    // A "Not now" was for the question of the session before.
    setLater(false);
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
  }, [isLoaded, isSignedIn, userId, store, server]);

  // Every change to the data passes here; the session sends it shortly, if there is any to send.
  useEffect(() => {
    if (version > 0) session.current?.nudge();
  }, [version]);

  // Questions wait until the workout in progress ends.
  if (store.activeWorkout()) return null;

  const prompt = status.prompt;
  if (prompt?.kind === "update" && !updateLater) {
    return <UpdatePrompt onLater={() => setUpdateLater(true)} />;
  }
  if (prompt?.kind === "combine" && !later) {
    return (
      <CombinePrompt
        workouts={workoutCount(store)}
        sampleData={prompt.sampleData === true}
        onCombine={() => session.current?.combine()}
        onReplace={() => session.current?.replaceLocalData()}
        onLater={() => setLater(true)}
        exportData={exportData}
      />
    );
  }
  if (prompt?.kind === "switch" && !later) {
    const keep = switchesBackToData(store.syncState(), builtInAccount)
      ? { onSwitchBack: () => switchBack() }
      : null;
    if (prompt.reason === "server") {
      return (
        <MovePrompt
          server={server}
          account={connection.accountName}
          unsynced={unsyncedChanges(store)}
          canMove={!store.hasUnavailableRecords()}
          onMove={() => session.current?.moveLocalData()}
          onStartOver={() => session.current?.replaceLocalData()}
          {...(keep ?? {})}
          onLater={() => setLater(true)}
          exportData={exportData}
        />
      );
    }
    return (
      <SwitchPrompt
        // Counted now, not when sync asked: work done meanwhile is lost too.
        unsynced={unsyncedChanges(store)}
        onSwitch={() => session.current?.replaceLocalData()}
        // Keeping them means going back, when the choice before is where they belong; on the
        // build's own server, otherwise, signing this account out.
        {...(keep
          ? keep
          : own
            ? {}
            : {
                onSignOut: async () => {
                  setSignInReminder("off");
                  try {
                    await signOut();
                  } catch (error) {
                    setSignInReminder("");
                    throw error;
                  }
                },
              })}
        onLater={() => setLater(true)}
        exportData={exportData}
      />
    );
  }

  const now = Date.now();
  if (own && prompt?.kind === "sign_in" && !later) {
    return <RefusedPrompt server={server} onLater={() => setLater(true)} />;
  }
  const lapsed =
    prompt?.kind === "sign_in" || (isLoaded && !isSignedIn && store.syncState().account !== null);
  if (!own && lapsed && signInReminderDue(now)) {
    return (
      <SignInPrompt
        signedIn={!!isSignedIn}
        signOut={signOut}
        onSignedIn={() => {
          setSignInReminder("");
          session.current?.retry();
        }}
      />
    );
  }

  // Conflicts are settled here and now: one at a time, before the app goes on.
  const bound = store.syncState();
  const switching =
    isSignedIn && bound.account !== null && (bound.server !== server || bound.account !== userId);
  const pending = switching ? [] : conflicts(store);
  // While the person is on the screen a conflict sent them to, nothing covers it. Leaving it with
  // the conflict unsettled brings the popup back.
  if (reviewing && pending.some((item) => item.key === reviewing.key)) return null;
  if (pending.length > 0)
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
      />
    );

  const since = status.lastSynced ?? status.failingSince;
  if (isSignedIn && since !== null && now - since > STALE_AFTER_MS && store.hasUnsyncedWork()) {
    return <StaleNote since={since} />;
  }
  return null;
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

function CombinePrompt({
  workouts,
  sampleData,
  onCombine,
  onReplace,
  onLater,
  exportData,
}: {
  workouts: number;
  sampleData: boolean;
  onCombine: () => void;
  onReplace: () => void;
  onLater: () => void;
  exportData: () => Promise<void>;
}) {
  const styles = useStyles(sheet);
  const [replacing, setReplacing] = useState(false);
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
          <Button rank="text" label="Not now" onPress={onLater} />
        </View>
      }
    >
      <Body
        text={
          sampleData
            ? "This phone has sample records from an earlier build. Adding this phone's data uploads the sample records along with anything you logged."
            : `This phone has ${what} that ${one ? "isn't" : "aren't"} in your account yet. Add ${one ? "it" : "them"} to your account, or replace ${one ? "it" : "them"} with what's in your account.`
        }
      />
    </Dialog>
  );
}

/** The phone's unsynced changes belong to another account on this server. */
function SwitchPrompt({
  unsynced,
  onSwitch,
  onSignOut,
  onSwitchBack,
  onLater,
  exportData,
}: {
  unsynced: number;
  onSwitch: () => void;
  /** Keeps the changes by signing this account out (the build's own server)... */
  onSignOut?: () => Promise<void>;
  /** ... or by going back to the server or pairing the phone used before. */
  onSwitchBack?: () => void;
  onLater: () => void;
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
          {onSwitchBack ? (
            <Button
              rank="text"
              label="Keep them and switch back"
              onPress={() => {
                try {
                  onSwitchBack();
                } catch {
                  setProblem("Switching back didn't work. Try again.");
                }
              }}
            />
          ) : onSignOut ? (
            <Button
              rank="text"
              label="Keep them and sign out"
              onPress={() => {
                onSignOut().catch(() =>
                  setProblem("Signing out didn't work. Check the connection and try again."),
                );
              }}
            />
          ) : null}
          <Button rank="text" label="Not now" onPress={onLater} />
        </View>
      }
    >
      <Body
        text={`${plural(unsynced, "change")} on this phone ${one ? "belongs" : "belong"} to the account that was signed in before and ${one ? "hasn't" : "haven't"} synced. Switching to this account deletes ${it} from this phone. ${onSwitchBack ? `To keep ${it}, switch back to the account it used before.` : onSignOut ? `To keep ${it}, sign out and sign in again with the other account.` : `Not now keeps ${it} on this phone, unsynced.`}`}
      />
      {saved.note ? <Body text={saved.note} /> : null}
      {problem ? <Body text={problem} /> : null}
    </Dialog>
  );
}

/**
 * The phone's data belongs to another server than the one it now syncs with. Bringing it along is
 * the first choice: the old server keeps its copy either way, and nothing here is deleted unless
 * the person says so.
 */
function MovePrompt({
  server,
  account,
  unsynced,
  canMove,
  onMove,
  onStartOver,
  onSwitchBack,
  onLater,
  exportData,
}: {
  server: string;
  account: string | undefined;
  unsynced: number;
  canMove: boolean;
  onMove: () => void;
  onStartOver: () => void;
  onSwitchBack?: () => void;
  onLater: () => void;
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
          {onSwitchBack ? (
            <Button
              rank="text"
              label="Switch back"
              onPress={() => {
                try {
                  onSwitchBack();
                } catch {
                  setProblem("Switching back didn't work. Try again.");
                }
              }}
            />
          ) : null}
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
          <Button rank="text" label="Not now" onPress={onLater} />
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
            : "Update Leve before moving. This phone holds records this version can't read."
        }
      />
      {saved.note ? <Body text={saved.note} /> : null}
      {problem ? <Body text={problem} /> : null}
    </Dialog>
  );
}

/**
 * A paired server refused this phone's token: its operator signed the phone out, or the account
 * is gone. The data stays; a new pairing link from the operator connects it again.
 */
function RefusedPrompt({ server, onLater }: { server: string; onLater: () => void }) {
  return (
    <Dialog
      eyebrow="Connect again"
      onClose={onLater}
      closeLabel="Not now"
      confirm={{
        label: "Open Settings",
        onPress: () => {
          onLater();
          router.push("/settings");
        },
      }}
      footer={<Button rank="text" label="Not now" onPress={onLater} />}
    >
      <Body
        text={`${serverLabel(server)} no longer accepts this phone. Until you connect again with a new pairing link from whoever runs it, new workouts and changes stay only on this phone.`}
      />
    </Dialog>
  );
}

function SignInPrompt({
  signedIn,
  signOut,
  onSignedIn,
}: {
  signedIn: boolean;
  signOut: () => Promise<void>;
  onSignedIn: () => void;
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
          <Button
            rank="text"
            label="Remind me later"
            onPress={() => setSignInReminder(Date.now() + REMIND_LATER_MS)}
          />
          <Button rank="text" label="Ignore" onPress={() => setSignInReminder("off")} />
        </View>
      }
    >
      <Body text="Your sign-in has run out. Until you sign in again, new workouts and changes stay only on this phone and don't sync." />
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
 * Comes back each time the app comes to the front, but can be put aside: logging works without
 * syncing, so it never stands between someone and their workout.
 */
function UpdatePrompt({ onLater }: { onLater: () => void }) {
  // TestFlight builds (the preview channel) update from TestFlight. Development builds are
  // rebuilt, and App Store builds don't sync yet.
  const testFlight = channel === "preview";
  return (
    <Dialog
      eyebrow="Update Leve"
      onClose={onLater}
      closeLabel="Not now"
      footer={<Button rank="text" label="Not now" onPress={onLater} />}
      {...(testFlight
        ? {
            confirm: {
              label: "Open TestFlight",
              onPress: () => void Linking.openURL("itms-beta://").catch(() => {}),
            },
          }
        : {})}
    >
      <Body text="This version of Leve can't sync anymore. Update it to keep syncing. Until then, everything you log stays on this phone." />
    </Dialog>
  );
}

function StaleNote({ since }: { since: number }) {
  const styles = useStyles(sheet);
  const insets = useSafeAreaInsets();
  const day = new Date(since).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <View style={[styles.dock, { paddingTop: insets.top + space.sm }]}>
      <Banner
        label="Not syncing"
        message={`Changes haven't synced since ${day}. They're safe on this phone, and Leve keeps trying.`}
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
