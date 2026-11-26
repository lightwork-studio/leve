# Sync on one Node server

The sync service as a single Node process with one SQLite file per account, for running your own
sync server. Development preview: use disposable data until Leve declares that it keeps real data.

## Accounts and phones

The server has its own accounts, which its operator creates. A phone joins an account by pairing
once with a one-time link, and from then on signs in with a device token of its own. The token
decides the account: a request can't name another one. The server stores only hashes of tokens
and pairing codes, in `accounts.db` next to the account databases.

Administration runs on a Unix socket that only the server's user can open (mode 0600), never on
the public listener. `leve-sync admin` talks to it:

```sh
leve-sync admin accounts add Alice        # create an account
leve-sync admin pair Alice                # one-time pairing link, valid 15 minutes
leve-sync admin devices list Alice        # paired phones and when each was last seen
leve-sync admin devices revoke <id>       # sign one phone out for good
leve-sync admin devices revoke --all Alice
```

A pairing link opens a page on the server that hands the code to the app. The code is in the
link's fragment, which browsers don't send, so it stays out of access logs. To show it as a QR code
for the phone's camera: `qrencode -t ansiutf8 '<link>'`.

## Run

```sh
LEVE_DATA=./data LEVE_PUBLIC_URL=https://sync.example.com pnpm --filter @leve/sync-node start
pnpm --filter @leve/sync-node admin accounts add Alice
```

| Setting             | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `LEVE_DATA`         | Directory for the account databases and `accounts.db` (default `./data`) |
| `LEVE_PUBLIC_URL`   | How phones reach the server, for pairing links                           |
| `LEVE_ADMIN_SOCKET` | The admin socket (default `$RUNTIME_DIRECTORY/admin.sock`, else in data) |
| `LEVE_PAIRING=off`  | Stop pairing new phones; paired phones keep syncing                      |
| `HOST`, `PORT`      | The public listener (default `127.0.0.1:8787`); put HTTPS in front of it |
| `LEVE_SQLITE_WAL=1` | Write-ahead logging for account databases: one disk sync per commit      |

To cut every phone off at once, run `devices revoke --all` for each account. Phones keep their
data, and sync stops until they pair again.

`pnpm --filter @leve/sync-node bundle` builds one file, `dist/server.mjs`, that runs with Node 24
and nothing else. The benchmark server ran it under systemd behind Caddy, which serves HTTPS:

```ini
[Service]
User=leve
Environment=LEVE_DATA=/var/lib/leve/accounts PORT=8787 LEVE_SQLITE_WAL=1
Environment=LEVE_PUBLIC_URL=https://sync.example.com
ExecStart=/usr/local/bin/node /opt/leve/server.mjs serve
RuntimeDirectory=leve
RuntimeDirectoryMode=0700
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

## Benchmark mode

`LEVE_AUTH=benchmark` with `LEVE_TOKEN_FILE` replaces accounts with one shared token: every
request names its account in the `x-leve-account` header, so anyone with the token reaches every
account. It exists so the Cloudflare load script runs against this server too, and serves a stats
route on the public listener. Never use it for real data.

```sh
openssl rand -hex 32 > token
LEVE_AUTH=benchmark LEVE_TOKEN_FILE=./token LEVE_DATA=./data pnpm --filter @leve/sync-node start
```

Load tests use `apps/sync-cloudflare/load/run.ts` with `SPIKE_URL` pointing here; `soak 300x20`
creates 300 accounts, 20 at a time.
