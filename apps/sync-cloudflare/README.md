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
- **MCP** (`/mcp`) uses stateless Streamable HTTP. It takes a Clerk OAuth access token with the MCP
  endpoint URL as its audience and the `leve:read` scope. Tools can only read the Clerk user's
  synced workouts, progress, routines, notes, measurements and settings.

A missing setting, or a key that can't be read, makes sync answer 503 rather than let anyone in.
A valid key from the wrong instance, an issuer with a trailing `/`, or a token version other than 2
(`v`) refuses every client with 401 instead: if all sign-ins fail, check these first.

**Turning it off:** `npx wrangler@4.158.0 secret delete CLERK_JWT_KEY` stops all sync (503), and
`secret delete ADMIN_TOKEN` closes the admin endpoints. `npx wrangler@4.158.0 rollback` returns to
an earlier version; never deploy a build from before Clerk sign-in, which let the client name its
account. Each version keeps the secrets it was deployed with, so rolling back past a
`secret delete` brings the deleted secret back. Clerk can rotate the instance key: then put the
new PEM in `CLERK_JWT_KEY`. Add `--env=production` to any of these commands to act on the
production Worker.

### Enable MCP in development

1. In the Clerk development instance, [register the full HTTPS MCP URL][clerk-mcp], including
   `/mcp`. Enable JWT access tokens and Include Audience. Allow public clients to connect using
   Client ID Metadata Documents, or register an OAuth client with its own redirect URI and PKCE.
2. Create the `leve:read` custom OAuth scope and grant it to the OAuth clients you want to test.
   For clients that omit a scope request, configure `leve:read` as a default for dynamic clients.
3. From this directory, run `npx wrangler@4.158.0 secret put MCP_RESOURCE_URL` on the development
   Worker and enter the same HTTPS URL. Connect a Streamable HTTP MCP client to that URL and sign
   in with a test account that has synced data.

The Worker publishes OAuth discovery at `/.well-known/oauth-protected-resource/mcp`. Issued JWTs
are accepted until expiry. Delete `MCP_RESOURCE_URL` to turn off MCP immediately while phone sync
continues. Reauthorizing the client may be needed when its audience or scopes change.

[clerk-mcp]: https://clerk.com/docs/guides/ai/mcp/build-mcp-server

## Workers

| Worker           | Clerk instance | Used by                          | Deployed by CI                                          |
| ---------------- | -------------- | -------------------------------- | ------------------------------------------------------- |
| `leve-sync`      | development    | Leve Dev and TestFlight previews | each `main` commit whose `check` passed (Release)       |
| `leve-sync-prod` | production     | App Store builds                 | each new release tag's store build (App Store workflow) |

Both run the same code from `wrangler.jsonc`, each with its own secrets and accounts. The
development Worker is the place to try a server change with the preview app before a release tag
carries it to production.

A CI deploy publishes code only. Secrets are set by hand (below) and carried into every new
version. Each deploy job skips with a warning while its GitHub environment (`sync-development`,
`sync-production`) has no `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The production deploy runs only when App Store releases are enabled (`LEVE_APP_STORE_ENABLED`),
and once `sync-production` holds credentials, the App Store publish waits for it, so a release
never reaches users before its server. Without them the deploy is skipped and the app still
publishes. Only a store build deploys it, and only when every other `vX.Y.Z` release on `main` is
already part of the tagged commit. Otherwise the run fails and the app isn't published, so CI
never moves production back to an older release. OTA fixes don't change the server; a server fix
ships with a new release tag.

A rollback of the development Worker lasts until the next `main` commit deploys over it. A
rollback of the production Worker lasts until a newer release deploys, or until the newest
release's App Store run is re-run; re-running it also queues another store build unless the
`app-store` approval is rejected. To keep either one off, delete its `CLERK_JWT_KEY` instead.

### Setting up CI deploys

1. **Use a separate Cloudflare account for production.** A Workers API token can change every
   Worker in its account, so a development token in the same account could also deploy over,
   roll back or delete `leve-sync-prod`. With two accounts, each environment's token reaches only
   its own Worker.
2. **Protect both GitHub environments before adding secrets.** A workflow run creates a missing
   environment without any protection, so check them even if they already exist. Restrict both to
   the `main` branch. Give `sync-production` the same protection as `app-store`: a separate
   required reviewer and no administrator bypass. Keep Cloudflare secrets out of repository-level
   secrets, which every environment would inherit.
3. **Set a Worker's secrets before its environment's credentials.** Deploy and set the secrets by
   hand once (below); until then the Worker answers 503.

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

## Deploy by hand

CI normally deploys. To deploy or set up a Worker yourself, from `apps/sync-cloudflare`:

```sh
export CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=…   # token from the "Edit Cloudflare Workers" template
pnpm run deploy:dev                                # or deploy:prod
npx wrangler@4.158.0 secret put CLERK_ISSUER   # Frontend API URL, e.g. https://x.clerk.accounts.dev (no trailing /)
npx wrangler@4.158.0 secret put CLERK_JWT_KEY  # API keys → JWT public key → PEM
npx wrangler@4.158.0 secret put ADMIN_TOKEN    # any long random value, for the operator
```

For production, use the production Cloudflare account's credentials, add `--env=production` to
each `secret put`, and use the production Clerk instance's issuer and key. Deploy only a `main`
commit whose `check` passed, and never one older than what production already runs. CI only knows
release tags: after deploying an untagged commit to production by hand, tag a release at or after
it before the next one, or CI could deploy older code over it.

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
