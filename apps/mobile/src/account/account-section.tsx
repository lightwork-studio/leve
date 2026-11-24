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
  "Signing in keeps a copy of your workouts with Leve, so a new phone can pick up where this one left off. Syncing arrives in a coming update. Everything keeps working without an account.";
const SIGNED_IN_NOTE =
  "Your workouts stay on this device too. Syncing arrives in a coming update. Signing out keeps everything here.";

/** What to tell someone when signing in didn't work. */
export function signInProblem(error: unknown): string {
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

  const show = (message: string) => {
    haptic.warning();
    setProblem(message);
    announce(message);
  };

  const run = async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      show(signInProblem(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const signIn = () =>
    run(async () => {
      const { createdSessionId, setActive } = await startAppleAuthenticationFlow();
      // No session means the sheet was dismissed: nothing to report.
      if (!createdSessionId || !setActive) return;
      await setActive({ session: createdSessionId });
      haptic.success();
    });

  const note = problem ?? (isSignedIn ? SIGNED_IN_NOTE : SIGNED_OUT_NOTE);

  if (isLoaded && isSignedIn) {
    const email = user?.primaryEmailAddress?.emailAddress;
    return (
      <Group label="Account" footnote={note}>
        <SettingRow label="Signed in with Apple" {...(email ? { hint: email } : {})}>
          {null}
        </SettingRow>
        <ActionRow
          label={busy ? "Signing out…" : "Sign out"}
          divider
          accessibilityHint="Your workouts stay on this device"
          onPress={() => run(() => signOut())}
        />
      </Group>
    );
  }

  return (
    <Group label="Account" footnote={isLoaded ? note : (problem ?? "Sign-in needs a connection.")}>
      <View style={styles.signIn} pointerEvents={isLoaded && !busy ? "auto" : "none"}>
        <AppleAuthenticationButton
          buttonType={AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={
            appearance === "paper"
              ? AppleAuthenticationButtonStyle.BLACK
              : AppleAuthenticationButtonStyle.WHITE
          }
          cornerRadius={radius.button}
          style={[styles.appleButton, !(isLoaded && !busy) && styles.waiting]}
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
