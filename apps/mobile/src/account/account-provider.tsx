import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import type { ReactNode } from "react";
import { clerkPublishableKey } from "./clerk-key.ts";

/**
 * Makes the signed-in account available to the screens. It never holds them back: the app opens
 * and logs workouts the same signed in or out, online or offline. The session is kept in the
 * device's keychain, so it survives restarts.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  if (!clerkPublishableKey) return children;
  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      tokenCache={tokenCache}
      // The app draws its own sign-in and never uses Clerk's native screens.
      __experimental_disableNativeClientSync
      updateRequiredViewEnabled={false}
    >
      {children}
    </ClerkProvider>
  );
}
