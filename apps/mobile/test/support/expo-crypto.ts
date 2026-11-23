import { createHash } from "node:crypto";
// Node stand-in for expo-crypto in tests: the real module needs the phone's native code.
export const randomUUID = (): string => globalThis.crypto.randomUUID();

export const CryptoDigestAlgorithm = { SHA256: "SHA-256" };
export async function digestStringAsync(_algorithm: string, text: string) {
  return createHash("sha256").update(text).digest("hex");
}
