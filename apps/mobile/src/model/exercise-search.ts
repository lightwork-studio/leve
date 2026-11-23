/** Common compound movement names occur both joined and separated in the catalog. */
function searchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[\s_(),./‐‑‒–—-]+/g, " ")
    .replace(/\b(pull|push|chin|sit|step|muscle) ?ups?\b/g, "$1up")
    .trim();
}

/** Compile a query once, then match displayed names, aliases and optional picker details. */
export function exerciseMatcher(query: string) {
  const literal = query.trim().toLowerCase();
  const normalized = searchText(query);
  const words = normalized.split(" ");
  const compactQuery = normalized.replaceAll(" ", "");

  return (names: string[], details = "") => {
    const literalNames = names.join(" ").toLowerCase();
    if (!normalized) return literalNames.includes(literal) ? "partial" : undefined;

    const normalizedNames = names.map(searchText);
    const compactNames = normalizedNames.map((name) => name.replaceAll(" ", ""));
    if (compactNames.includes(compactQuery)) return "exact";

    const text = [literalNames, ...normalizedNames, ...compactNames, searchText(details)].join(" ");
    return words.every((word) => text.includes(word)) ? "partial" : undefined;
  };
}
