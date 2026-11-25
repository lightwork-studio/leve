import { useAuth, useUser } from "@clerk/expo";
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { syncEnabled } from "../sync/sync-config.ts";
import { setSignInReminder } from "../sync/sync-preferences.ts";
import { unsyncedChanges } from "../sync/sync-session.ts";
import { radius, space, type } from "../theme.ts";
import { ActionRow, SettingRow } from "../ui/choice-row.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { announce } from "../ui/focus.ts";
import { Group } from "../ui/group.tsx";
import { haptic } from "../ui/haptics.ts";
import { themedStyles, useAppearance, useStyles } from "../ui/themed.ts";
import { signInProblem, useAppleSignIn } from "./apple-sign-in.ts";
import { clerkPublishableKey } from "./clerk-key.ts";

export { signInProblem };

const SIGNED_OUT_NOTE =
  "For now, signing in only sets up your account, and your workouts stay on this phone. Once syncing arrives, they back up to it and follow you to a new phone. Everything works without an account.";
const SIGNED_IN_NOTE =
  "Your workouts are still only on this phone. Once syncing arrives, they back up to this account. Signing out keeps everything here.";
/** In builds that sync. */
const SYNC_SIGNED_OUT_NOTE =
  "Sign in to back up your workouts and have them on every phone you sign in on. Everything works without an account.";
const SYNC_SIGNED_IN_NOTE =
  "Your workouts sync with this account. Signing out keeps everything on this phone.";
const SIGN_OUT_FAILED = "Signing out didn't work. Check the connection and try again.";

/** The account in Settings: Sign in with Apple, or who is signed in and a way to sign out. */
export function AccountSection() {
  // Sign in with Apple is native to iOS; other platforms get their sign-in later.
  if (!clerkPublishableKey || Platform.OS !== "ios") return null;
  return <Account />;
}

function Account() {
  const styles = useStyles(sheet);
  const appearance = useAppearance();
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  const { store } = useAppData();
  const appleSignIn = useAppleSignIn();
  const syncing = syncEnabled();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Changes that would wait for this account, asked about before signing out. */
  const [unsynced, setUnsynced] = useState<number | null>(null);
  const working = useRef(false);

  const run = async (work: () => Promise<void>, failed: (error: unknown) => string) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      const message = failed(error);
      haptic.warning();
      setProblem(message);
      announce(message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const signIn = () =>
    run(async () => {
      // A dismissed sheet has nothing to report.
      if (!(await appleSignIn())) return;
      setSignInReminder("");
      haptic.success();
    }, signInProblem);

  const signOutNow = () =>
    run(
      async () => {
        // Signed out on purpose: don't ask to sign in again. Set first, so the question can't
        // flash up between signing out and this.
        setSignInReminder("off");
        try {
          await signOut();
        } catch (error) {
          setSignInReminder("");
          throw error;
        }
      },
      () => SIGN_OUT_FAILED,
    );

  if (!isLoaded) {
    // Only for a moment: offline, Clerk starts from what it saved last time.
    return (
      <Group label="Account">
        <SettingRow label="Checking your account…">{null}</SettingRow>
      </Group>
    );
  }

  if (isSignedIn) {
    const email = user?.primaryEmailAddress?.emailAddress;
    return (
      <Group label="Account" footnote={problem ?? (syncing ? SYNC_SIGNED_IN_NOTE : SIGNED_IN_NOTE)}>
        <SettingRow label="Signed in with Apple" {...(email ? { hint: email } : {})}>
          {null}
        </SettingRow>
        <ActionRow
          label={busy ? "Signing out…" : "Sign out"}
          divider
          accessibilityHint="Your workouts stay on this phone"
          onPress={() => {
            const waiting = syncing ? unsyncedChanges(store) : 0;
            if (waiting > 0) setUnsynced(waiting);
            else void signOutNow();
          }}
        />
        {unsynced !== null ? (
          <Dialog
            eyebrow="Sign out"
            onClose={() => setUnsynced(null)}
            confirm={{
              label: "Sign out",
              onPress: () => {
                setUnsynced(null);
                void signOutNow();
              },
            }}
          >
            <Text style={styles.warning}>
              {`${unsynced === 1 ? "1 change hasn't" : `${unsynced} changes haven't`} synced yet. ${unsynced === 1 ? "It stays" : "They stay"} on this phone and ${unsynced === 1 ? "syncs" : "sync"} when you sign in again with this account. Signing in with a different account would ask to delete ${unsynced === 1 ? "it" : "them"}.`}
            </Text>
          </Dialog>
        ) : null}
      </Group>
    );
  }

  return (
    <Group label="Account" footnote={problem ?? (syncing ? SYNC_SIGNED_OUT_NOTE : SIGNED_OUT_NOTE)}>
      <View
        style={[styles.signIn, busy && styles.waiting]}
        pointerEvents={busy ? "none" : "auto"}
        accessibilityElementsHidden={busy}
      >
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
    </Group>
  );
}

const sheet = themedStyles((c) => ({
  warning: { ...type.body, fontSize: 15, lineHeight: 22, color: c.fg2, marginTop: space.sm },
  signIn: { padding: space.md },
  appleButton: { height: 44, width: "100%" },
  waiting: { opacity: 0.5 },
}));
