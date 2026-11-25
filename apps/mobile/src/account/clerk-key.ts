/**
 * The Clerk instance the app signs in with. Builds without it (local development, browser
 * previews, tests) have no sign-in, and the app works exactly as before.
 */
export const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
