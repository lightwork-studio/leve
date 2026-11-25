import { isClerkAPIResponseError } from "@clerk/expo";
import { useSignInWithApple } from "@clerk/expo/apple";

/** Clerk wanted more than Apple gave it, so no account was made. */
const INCOMPLETE =
  "Leve couldn't finish setting up the account. Nothing was changed; try again later.";

/** A problem whose message is already meant for people. */
export class AccountProblem extends Error {}

/** What to tell someone when signing in didn't work. */
export function signInProblem(error: unknown): string {
  if (error instanceof AccountProblem) return error.message;
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0];
    return first?.longMessage ?? first?.message ?? "Sign-in didn't work. Try again.";
  }
  return "Sign-in didn't work. Check the connection and try again.";
}

/**
 * Signs in with Apple through Clerk. Resolves to whether someone signed in; false when the sheet was
 * dismissed. Throws when it didn't work (see signInProblem).
 */
export function useAppleSignIn(): () => Promise<boolean> {
  const { startAppleAuthenticationFlow } = useSignInWithApple();
  return async () => {
    const { createdSessionId, setActive, signUp } = await startAppleAuthenticationFlow();
    if (!createdSessionId || !setActive) {
      if (signUp?.status === "missing_requirements") throw new AccountProblem(INCOMPLETE);
      return false;
    }
    await setActive({ session: createdSessionId });
    return true;
  };
}
