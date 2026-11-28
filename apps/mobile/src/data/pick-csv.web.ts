/** Asks for a CSV file with the browser's file input. Null when the person cancels. */
export function pickCsv(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) resolve(null);
      else file.text().then(resolve, reject);
    });
    input.click();
  });
}
