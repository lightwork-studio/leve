import { useAuth } from "@clerk/expo";
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { channel } from "expo-updates";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signInProblem, useAppleSignIn } from "../account/apple-sign-in.ts";
import { buildInfo } from "../build-info.ts";
import { useAppData } from "../data/app-data.tsx";
import { subscribeDevicePreferences } from "../data/device-preference-store.ts";
import { gutter, radius, space, type } from "../theme.ts";
import { Button } from "../ui/buttons.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Banner } from "../ui/notice.tsx";
import { themedStyles, useAppearance, useStyles } from "../ui/themed.ts";
import { syncEnabled, syncServerUrl } from "./sync-config.ts";
import {
  REMIND_LATER_MS,
  readLastSynced,
  setSignInReminder,
  signInReminderDue,
  writeLastSynced,
} from "./sync-preferences.ts";
import { SyncSession, type SyncStatus } from "./sync-session.ts";

/** How long sync may fail before the app says that changes aren't syncing. */
export const STALE_AFTER_MS = 24 * 60 * 60_000;

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
  if (!syncEnabled()) return null;
  return <Sync />;
}

function Sync() {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  const { store, version, change, reset, exportData } = useAppData();
  const [status, setStatus] = useState<SyncStatus>(IDLE);
  const session = useRef<SyncSession | null>(null);
  // The session outlives renders: it reaches these through refs, and restarts only for another
  // account or store.
  const latest = useRef({ getToken, change, reset });
  latest.current = { getToken, change, reset };
  // Re-render when a reminder choice is saved.
  const [, setPreferences] = useState(0);
  useEffect(() => subscribeDevicePreferences(() => setPreferences((n) => n + 1)), []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    const running = new SyncSession({
      store,
      server: syncServerUrl,
      account: userId,
      app: `leve-preview ${buildInfo.commit}`,
      token: (fresh) => latest.current.getToken(fresh ? { skipCache: true } : undefined),
      onPulled: () => latest.current.change(() => undefined),
      onStatus: (next) => {
        setStatus(next);
        if (next.lastSynced !== null) writeLastSynced(next.lastSynced);
      },
      startOver: () => {
        writeLastSynced(null);
        void latest.current.reset(false);
      },
      lastSynced: readLastSynced(),
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
  }, [isLoaded, isSignedIn, userId, store]);

  // Every change to the data passes here; the session sends it shortly, if there is any to send.
  useEffect(() => {
    if (version > 0) session.current?.nudge();
  }, [version]);

  // Questions wait until the workout in progress ends.
  if (store.activeWorkout()) return null;

  const prompt = status.prompt;
  if (prompt?.kind === "update") return <UpdatePrompt />;
  if (prompt?.kind === "combine") {
    return (
      <CombinePrompt
        workouts={workoutCount(store)}
        onCombine={() => session.current?.combine()}
        onReplace={() => session.current?.replaceLocalData()}
        exportData={exportData}
      />
    );
  }
  if (prompt?.kind === "switch") {
    return (
      <SwitchPrompt
        unsynced={prompt.unsynced}
        onSwitch={() => session.current?.replaceLocalData()}
        onSignOut={async () => {
          setSignInReminder("off");
          await signOut();
        }}
        exportData={exportData}
      />
    );
  }

  const now = Date.now();
  const lapsed =
    prompt?.kind === "sign_in" || (isLoaded && !isSignedIn && store.syncState().account !== null);
  if (lapsed && signInReminderDue(now)) {
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
  onCombine,
  onReplace,
  exportData,
}: {
  workouts: number;
  onCombine: () => void;
  onReplace: () => void;
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
        confirm={{ label: "Delete and replace", onPress: onReplace }}
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
          text={`This deletes the ${what} on this phone, then downloads your account. It can't be undone.`}
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
        <Button
          rank="text"
          label="Replace with my account's data"
          onPress={() => setReplacing(true)}
        />
      }
    >
      <Body
        text={`This phone has ${what} that ${one ? "isn't" : "aren't"} in your account yet. Add ${one ? "it" : "them"} to your account, or replace ${one ? "it" : "them"} with what's in your account.`}
      />
    </Dialog>
  );
}

function SwitchPrompt({
  unsynced,
  onSwitch,
  onSignOut,
  exportData,
}: {
  unsynced: number;
  onSwitch: () => void;
  onSignOut: () => Promise<void>;
  exportData: () => Promise<void>;
}) {
  const styles = useStyles(sheet);
  const saved = useExport(exportData);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog
      eyebrow="Signed in with another account"
      confirm={{ label: "Delete and switch", onPress: onSwitch }}
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
            label="Sign out instead"
            onPress={() => {
              onSignOut().catch(() =>
                setProblem("Signing out didn't work. Check the connection and try again."),
              );
            }}
          />
        </View>
      }
    >
      <Body
        text={`${plural(unsynced, "change")} on this phone ${unsynced === 1 ? "belongs" : "belong"} to the account that was signed in before and ${unsynced === 1 ? "hasn't" : "haven't"} synced. Switching to this account deletes ${unsynced === 1 ? "it" : "them"} from this phone. Sign out instead to keep ${unsynced === 1 ? "it" : "them"} and sync later with the other account.`}
      />
      {saved.note ? <Body text={saved.note} /> : null}
      {problem ? <Body text={problem} /> : null}
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

function UpdatePrompt() {
  // TestFlight builds (the preview channel) update from TestFlight. Development builds are
  // rebuilt, and App Store builds don't sync yet.
  const testFlight = channel === "preview";
  return (
    <Dialog
      eyebrow="Update Leve"
      {...(testFlight
        ? {
            confirm: {
              label: "Open TestFlight",
              onPress: () => void Linking.openURL("itms-beta://").catch(() => {}),
            },
          }
        : {})}
    >
      <Body text="This version of Leve can't sync anymore. Update it to keep syncing. Your workouts are safe on this phone." />
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
