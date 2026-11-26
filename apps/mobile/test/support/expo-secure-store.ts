// Node stand-in for expo-secure-store in tests: the real module needs the phone's keychain. Tests
// read `keychain` to see what was stored, and set `failWrites` for a keychain that refuses.

export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY";

export interface SecureStoreOptions {
  keychainAccessible?: string;
}

export const keychain = {
  items: new Map<string, { value: string; options: SecureStoreOptions | undefined }>(),
  failWrites: false,
  failReads: false,
  failNextRead: false,
  reset() {
    keychain.items.clear();
    keychain.failWrites = false;
    keychain.failReads = false;
    keychain.failNextRead = false;
  },
};

export function getItem(key: string, _options?: SecureStoreOptions): string | null {
  if (keychain.failReads || keychain.failNextRead) {
    keychain.failNextRead = false;
    throw new Error("the keychain is locked");
  }
  return keychain.items.get(key)?.value ?? null;
}

export function setItem(key: string, value: string, options?: SecureStoreOptions): void {
  if (keychain.failWrites) throw new Error("the keychain refused the item");
  keychain.items.set(key, { value, options });
}

export async function deleteItemAsync(key: string): Promise<void> {
  keychain.items.delete(key);
}
