/** Number the visible groups in workout order and link each member to the next one. */
export function supersetMemberships(groupIds: readonly (number | null | undefined)[]) {
  const groups = new Map<number, number[]>();
  groupIds.forEach((id, index) => {
    if (id == null) return;
    const members = groups.get(id);
    if (members) members.push(index);
    else groups.set(id, [index]);
  });
  const result = groupIds.map((): { label: string; next: number } | undefined => undefined);
  let groupNumber = 0;
  for (const members of groups.values()) {
    const first = members[0];
    if (first === undefined || members.length < 2) continue;
    groupNumber += 1;
    const label = `Superset ${groupNumber}`;
    members.forEach((index, i) => {
      result[index] = { label, next: members[i + 1] ?? first };
    });
  }
  return result;
}

export function supersetLabels(groupIds: readonly (number | null | undefined)[]) {
  return supersetMemberships(groupIds).map((member) => member?.label);
}

/** Group adjacent routine entries without changing the membership of any other group. */
export function pairWithPrevious<T extends { id: string; supersetId?: number | null }>(
  entries: T[],
  previousId: string,
  id: string,
) {
  const index = entries.findIndex((entry) => entry.id === id);
  const current = entries[index];
  const previous = entries[index - 1];
  if (!current || !previous || previous.id !== previousId) return entries;
  if (
    current.supersetId != null &&
    entries.some((e) => e !== current && e.supersetId === current.supersetId)
  )
    return entries;
  let group = previous.supersetId;
  if (group == null) {
    const used = new Set(entries.map((entry) => entry.supersetId));
    group = 0;
    while (used.has(group)) group++;
  }
  return entries.map((entry) =>
    entry === current || entry === previous ? { ...entry, supersetId: group } : entry,
  );
}

/** When a pair splits, both entries return to ordinary exercises. Larger groups remain intact. */
export function leaveSuperset<T extends { id: string; supersetId?: number | null }>(
  entries: T[],
  id: string,
) {
  const group = entries.find((entry) => entry.id === id)?.supersetId;
  if (group == null) return entries;
  const others = entries.filter((entry) => entry.id !== id && entry.supersetId === group);
  return entries.map((entry) =>
    entry.supersetId === group && (entry.id === id || others.length < 2)
      ? { ...entry, supersetId: null }
      : entry,
  );
}
