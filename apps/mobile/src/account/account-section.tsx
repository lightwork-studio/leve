import { isClerkAPIResponseError, useAuth, useUser } from "@clerk/expo";
import { useSignInWithApple } from "@clerk/expo/apple";
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from "expo-apple-authentication";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";
import { radius, space } from "../theme.ts";
import { ActionRow, SettingRow } from "../ui/choice-row.tsx";
import { announce } from "../ui/focus.ts";
import { Group } from "../ui/group.tsx";
import { haptic } from "../ui/haptics.ts";
import { themedStyles, useAppearance, useStyles } from "../ui/themed.ts";
import { clerkPublishableKey } from "./clerk-key.ts";

const SIGNED_OUT_NOTE =
  "For now, signing in only sets up your account, and your workouts stay on this phone. Once syncing arrives, they back up to it and follow you to a new phone. Everything works without an account.";
const SIGNED_IN_NOTE =
  "Your workouts are still only on this phone. Once syncing arrives, they back up to this account. Signing out keeps everything here.";
const OFFLINE_NOTE = "Sign-in needs a connection. It appears here once Leve is back online.";
const SIGN_OUT_FAILED = "Signing out didn't work. Check the connection and try again.";
/** Clerk wanted more than Apple gave it, so no account was made. */
const INCOMPLETE =
  "Leve couldn't finish setting up the account. Nothing was changed; try again later.";

/** A problem whose message is already meant for people. */
class AccountProblem extends Error {}

/** What to tell someone when signing in didn't work. */
export function signInProblem(error: unknown): string {
  if (error instanceof AccountProblem) return error.message;
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0];
    return first?.longMessage ?? first?.message ?? "Sign-in didn't work. Try again.";
  }
  return "Sign-in didn't work. Check the connection and try again.";
}

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
  const { startAppleAuthenticationFlow } = useSignInWithApple();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      const { createdSessionId, setActive, signUp } = await startAppleAuthenticationFlow();
      if (!createdSessionId || !setActive) {
        if (signUp?.status === "missing_requirements") throw new AccountProblem(INCOMPLETE);
        // Otherwise the sheet was dismissed: nothing to report.
        return;
      }
      await setActive({ session: createdSessionId });
      haptic.success();
    }, signInProblem);

  if (!isLoaded) {
    // Clerk keeps trying in the background; the button appears once it can be used.
    return (
      <Group label="Account" footnote={OFFLINE_NOTE}>
        {null}
      </Group>
    );
  }

  if (isSignedIn) {
    const email = user?.primaryEmailAddress?.emailAddress;
    return (
      <Group label="Account" footnote={problem ?? SIGNED_IN_NOTE}>
        <SettingRow label="Signed in with Apple" {...(email ? { hint: email } : {})}>
          {null}
        </SettingRow>
        <ActionRow
          label={busy ? "Signing out…" : "Sign out"}
          divider
          accessibilityHint="Your workouts stay on this phone"
          onPress={() =>
            run(
              () => signOut(),
              () => SIGN_OUT_FAILED,
            )
          }
        />
      </Group>
    );
  }

  return (
    <Group label="Account" footnote={problem ?? SIGNED_OUT_NOTE}>
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

const sheet = themedStyles(() => ({
  signIn: { padding: space.md },
  appleButton: { height: 44, width: "100%" },
  waiting: { opacity: 0.5 },
}));
