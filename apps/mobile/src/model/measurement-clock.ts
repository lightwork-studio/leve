const dayMs = 86_400_000;

function offsetLabel(milliseconds: number) {
  const totalSeconds = Math.abs(milliseconds) / 1000;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  const hours = twoDigits(Math.floor(totalSeconds / 3600));
  const minutes = twoDigits(Math.floor(totalSeconds / 60) % 60);
  const seconds = totalSeconds % 60;
  const sign = milliseconds < 0 ? "-" : "+";
  const clockOffset = `UTC${sign}${hours}:${minutes}`;
  return seconds ? `${clockOffset}:${twoDigits(seconds)}` : clockOffset;
}

/** Resolve local measurement times using the platform's zone database, including non-hour shifts. */
export function measurementClock(timeZone?: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function localTimestamp(at: number) {
    const parts = Object.fromEntries(
      formatter.formatToParts(at).map(({ type, value }) => [type, value]),
    );
    const day = `${parts.year?.padStart(4, "0")}-${parts.month}-${parts.day}`;
    return `${day}T${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function offsetAt(at: number) {
    return Date.parse(`${localTimestamp(at)}Z`) - Math.floor(at / 1000) * 1000;
  }

  function nearbyOffsets(wall: number) {
    return new Set([offsetAt(wall - dayMs), offsetAt(wall + dayMs)]);
  }

  function choices(day: string, time: string) {
    const local = `${day}T${time}:00`;
    const wall = Date.parse(`${local}Z`);
    if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== local) return [];
    // The civil day can straddle a transition. Try offsets on each side, then check the
    // actual local time at each candidate to discard gaps and keep both repeated instants.
    const offsets = nearbyOffsets(wall);
    return Array.from(offsets, (offset) => ({ at: wall - offset, offset: offsetLabel(offset) }))
      .filter(({ at }) => Number.isFinite(at) && localTimestamp(at) === local)
      .sort((a, b) => a.at - b.at);
  }

  function repeatedOffset(at: number) {
    const offset = offsetAt(at);
    const start = Math.floor((at + offset) / 60_000) * 60_000;
    // A historical rollback can repeat just part of the minute shown on a row.
    for (const other of nearbyOffsets(start)) {
      if (
        other !== offset &&
        (offsetAt(start - other) === other || offsetAt(start + 59_999 - other) === other)
      )
        return offsetLabel(offset);
    }
    return null;
  }

  return { localTimestamp, choices, repeatedOffset };
}
