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

One server uses a data directory at a time: a second refuses to start while the first runs.

To cut every phone off at once, run `devices revoke --everyone`. Phones keep their data, and sync
stops until they pair again.

## Install

`pnpm --filter @leve/sync-node bundle` builds one file, `dist/leve-sync.mjs`, that runs with Node 24
and nothing else. Run it in one of these ways, and put HTTPS in front of it. Keep the data
directory on a local disk: one server uses it at a time, held by a file lock that network
filesystems may not honour.

### systemd

```sh
useradd --system --user-group --home-dir /var/lib/leve --shell /usr/sbin/nologin leve
install -m 0755 apps/sync-node/dist/leve-sync.mjs /usr/local/bin/leve-sync
install -d -o leve -g leve -m 0700 /var/backups/leve   # before the first start, see below
```

Save the unit as `/etc/systemd/system/leve.service`:

```ini
[Unit]
Description=Leve sync
Wants=network-online.target
After=network-online.target

[Service]
User=leve
Group=leve
Environment=LEVE_DATA=/var/lib/leve LEVE_ADMIN_SOCKET=/run/leve/admin.sock LEVE_SQLITE_WAL=1
Environment=LEVE_PUBLIC_URL=https://sync.example.com PORT=8787
ExecStart=/usr/local/bin/leve-sync serve
StateDirectory=leve
StateDirectoryMode=0700
RuntimeDirectory=leve
RuntimeDirectoryMode=0700
UMask=0077
Restart=always
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
SystemCallArchitectures=native
# The backup folder must exist when the service starts, or it stays read-only until a restart.
ReadWritePaths=/var/lib/leve /var/backups/leve

[Install]
WantedBy=multi-user.target
```

`leve-sync` needs `node` (24 or later) on the PATH; otherwise use `ExecStart=/path/to/node
/usr/local/bin/leve-sync serve`. Run `systemctl daemon-reload` and
`systemctl enable --now leve.service`. Administer it as the same user, with the same socket:

```sh
sudo -u leve LEVE_ADMIN_SOCKET=/run/leve/admin.sock leve-sync admin accounts list
sudo -u leve LEVE_ADMIN_SOCKET=/run/leve/admin.sock leve-sync admin backup /var/backups/leve
```

### Container

The [Containerfile](Containerfile) packages the bundle on `node:24-slim`, running as user and group
10001 with its data in a volume and a backups folder next to it:

```sh
pnpm --filter @leve/sync-node bundle
docker build -t leve-sync -f apps/sync-node/Containerfile apps/sync-node
docker run -d --name leve --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -v leve-data:/var/lib/leve -v leve-backups:/var/backups/leve \
  -e LEVE_PUBLIC_URL=https://sync.example.com leve-sync
docker exec leve leve-sync admin accounts add Alice
docker exec leve leve-sync admin backup /var/backups/leve
```

Run one container per volume. A second container on the same volume refuses to start, so stop the
old one before starting its replacement. Create bind-mount directories with
`install -d -o 10001 -g 10001 -m 0700 <folder>`. For an existing directory, verify that the
service user owns the directory and its files and that only that user can read them.

### HTTPS in front

Phones only connect over HTTPS. The proxy must pass request bodies of at least 1 MiB and keep a
request open for at least 60 seconds, because phones wait on the server for changes for up to 25
seconds at a time. Caddy does both by default:

```text
sync.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

With nginx, set `client_max_body_size 2m;` and keep `proxy_read_timeout` at 60 seconds or more. A
server behind a path (`https://example.com/leve`) works: set `LEVE_PUBLIC_URL` to that address
and have the proxy strip the path.

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
(`account-<id>.db.replaced-<time>`, which `restore` also accepts, to undo, as it does the
`account-<id>.db.snapshot-v<N>` a storage upgrade keeps), and gives the account
a new lineage. Its phones notice, download everything again and offer back what the backup lacks;
anything that differs goes to the person for review (see
[Server restores](../../docs/data-compatibility.md#server-restores)). A restore refuses another
account's backup unless you add `--other-account`.

What a restore can't bring back:

- A change made after the backup that no phone still holds.
- A deletion made after the backup, if no phone remembers it.

Restoring account databases by copying files, rather than with `restore`, is noticed only once a
phone's cursor is ahead of the restored account, so use the command.

If the live workout database is damaged and the command cannot save the copy it would replace,
stop the service. Move the live `account-<id>.db` and any matching `-journal`, `-wal` and
`-shm` files together to a private recovery directory. Restart the service and use `restore`
with a verified backup. Keep the moved files until you confirm the result.

### Restoring accounts.db

`accounts.db` contains sign-ins. If it is lost or damaged, record `accounts list` if you can.
Stop the server and stage the backup copy as a separate, owner-readable file on the data disk.
Move the current `accounts.db` and any `-journal`, `-wal` and `-shm` sidecars together to a
private recovery directory. Rename the staged copy to `accounts.db` and start the service.
Keep the recovery files until you confirm the result.

Phones paired after the backup need a new pairing. Tokens revoked after the backup may work again,
so list and revoke them before reopening the public listener. A recent backup can also reinstate
unexpired pairing codes. Start with `LEVE_PAIRING=off` until any restored codes expire.
Accounts created after that backup are
missing from it, though their databases are still there: the next `backup` lists them as not
copied. Add each account again (it gets a new id), then, before pairing any phone with it, put
its data back with `restore <name> <data>/account-<old id>.db --other-account`.

### Removing an account's data

There is no command for it yet. Sign its phones out (`devices revoke --all <account>`), stop the
server, and delete every file in the data directory whose name starts with `account-<id>.db`:
the database, its journals, the copies restores kept and the snapshots storage upgrades kept. Its data also stays in every
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
