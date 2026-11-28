import type { ShareOutcome } from "./share-csv.ts";

/** Browsers have no share sheet for files here: the CSV is downloaded. */
export async function shareCsv(fileName: string, csv: string): Promise<ShareOutcome> {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return "downloaded";
}
