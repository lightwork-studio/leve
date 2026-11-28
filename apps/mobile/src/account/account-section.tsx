import { useAuth, useUser } from "@clerk/expo";
import { useEffect, useRef, useState } from "react";
import { Platform, Text } from "react-native";
import { useAppData } from "../data/app-data.tsx";
import { subscribeDevicePreferences } from "../data/device-preference-store.ts";
import { ownServer, subscribeServerChoice } from "../sync/own-server-store.ts";
import {
  builtInServerConfigured,
  ownServerAvailable,
  syncEnabled,
  syncServerUrl,
} from "../sync/sync-config.ts";
import {
  accountBeingDeleted,
  setAccountBeingDeleted,
  setSignedOutOnPurpose,
  setSyncPaused,
  syncPaused,
  writeLastSynced,
} from "../sync/sync-preferences.ts";
import { unsyncedChanges } from "../sync/sync-session.ts";
import { space, type } from "../theme.ts";
import { ActionRow, SettingRow } from "../ui/choice-row.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { announce } from "../ui/focus.ts";
import { Group } from "../ui/group.tsx";
import { haptic } from "../ui/haptics.ts";
import { themedStyles, useStyles } from "../ui/themed.ts";
import {
  appleConfirmation,
  DELETION_FAILED,
  DeletionProblem,
  requestAccountDeletion,
  setAccountDeletionState,
} from "./account-deletion.ts";
import { signInProblem, useAppleSignIn } from "./apple-sign-in.ts";
import { AppleSignInButton } from "./apple-sign-in-button.tsx";
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
const SYNC_PAUSED_NOTE =
  "Sync is paused. New workouts and changes stay on this phone until you resume it.";
const SIGN_OUT_FAILED = "Signing out didn't work. Check the connection and try again.";
const DELETED_NOTE =
  "Your Leve account is deleted. Your workouts stay on this phone, and nothing syncs until you sign in again.";

/** The account in Settings: Sign in with Apple, or who is signed in and a way to sign out. */
export function AccountSection() {
  const [, setChoice] = useState(0);
  useEffect(() => subscribeServerChoice(() => setChoice((n) => n + 1)), []);
  // Sign in with Apple is native to iOS; other platforms get their sign-in later.
  if (!clerkPublishableKey || Platform.OS !== "ios") return null;
  // It signs in to the build's own server; a paired server signs the phone in with its pairing.
  if (ownServerAvailable() && ownServer()) return null;
  return <Account />;
}

