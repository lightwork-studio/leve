import type { ReactNode } from "react";

/** Browser previews have no sign-in. */
export function AccountProvider({ children }: { children: ReactNode }) {
  return children;
}
