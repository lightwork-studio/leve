// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

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

Options: --json prints the server's answer as JSON.
The command talks to the running server through LEVE_ADMIN_SOCKET.`;

export class UsageError extends Error {
  override name = "UsageError";
}

/** Runs one admin command and returns what to print. */
export async function runAdmin(socket: string, args: readonly string[]): Promise<string> {
  const asJson = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
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
    const all = rest[0] === "--all";
    const result = all
      ? await call("/devices/revoke", { all: true, account: rest.slice(1).join(" ") })
      : await call("/devices/revoke", { device: one("device id") });
    return show(
      result,
      (r: { revoked: number }) => `Signed out ${r.revoked} phone${r.revoked === 1 ? "" : "s"}.`,
    );
  }
  throw new UsageError(ADMIN_USAGE);
}
