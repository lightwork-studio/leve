# Sync on one Node server (benchmark)

The sync service as a single Node process with one SQLite file per account. It is the starting
point for the self-hosted package.

**Benchmark only:** every request signs in with one shared token and names its account in the
`x-leve-account` header, like the Cloudflare spike, so the same load script runs against both.

## Run

```sh
openssl rand -hex 32 > token
LEVE_DATA=./data LEVE_TOKEN_FILE=./token PORT=8787 LEVE_SQLITE_WAL=1 pnpm --filter @leve/sync-node start
```

`pnpm --filter @leve/sync-node bundle` builds one file, `dist/server.mjs`, that runs with Node 24
and nothing else. The benchmark server ran it under systemd behind Caddy, which serves HTTPS:

```ini
[Service]
User=leve
Environment=LEVE_DATA=/var/lib/leve/accounts LEVE_TOKEN_FILE=/etc/leve/token PORT=8787 LEVE_SQLITE_WAL=1
ExecStart=/usr/local/bin/node /opt/leve/server.mjs
Restart=always
LimitNOFILE=65536
ProtectSystem=strict
ReadWritePaths=/var/lib/leve
```

```text
sync.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Load tests use `apps/sync-cloudflare/load/run.ts` with `SPIKE_URL` pointing here; `soak 300x20`
creates 300 accounts, 20 at a time.
