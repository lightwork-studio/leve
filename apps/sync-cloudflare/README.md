# Sync on Cloudflare (spike)

The sync service running on Cloudflare Workers, with one SQLite-backed Durable Object per
account.

**Spike only:** every request signs in with one shared token and names its account in the
`x-leve-account` header. Real sign-in replaces both before any real data goes here, and the admin
endpoints then need their own operator sign-in: today the shared token opens them for every account.

## Layout

- `src/worker.ts` checks the token and routes each request to the account's object.
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
npx wrangler@4.158.0 secret put SPIKE_TOKEN           # any long random value
```

## Load tests

```sh
cd apps/sync-cloudflare
export SPIKE_URL=https://leve-sync-spike.<subdomain>.workers.dev SPIKE_TOKEN_FILE=path/to/token
node load/run.ts upload heavy1 52   # a phone with 52 weeks of history uploads it
node load/run.ts download heavy1    # a new phone downloads everything
node load/run.ts log heavy1         # phone A logs one workout; phone B syncs
node load/run.ts fanout fan 40      # 40 new accounts sync at once
node load/run.ts stats heavy1       # also: export, bookmark, restore <bookmark>, delete
```

Phones and the request log (`samples.ndjson`) are kept in `~/.cache/leve-cf-spike`. On the free
plan the whole Cloudflare account may write 100,000 rows a day, about a year of history; past
that, requests fail until midnight UTC instead of costing money.
