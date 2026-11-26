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
leve-sync admin devices revoke --everyone # the off switch: every phone of every account
```

Run it as the server's user with the same `LEVE_ADMIN_SOCKET` (or `LEVE_DATA`) as the server.

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

To cut every phone off at once, run `devices revoke --everyone`. Phones keep their data, and sync
stops until they pair again.

`pnpm --filter @leve/sync-node bundle` builds one file, `dist/server.mjs`, that runs with Node 24
and nothing else. The benchmark server ran it under systemd behind Caddy, which serves HTTPS:

```ini
[Service]
User=leve
Environment=LEVE_DATA=/var/lib/leve/accounts PORT=8787 LEVE_SQLITE_WAL=1
Environment=LEVE_PUBLIC_URL=https://sync.example.com LEVE_ADMIN_SOCKET=/run/leve/admin.sock
ExecStart=/usr/local/bin/node /opt/leve/server.mjs serve
RuntimeDirectory=leve
RuntimeDirectoryMode=0700
Restart=always
LimitNOFILE=65536
ProtectSystem=strict
ReadWritePaths=/var/lib/leve
```

Administer it as the same user, with the same socket:

```sh
sudo -u leve LEVE_ADMIN_SOCKET=/run/leve/admin.sock node /opt/leve/server.mjs admin accounts list
```

```text
sync.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

## Backups and restores

```sh
leve-sync admin backup /var/backups/leve       # every account and accounts.db, while it runs
leve-sync admin stats Alice                    # revision, lineage, records
leve-sync admin restore Alice /var/backups/leve/leve-<time>/account-<id>.db
```

A backup is a new folder named for its time, holding a SQLite backup of each account database,
`accounts.db` and a `manifest.json`, all readable by the server's user only. It is consistent while
phones keep syncing. The manifest is written last, so a folder without one is an unfinished
backup. If an account can't be copied (say its database is damaged), the others still are, the
manifest lists it under `failed` and the command exits with an error, so a scheduled backup is
noticed. The server writes the folder, so it must be writable by the server's user. Copy the
folders off the machine with the tool you already use (restic, borg, rsync).

Restoring checks the copy before replacing anything, keeps the database it replaces next to it
(`account-<id>.db.replaced-<time>`, which `restore` also accepts, to undo), and gives the account
a new lineage. Its phones notice, download everything again and offer back what the backup lacks;
anything that differs goes to the person for review (see
[Server restores](../../docs/data-compatibility.md#server-restores)). A restore refuses another
account's backup unless you add `--other-account`.

What a restore can't bring back:

- A change made after the backup that no phone still holds.
- A deletion made after the backup, if no phone remembers it.

Restoring account databases by copying files, rather than with `restore`, is noticed only once a
phone's cursor is ahead of the restored account, so use the command.

### Restoring accounts.db

`accounts.db` has no restore command, because it holds the server's sign-ins rather than
anyone's workouts. If it is lost or damaged, stop the server, delete `accounts.db` together with
any `accounts.db-journal`, `accounts.db-wal` and `accounts.db-shm` next to it (an old journal
would be applied to the copy), copy the backup's `accounts.db` in and start the server. Phones
paired after that backup have to pair again. **Phones signed out after the backup can sign in
again**, so run `devices list` and revoke them once more.

### Removing an account's data

There is no command for it yet. Sign its phones out (`devices revoke --all <account>`), stop the
server, and delete from the data directory its `account-<id>.db`, any `account-<id>.db-wal` and
`-shm`, and every `account-<id>.db.replaced-*` that restores kept. Its data also stays in every
backup folder, and in whatever copies them off the machine, until those are pruned. The account's
name stays in `accounts.db`.

## Benchmark mode

`LEVE_AUTH=benchmark` with `LEVE_TOKEN_FILE` replaces accounts with one shared token: every
request names its account in the `x-leve-account` header, so anyone with the token reaches every
account. It exists so the Cloudflare load script runs against this server too, and serves a stats
route on the public listener. It refuses to start on a data directory that holds `accounts.db`.
Never use it for real data.

```sh
openssl rand -hex 32 > token
LEVE_AUTH=benchmark LEVE_TOKEN_FILE=./token LEVE_DATA=./data pnpm --filter @leve/sync-node start
```

Load tests use `apps/sync-cloudflare/load/run.ts` with `SPIKE_URL` pointing here; `soak 300x20`
creates 300 accounts, 20 at a time.
