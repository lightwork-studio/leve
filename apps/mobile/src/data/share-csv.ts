import { File, Paths } from "expo-file-system";
import { Share } from "react-native";

/** What became of an exported file: shared from the sheet, the sheet closed, or downloaded. */
export type ShareOutcome = "shared" | "dismissed" | "downloaded";

/** Every exported file's name starts with this (see workout-export.ts). */
const EXPORT_PREFIX = "leve-workouts-";

/**
 * Opens the share sheet with a CSV file, so it can go to Files, AirDrop, Mail or another app. The
 * copy in the cache is removed once the sheet closes.
 */
export async function shareCsv(fileName: string, csv: string): Promise<ShareOutcome> {
  // A copy left by an export the app didn't live to finish goes first.
  for (const entry of Paths.cache.list()) {
    if (entry instanceof File && entry.name.startsWith(EXPORT_PREFIX)) entry.delete();
  }
  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true });
  try {
    file.writeSync(csv);
    // iOS shares a file URL as the file itself.
    const result = await Share.share({ url: file.uri });
    return result.action === Share.sharedAction ? "shared" : "dismissed";
  } finally {
    if (file.exists) file.delete();
  }
}
