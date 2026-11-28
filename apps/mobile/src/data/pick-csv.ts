import { File } from "expo-file-system";

/** Asks for a CSV file with the system file picker. Null when the person cancels. */
export async function pickCsv(): Promise<string | null> {
  const picked = await File.pickFileAsync({
    mimeTypes: ["text/csv", "text/comma-separated-values"],
  });
  return picked.canceled ? null : picked.result.text();
}
