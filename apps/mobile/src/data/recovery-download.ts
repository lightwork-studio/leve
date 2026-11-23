import type { BrowserFiles } from "./browser-files.ts";

/** Keep file paths and exact database bytes together in a locally downloadable archive. */
export async function recoveryArchive(files: Pick<BrowserFiles, "paths" | "get">): Promise<Blob> {
  const entries = files.paths().map((path) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Missing database file ${path}`);
    return { path, file: new Blob([new Uint8Array(bytes)]) };
  });
  if (!entries.length) throw new Error("There are no database files to export.");
  const contents = [];
  for (const { path, file } of entries) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Could not read a database file."));
      reader.onload = () => {
        const result = reader.result;
        if (
          typeof result !== "string" ||
          !result.startsWith("data:") ||
          !result.includes(";base64,")
        ) {
          reject(new Error("Could not encode a database file."));
          return;
        }
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.readAsDataURL(file);
    });
    contents.push({ path, base64: data });
  }
  return new Blob([JSON.stringify({ format: "leve-recovery-v1", files: contents })], {
    type: "application/json",
  });
}

export async function downloadRecovery(files: Pick<BrowserFiles, "paths" | "get">): Promise<void> {
  const url = URL.createObjectURL(await recoveryArchive(files));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `leve-recovery-${Date.now()}.json`;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
