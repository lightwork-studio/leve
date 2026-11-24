# Sync on Cloudflare

The sync service running on Cloudflare Workers, with one SQLite-backed Durable Object per
account.

## Sign-in

- **Sync** (`/sync/*`) needs a Clerk session token as `Authorization: Bearer …`. The Worker checks
  it without a network call against the instance's public key, and the account is the signed-in
  Clerk user: a request can't name any other account. A session with steps left to finish, and a
  web origin not listed in `CLERK_AUTHORIZED_PARTIES`, are refused.
- **Admin** (`/admin/*`) needs the operator token (`ADMIN_TOKEN`) and names the account in the
  `x-leve-account` header. Without `ADMIN_TOKEN` the admin endpoints are closed.

Missing Clerk settings make sync answer 503 rather than let anyone in. To roll back sign-in
changes, deploy the previous version with `npx wrangler@4.158.0 rollback`.

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
npx wrangler@4.158.0 secret put CLERK_ISSUER   # the instance's Frontend API URL
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
