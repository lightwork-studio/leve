# Sync playground

A local page for trying the data layer by hand. One sync server, two simulated phones and an
assistant writer run the real `@leve/storage` and `@leve/sync` code on real SQLite files. The
phones talk to the server over HTTP; the assistant writes through the server's write service, the
way MCP tools will.

```sh
pnpm dev:sync            # http://127.0.0.1:8787
pnpm dev:sync -- --fresh # start from empty data
```

`PORT`, `HOST` and `LEVE_PLAYGROUND_DIR` override the defaults. The phones always sync through a
separate listener on 127.0.0.1 with a random port. `HOST` moves everything else: the page, its
unauthenticated control API and the sync endpoints. Keep it on loopback, or behind a private proxy. Data lives in `.data/sync-playground-protocol-1`
(gitignored). It is development data only and can be reset from the page at any time.

What you can try:

- Record workouts, exercises and sets on either phone, take a phone offline, and sync.
- Edit the same record on both phones to get a conflict, then keep mine, keep theirs or save as
  new.
- Rename or delete a workout as the assistant while a phone has unsynced edits.
- Take a backup, keep working, then restore it with the restore command or by copying the files
  back, and review what the phones offer again.

The page uses a small JSON control API, which scripts can use too:

| Request                                     | Body                                               |
| ------------------------------------------- | -------------------------------------------------- |
| `GET /dev/state`                            |                                                    |
| `POST /dev/devices/{phone-a,phone-b}/put`   | `{ kind, id?, content }`                           |
| `POST /dev/devices/{name}/delete`           | `{ kind, id }`                                     |
| `POST /dev/devices/{name}/sync`             |                                                    |
| `POST /dev/devices/{name}/online`           | `{ online }`                                       |
| `POST /dev/devices/{name}/resolve`          | `{ kind, id, choice, newId? }`                     |
| `POST /dev/devices/{name}/resolve-restored` |                                                    |
| `POST /dev/assistant`                       | `{ kind, id?, content }` (`content: null` deletes) |
| `POST /dev/backup`, `POST /dev/restore`     | `{ how: "command" \| "copy" }` for restore         |
| `POST /dev/reset`                           |                                                    |

Every request is signed in as one demo account. Don't expose the playground beyond your machine.
