// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * One server per data directory. Two processes on the same account databases would each keep
 * their own view of open accounts and restores, so the second refuses to start. The lock is the
 * kernel's: an exclusive SQLite lock on a small file, held for as long as the server runs. The
 * kernel drops it when the process ends however it ends, so a crash never leaves it behind, and
 * it holds between containers sharing a volume on one machine, whose processes may all be PID 1.
 * (Network filesystems may not honour it; keep the data directory on a local disk.)
 */

export const LOCK_FILE = "leve-sync.lock";

export class LockedError extends Error {
  override name = "LockedError";
}

/** Takes the data directory's lock, or throws when another server holds it. Returns a release. */
export function lockDataDirectory(directory: string): () => void {
  const db = new DatabaseSync(join(directory, LOCK_FILE));
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // In exclusive mode the first write takes the lock, and it is kept until the connection closes.
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, pid INTEGER, since TEXT)");
    db.prepare("INSERT OR REPLACE INTO holder (id, pid, since) VALUES (1, ?, ?)").run(
      process.pid,
      new Date().toISOString(),
    );
  } catch (error) {
    db.close();
    if (/locked|busy/i.test((error as Error).message)) {
      throw new LockedError(`another leve-sync server uses ${directory}`);
    }
    throw error;
  }
  return () => db.close();
}
