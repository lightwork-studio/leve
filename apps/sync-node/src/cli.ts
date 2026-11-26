// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from "node:path";
import type { Account, Device } from "./accounts.ts";
import { adminRequest } from "./admin.ts";

export const ADMIN_USAGE = `leve-sync admin <command>

  accounts add <name>          create an account
  accounts list                list accounts and how many phones each has
  pair <account>               print a one-time pairing link for a new phone (15 minutes)
  devices list [<account>]     list paired phones
  devices revoke <device-id>   sign one phone out for good
  devices revoke --all <account>
                               sign every phone of an account out
  devices revoke --everyone    sign every phone of every account out
  stats <account>              what an account holds: records, revision, lineage
  backup <folder>              copy every account and accounts.db into a new dated folder
  restore <account> <file> [--other-account]
                               put one account back from a backed-up account-<id>.db; its
                               phones download everything again and offer back what it lacks

Options: --json prints the server's answer as JSON.
The command talks to the running server through LEVE_ADMIN_SOCKET.`;

export class UsageError extends Error {
  override name = "UsageError";
}

const refuse = (message: string): never => {
  throw new UsageError(message);
};

/** Runs one admin command and returns what to print. */
export async function runAdmin(socket: string, args: readonly string[]): Promise<string> {
  const asJson = args.includes("--json");
  const otherAccount = args.includes("--other-account");
  const words = args.filter((arg) => arg !== "--json" && arg !== "--other-account");
  const [group, action, ...rest] = words;
  const call = (command: string, body: Record<string, unknown> = {}) =>
    adminRequest(socket, command, body);
  const one = (what: string) => {
    if (rest.length !== 1) throw new UsageError(`give the ${what}`);
    return rest[0] as string;
  };
  const show = (result: unknown, format: (value: never) => string) =>
    asJson ? JSON.stringify(result, null, 2) : format(result as never);

  if (group === "accounts" && action === "add") {
    if (rest.length === 0) throw new UsageError("give the account's name");
    const result = await call("/accounts/add", { name: rest.join(" ") });
    return show(
      result,
      (a: Account) => `Created ${a.name} (${a.id}). Pair a phone: leve-sync admin pair "${a.name}"`,
    );
  }
  if (group === "accounts" && action === "list") {
    const result = await call("/accounts/list");
    return show(result, (list: Account[]) =>
      list.length === 0
        ? "No accounts yet. Create one: leve-sync admin accounts add <name>"
        : list
            .map((a) => `${a.name}\t${a.id}\t${a.devices} phone${a.devices === 1 ? "" : "s"}`)
            .join("\n"),
    );
  }
  if (group === "pair") {
    const account = [action, ...rest].filter(Boolean).join(" ");
    if (!account) throw new UsageError("give the account");
    const result = await call("/pair", { account });
    return show(
      result,
      (p: { account: string; code: string; link: string | null; expiresAt: string }) =>
        p.link
          ? `Pairing link for ${p.account}, valid once until ${p.expiresAt}:\n\n  ${p.link}\n\nOpen it on the phone, or show it as a QR code (qrencode -t ansiutf8 '<link>') for the phone's camera.`
          : `Pairing code for ${p.account}, valid once until ${p.expiresAt}: ${p.code}\nSet LEVE_PUBLIC_URL on the server to get a link the phone can open.`,
    );
  }
  if (group === "devices" && action === "list") {
    const result = await call("/devices/list", rest.length ? { account: rest.join(" ") } : {});
    return show(result, (list: Device[]) =>
      list.length === 0
        ? "No paired phones."
        : list
            .map(
              (d) =>
                `${d.id}\t${d.name}\taccount ${d.account}\tpaired ${d.createdAt}\tlast seen ${d.lastUsedAt ?? "never"}`,
            )
            .join("\n"),
    );
  }
  if (group === "devices" && action === "revoke") {
    const result =
      rest[0] === "--everyone"
        ? rest.length === 1
          ? await call("/devices/revoke", { everyone: true })
          : refuse("--everyone signs out every phone of every account; give nothing else")
        : rest[0] === "--all"
          ? await call("/devices/revoke", { all: true, account: rest.slice(1).join(" ") })
          : await call("/devices/revoke", { device: one("device id") });
    return show(
      result,
      (r: { revoked: number }) => `Signed out ${r.revoked} phone${r.revoked === 1 ? "" : "s"}.`,
    );
  }
  if (group === "stats") {
    const account = [action, ...rest].filter(Boolean).join(" ");
    if (!account) throw new UsageError("give the account");
    return JSON.stringify(await call("/stats", { account }), null, 2);
  }
  if (group === "backup") {
    if (!action || rest.length) throw new UsageError("give the folder to back up into");
    // The server writes the copies, so it needs the folder as an absolute path.
    const result = (await call("/backup", { to: resolve(action) })) as {
      folder: string;
      manifest: { failed: { name: string; error: string }[]; unknown: string[] };
    };
    // A backup that missed accounts fails the command, so a scheduled run is noticed.
    const { failed, unknown } = result.manifest;
    const strays = unknown.length
      ? `\nNot copied, as no account names them: ${unknown.join(", ")}`
      : "";
    if (failed.length > 0) {
      throw new Error(
        `backed up to ${result.folder}, but ${failed.length} account${failed.length === 1 ? "" : "s"} couldn't be copied: ${failed.map((f) => `${f.name} (${f.error})`).join("; ")}${strays}`,
      );
    }
    return show(
      result,
      (b: { folder: string; manifest: { accounts: unknown[] } }) =>
        `Backed up ${b.manifest.accounts.length} account${b.manifest.accounts.length === 1 ? "" : "s"} and accounts.db to ${b.folder}${strays}`,
    );
  }
  if (group === "restore") {
    const parts = [action, ...rest].filter(Boolean) as string[];
    if (parts.length < 2) throw new UsageError("give the account and the backed-up account file");
    const file = resolve(parts.pop() as string);
    const result = await call("/restore", { account: parts.join(" "), from: file, otherAccount });
    return show(
      result,
      (r: { account: string; replaced: string | null; revision: number }) =>
        `Restored ${r.account} to revision ${r.revision}. Its phones download everything again and offer back what the backup lacks.${r.replaced ? `\nThe database it replaced is kept at ${r.replaced}.` : ""}`,
    );
  }
  throw new UsageError(ADMIN_USAGE);
}
