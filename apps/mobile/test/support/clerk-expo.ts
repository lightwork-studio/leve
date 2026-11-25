import { createElement, type ReactNode } from "react";

// Node stand-in for @clerk/expo, its Apple sign-in and expo-apple-authentication in tests: the real
// modules need the phone's native code and Clerk's servers. Tests drive `clerk` directly.

type Flow = () => Promise<{ createdSessionId: string | null; signUp?: { status: string } }>;

export const clerk = {
  loaded: true,
  signedIn: false,
  userId: "user_1",
  email: undefined as string | undefined,
  /** What tapping Sign in with Apple does; by default it signs in as someone. */
  appleFlow: (async () => ({ createdSessionId: "sess_1" })) as Flow,
  calls: [] as string[],
  signOutFails: false,
  providerProps: null as Record<string, unknown> | null,
  reset() {
    clerk.signOutFails = false;
    clerk.providerProps = null;
    clerk.loaded = true;
    clerk.signedIn = false;
    clerk.userId = "user_1";
    clerk.email = undefined;
    clerk.appleFlow = async () => ({ createdSessionId: "sess_1" });
    clerk.calls = [];
  },
};

export class ClerkAPIResponseError extends Error {
  constructor(public errors: { message: string; longMessage?: string }[]) {
    super(errors[0]?.message);
  }
}
export const isClerkAPIResponseError = (error: unknown): error is ClerkAPIResponseError =>
  error instanceof ClerkAPIResponseError;

export const ClerkProvider = ({ children, ...props }: { children: ReactNode }) => {
  clerk.providerProps = props;
  return children;
};
export const tokenCache = { name: "tokenCache" };
export const resourceCache = () => ({ name: "resourceCache" });

export function useAuth() {
  return {
    isLoaded: clerk.loaded,
    isSignedIn: clerk.loaded && clerk.signedIn,
    userId: clerk.loaded && clerk.signedIn ? clerk.userId : null,
    getToken: async (_options?: { skipCache?: boolean }) =>
      clerk.signedIn ? `token-${clerk.userId}` : null,
    signOut: async () => {
      clerk.calls.push("signOut");
      if (clerk.signOutFails) throw new TypeError("Network request failed");
      clerk.signedIn = false;
    },
  };
}

export function useUser() {
  return {
    user:
      clerk.signedIn && clerk.email ? { primaryEmailAddress: { emailAddress: clerk.email } } : null,
  };
}

export function useSignInWithApple() {
  return {
    startAppleAuthenticationFlow: async () => {
      clerk.calls.push("apple");
      const { createdSessionId, signUp } = await clerk.appleFlow();
      return {
        createdSessionId,
        signUp,
        setActive: async ({ session }: { session: string }) => {
          clerk.calls.push(`setActive ${session}`);
          clerk.signedIn = true;
        },
      };
    },
  };
}

export const AppleAuthenticationButtonType = { SIGN_IN: 0 };
export const AppleAuthenticationButtonStyle = { WHITE: 0, BLACK: 2 };
export function AppleAuthenticationButton({
  onPress,
  buttonStyle,
}: {
  onPress: () => void;
  buttonStyle: number;
}) {
  return createElement(
    "button",
    { type: "button", onClick: onPress, "data-style": buttonStyle === 2 ? "black" : "white" },
    "Sign in with Apple",
  );
}
