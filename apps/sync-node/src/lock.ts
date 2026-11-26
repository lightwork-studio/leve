// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * One server per data directory. Two processes on the same account databases would each keep
 * their own view of open accounts and restores, so the second refuses to start. The lock is a file
 * naming the process that holds it; one left by a process that has stopped is taken over.
 */

export const LOCK_FILE = "leve-sync.pid";

export class LockedError extends Error {
  override name = "LockedError";
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // It exists but belongs to someone else: still running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the data directory's lock, or throws when a running server holds it. Returns a release. */
export function lockDataDirectory(directory: string): () => void {
  const path = join(directory, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number(readFileSync(path, "utf8").trim());
    // Our own pid in the file is a previous run that had it too, as PID 1 in a container does.
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && running(holder)) {
      throw new LockedError(`another leve-sync server (process ${holder}) uses ${directory}`);
    }
    // Left by a server that stopped without releasing it.
    rmSync(path, { force: true });
  }
  throw new LockedError(`couldn't lock ${directory}`);
}
