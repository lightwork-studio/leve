import { randomUUID } from "expo-crypto";

/** A new record id. Phones' JavaScript engine has no crypto.randomUUID, so it comes from expo-crypto. */
export const newId = (): string => randomUUID();