function Account() {
  const styles = useStyles(sheet);
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  const { user } = useUser();
  const { store, change } = useAppData();
  const appleSignIn = useAppleSignIn();
  const syncing = syncEnabled();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Changes that would wait for this account, asked about before signing out. */
  const [unsynced, setUnsynced] = useState<number | null>(null);
  const working = useRef(false);
  /** Asking before deleting the account, and whether it was deleted from here. */
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const canDelete = builtInServerConfigured();
  // Pausing from the sync question or the banner shows here too.
  const [, setPreferences] = useState(0);
  useEffect(() => subscribeDevicePreferences(() => setPreferences((n) => n + 1)), []);
  const paused = syncing && syncPaused();

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
      setSignedOutOnPurpose(false);
      haptic.success();
    }, signInProblem);

  const signOutNow = () =>
    run(
      async () => {
        // Signed out on purpose: don't ask to sign in again (every screen says it isn't syncing).
        // Set first, so the question can't flash up between signing out and this.
        setSignedOutOnPurpose(true);
        try {
          await signOut();
        } catch (error) {
          setSignedOutOnPurpose(false);
          throw error;
        }
      },
      () => SIGN_OUT_FAILED,
    );

  /**
   * This phone keeps its data as its own once the account's synced data is gone: everything it
   * shows stays, unsynced, as if it had never signed in. Only data of this account and server.
   */
  const forgetDeletedAccount = (account: string) => {
    const bound = store.syncState();
    if (bound.server === syncServerUrl && bound.account === account) {
      change((current) => current.forgetAccount());
      writeLastSynced(null);
    }
    setAccountBeingDeleted(null);
    // Nothing of it is left to sync, even if signing out fails below.
    setAccountDeletionState(account, "deleted");
  };

  const deleteAccount = () =>
    run(
      async () => {
        const account = userId;
        if (!account) throw new DeletionProblem(DELETION_FAILED);
        // The Apple sheet: a fresh code to revoke Sign in with Apple with. Dismissed: nothing happens.
        const apple = await appleConfirmation();
        if (apple === null) return;
        // Sync stops meanwhile. If no answer comes back, sync finds out later whether it worked.
        // An earlier attempt may still be unsettled: this one failing can't settle it.
        const earlier = accountBeingDeleted();
        setAccountDeletionState(account, "deleting");
        setAccountBeingDeleted(account);
        try {
          const token = await getToken({ skipCache: true });
          if (!token) throw new DeletionProblem(DELETION_FAILED);
          await requestAccountDeletion({ server: syncServerUrl, token, apple });
        } catch (error) {
          const outcome = error instanceof DeletionProblem ? error.deleted : "nothing";
          if (outcome === "data") forgetDeletedAccount(account);
          else {
            setAccountDeletionState(account, null);
            if (outcome === "nothing") setAccountBeingDeleted(earlier);
          }
          throw error;
        }
        forgetDeletedAccount(account);
        setSignedOutOnPurpose(false);
        setSyncPaused(false);
        setDeleted(true);
        haptic.success();
        announce(DELETED_NOTE);
        // The server ended the session with the account; this only tidies up the phone.
        await signOut().catch(() => {});
      },
      (error) => (error instanceof DeletionProblem ? error.message : DELETION_FAILED),
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
      <Group
        label="Account"
        footnote={
          // Deleted, but signing out didn't work (offline): the session is gone on the server.
          problem ??
          (deleted
            ? DELETED_NOTE
            : paused
              ? SYNC_PAUSED_NOTE
              : syncing
                ? SYNC_SIGNED_IN_NOTE
                : SIGNED_IN_NOTE)
        }
      >
        <SettingRow label="Signed in with Apple" {...(email ? { hint: email } : {})}>
          {null}
        </SettingRow>
        {syncing ? (
          <ActionRow
            label={paused ? "Resume sync" : "Pause sync"}
            divider
            accessibilityHint={
              paused
                ? "Syncs this phone with your account again"
                : "Stops syncing until you resume. Changes stay on this phone"
            }
            onPress={() => setSyncPaused(!paused)}
          />
        ) : null}
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
        {canDelete && !deleted ? (
          <ActionRow
            label="Delete account"
            danger
            divider
            accessibilityHint="Deletes your account and its synced data. Workouts on this phone stay"
            onPress={() => setConfirmingDeletion(true)}
          />
        ) : null}
        {confirmingDeletion ? (
          <Dialog
            eyebrow="Delete account"
            // The Apple sheet opens over it; it closes once deleting is done or didn't work.
            onClose={() => {
              if (!working.current) setConfirmingDeletion(false);
            }}
            confirm={{
              label: busy ? "Deleting…" : "Delete account",
              onPress: () => {
                void deleteAccount().finally(() => setConfirmingDeletion(false));
              },
            }}
          >
            <Text style={styles.warning}>
              This deletes your Leve account and everything synced to it: workouts, routines, notes,
              measurements and settings. AI assistants you connected lose access, and other phones
              signed in to it stop syncing. It can't be undone.
            </Text>
            <Text style={styles.warning}>
              Your workouts stay on this phone, as if you had never signed in. Apple asks you to
              confirm next.
            </Text>
          </Dialog>
        ) : null}
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
              {`${unsynced === 1 ? "1 change hasn't" : `${unsynced} changes haven't`} synced yet. ${unsynced === 1 ? "It stays" : "They stay"} on this phone and ${unsynced === 1 ? "syncs" : "sync"} when you sign in again with this account. Signing in with a different account asks what to do with ${unsynced === 1 ? "it" : "them"} first.`}
            </Text>
          </Dialog>
        ) : null}
      </Group>
    );
  }

  return (
    <Group
      label="Account"
      footnote={
        problem ?? (deleted ? DELETED_NOTE : syncing ? SYNC_SIGNED_OUT_NOTE : SIGNED_OUT_NOTE)
      }
    >
      <AppleSignInButton busy={busy} onPress={signIn} />
    </Group>
  );
}

const sheet = themedStyles((c) => ({
  warning: { ...type.body, fontSize: 15, lineHeight: 22, color: c.fg2, marginTop: space.sm },
}));
