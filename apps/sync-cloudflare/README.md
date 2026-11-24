# Sync on Cloudflare

The sync service running on Cloudflare Workers, with one SQLite-backed Durable Object per
account.

## Sign-in

- **Sync** (`/sync/*`) needs a Clerk session token as `Authorization: Bearer …`. The Worker checks
  it without a network call against the instance's public key, and the account is the signed-in
  Clerk user: a request can't name any other account. Only session tokens of an active session
  count: JWT templates and access tokens signed by the same instance, a session with steps left to
  finish, and a web origin not listed in `CLERK_AUTHORIZED_PARTIES` are refused.
- **Admin** (`/admin/*`) needs the operator token (`ADMIN_TOKEN`, at least 32 characters) and names
  the account in the `x-leve-account` header. Without it the admin endpoints are closed.

A missing setting, or a key that can't be read, makes sync answer 503 rather than let anyone in.
A valid key from the wrong instance, an issuer with a trailing `/`, or a token version other than 2
(`v`) refuses every client with 401 instead: if all sign-ins fail, check these first.

**Turning it off:** `npx wrangler@4.158.0 secret delete CLERK_JWT_KEY` stops all sync (503), and
`secret delete ADMIN_TOKEN` closes the admin endpoints. `npx wrangler@4.158.0 rollback` returns to
an earlier version of `leve-sync`; never deploy a build from before Clerk sign-in, which let the
client name its account. Each version keeps the secrets it was deployed with, so rolling back
past a `secret delete` brings the deleted secret back. Clerk can rotate the instance key: then put
the new PEM in `CLERK_JWT_KEY`.

## Layout

- `src/gate.ts` decides which account a request may reach and hands it to that account's object;
  `src/session-token.ts` checks Clerk session tokens.
- `src/account-object.ts` holds one account: it runs the sync service and has admin endpoints for
  stats, export, point-in-time restore and deletion. A small marker object per account remembers a
  restore in progress, so the restored account starts a new lineage before it answers anything.
- `src/account-db.ts` creates the account database and turns service replies into responses.
- `src/do-sql.ts` adapts the object's SQLite database to the storage packages. Objects refuse
  `BEGIN`, so transactions use `transactionSync`.
- `load/` drives the real phone storage and sync client against a deployed Worker and logs what
  each request cost.

## Deploy

```sh
export CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=…   # token from the "Edit Cloudflare Workers" template
pnpm --filter @leve/sync-cloudflare deploy
npx wrangler@4.158.0 secret put CLERK_ISSUER   # Frontend API URL, e.g. https://x.clerk.accounts.dev (no trailing /)
npx wrangler@4.158.0 secret put CLERK_JWT_KEY  # API keys → JWT public key → PEM
npx wrangler@4.158.0 secret put ADMIN_TOKEN    # any long random value, for the operator
```

## Load tests

```sh
cd apps/sync-cloudflare
# Accounts are test users of a Clerk development instance, created on first use.
export SPIKE_URL=https://leve-sync.<subdomain>.workers.dev
export CLERK_SECRET_KEY_FILE=path/to/sk_test ADMIN_TOKEN_FILE=path/to/admin-token
node load/run.ts upload heavy1 52   # a phone with 52 weeks of history uploads it
node load/run.ts download heavy1    # a new phone downloads everything
node load/run.ts log heavy1         # phone A logs one workout; phone B syncs
node load/run.ts fanout fan 40      # 40 new accounts sync at once
node load/run.ts stats heavy1       # also: export, bookmark, restore <bookmark>, delete
```

Phones and the request log (`samples.ndjson`) are kept in `~/.cache/leve-cf-spike`. On the free
plan the whole Cloudflare account may write 100,000 rows a day, about a year of history; past
that, requests fail until midnight UTC instead of costing money.
