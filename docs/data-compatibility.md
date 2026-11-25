# Data compatibility, sync and recovery

This is Leve's standard for how user data is stored, synced, upgraded and recovered. Code that touches
stored data, the sync protocol, MCP write tools or data import must follow it. When a change needs a
different rule, change this document in the same PR and say so in the PR description. This standard
adds to the elevated review gates in [the review and merge workflow](review-and-merge.md); it does not
replace them. Changing this standard's rules, promises or guardrails is a change to the review rules
and needs the maintainer's explicit approval of the final diff.

## Goals

- **Keep every logged workout.** Workouts, corrections and pending changes are saved on the phone
  first. Restarting the app restores an unfinished workout as in progress. A server failure, a
  rejected upload or a failed upgrade never erases local work. Sync deletes unsynced local work
  only when the person confirms it, after being told what would be lost and offered a copy (see
  [Accounts](#accounts-local-mode-backups-and-import)).
- **Three ways to run.** Local mode needs no account and offers every tracking feature of the
  installed app. Managed and self-hosted sync use the same server code. What a server supports
  decides which synced features are available on that connection.
- **Apps and servers update independently.** Database layouts and the network contract have separate
  versions. A server supports several protocol releases where it can do so truthfully; there is no
  fixed count or minimum support period.
- **Simple, visible conflicts.** An edit based on an outdated copy is rejected, never merged
  automatically. The phone keeps its version, shows it with a warning and lets the user decide.
- **MCP clients use the same rules.** MCP writes go through the same validation and revision checks
  as phones.

## Versions

| Version                               | Who knows it                      |
| ------------------------------------- | --------------------------------- |
| App release                           | Only for diagnostics              |
| Device storage                        | The app only                      |
| Server storage                        | The server only                   |
| Sync protocol release (`major.minor`) | Both sides; negotiated on connect |

The app and the server each upgrade their own storage and nothing else. Each side maps its current
storage to shared **logical records** and encodes them with the protocol releases it speaks. Database
rows are never an implicit network contract, and a storage-only change needs no protocol release.

## Records

Sync works on individual records. Each record has a kind, an id and content:

| Kind                    | Content                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `workout`               | Workout details: title, times, routine link, in progress/finished         |
| `workout_exercise`      | One exercise entry in a workout: exercise, name and type, order, rest     |
| `workout_set`           | One set of an exercise entry: order, type, values, completion             |
| `workout_rest`          | A workout's own rest timer default                                        |
| `workout_note`          | A note on a workout: text, pinned or not, who wrote it                    |
| `workout_note_comment`  | A comment on a workout note, by the lifter or an agent                    |
| `exercise_note`         | A note on an exercise: text, pinned or not, the workout it was written in |
| `exercise_note_comment` | A comment on an exercise note, by the lifter or an agent                  |
| `routine`               | A whole routine including its exercises and target sets                   |
| `routine_folder`        | A folder of routines                                                      |
| `custom_exercise`       | An exercise the user created                                              |
| `body_measurement`      | One body measurement                                                      |
| `settings`              | Account settings (a single record)                                        |

- Sets, workout details and whole routines are the units of conflict. Editing set 2 never conflicts
  with an edit of set 3 or of the workout title. Device-only preferences never sync.
- A record id is created on the device that creates the record and never changes: a random UUID,
  except for imported records (see below).
- Order within a parent is a number on each child (`position`); inserting between two items picks a
  value between theirs, so it changes one record. Equal positions are ordered by id. When repeated
  inserts at one spot run out of precision, the device renumbers the siblings, which changes each
  of them.
- Every accepted change takes the next value of a per-account counter on the server, assigned in the
  same transaction as the change. That value is the record's revision.
- References are soft. A workout whose routine or exercise no longer exists still shows, using the
  name and type stored on its exercise entry. Custom exercises are archived, never deleted. Built-in
  exercise ids are permanent. Deleting a routine folder leaves its routines unfiled.
- A child names its parent. Deleting a record deletes its children (a workout's entries, sets,
  rest and notes; a note's comments) on the server in the same transaction.
- `settings` can be changed but never deleted.

Each workout note is an independent child of its workout, and each comment a child of its note.
An exercise note names its exercise and, softly, the workout it was written in: it is not that
workout's child, so a pinned note outlives the workout. A note or comment carries the name of the
agent that wrote it, or null when the lifter wrote it; agents don't change the lifter's text.
Comments are records of their own so the lifter and an agent can add them at once without a
conflict. A pinned note comes back until it is deleted or unpinned; only notes on a workout
counted for a routine can be pinned. Any other note comes back once, in the next
workout of its routine (workout notes) or the next workout with its exercise (exercise notes), and
once more after each later comment. The optional workout
rest preference uses the workout ID as its record ID. Updating its seconds to null clears the
preference. Deleting its workout creates a tombstone for the live rest preference in the same
transaction. A restored server accepts a separate rest tombstone only when the same-ID workout
is already deleted. If the owner is missing, the server answers `retry_later/parent_missing`.
If the owner is live, it answers `invalid/not_deletable`. A valid backup must preserve that
ownership for deleted rest preferences as well as for live ones.

### Deletion

Deletion is permanent; there is no trash or undelete. The server keeps a deletion marker (kind, id,
revision) without any content, for the life of the account, so a stale device can never bring the
record back.

Because deleting a record also deletes everything below it, a deletion lists every live descendant
the deleter knows, with the revision it knows. The deletion is `stale` if any descendant changed or
appeared since, so a deleter can never remove sets it hasn't seen. A device's own accepted deletion
removes the record's descendants on the device too, except a child whose server copy sits under
another parent (its local version had moved it): that child goes back to its server copy, and a
deletion the user asked for on it still applies.

When someone else deletes a record while this device holds unsynced work below it (for example a
workout deleted elsewhere while sets are being logged), that work is never dropped: the record stays
visible with a warning, holding its last content, and the user can save it as new together with that
work. The server has deleted all its children; on the device, children without unsynced work go too. A
deletion waits until no upload of anything below it is in flight, so its list of descendants is
current.

A deletion lists at most 2,000 descendants. A device holds back a larger one as a problem for the
user instead of sending it, so it can't block the device's other uploads. It settles by itself if the
record is deleted elsewhere, and keeping the server's version brings the record back.

## Protocol releases

A release such as `1.0` defines request and response shapes, field meanings, units, omission and
clear behaviour, error codes, revision rules and examples. A release is **frozen** when it is
merged, and becomes binding once it **ships**: the real-data declaration lists every release made
so far under `shipped` in `frozen-paths.json`, and each later release is listed when it first
reaches a build that keeps real data. From then on none of it changes: a mistaken shipped release is
retired and replaced by a new number, never edited. Before it ships, nobody keeps real data in it,
so the frozen-material check only warns about changes and `pnpm contract:freeze <release>
--refreeze` writes it again. A release can only be listed as shipped once it is frozen, and freezing it
again and shipping it are separate changes. Until the maintainer's real-data declaration (see
[Data-preservation promise](#data-preservation-promise)), development previews must not be given to
anyone who keeps real data in them. Each release's frozen description includes every field's meaning
and the message rules: answer order, defaults, error codes and their HTTP statuses, and size limits.

Before the first protocol ships, coordinated development builds use a single draft release,
`1.0`, with disposable data. Edit the contract and regenerate the draft with
`pnpm contract:freeze 1.0 --refreeze`. Update the development app and server together when the wire
format or semantics change, since peers from different builds can both advertise `1.0` and
disagree on which messages are valid or what they mean. If an integration branch already advertises
later drafts, re-freezing `1.0` alone leaves those drafts active and can leave their frozen artifacts
out of date. Keep every advertised draft consistent with its frozen artifacts. Consolidating drafts
requires updating both peers and checking how existing preview data is read.

- **Optional additions to a shipped contract** make a new minor release (`1.1`). A new field is
  optional in the logical record, and a record without it is valid. Each new field gets a meaning
  and, if users enter it, a feature that older servers switch off. A new record kind with no parent
  is also a minor release.
- **An app that starts speaking a newer release** downloads everything again before it uploads
  edits, and lets those copies replace its own even at the same revision. Copies it downloaded in the
  older release lack the new fields and kinds; until they are replaced, the new fields count as left
  out, never as empty, so an edit can't erase a value another device set.
- **Breaking changes to a shipped contract** make a new major release. These include removing or
  retyping a field, making a field required, changing units or meaning, widening a set of choices or
  a limit, changing the shape of items nested inside a record (such as a routine's exercises and
  target sets), and adding a record kind below an existing kind (an older app couldn't
  list it when deleting the parent). A new detail of a nested item can be represented as an optional
  top-level field for a minor release.
- Limits that apply to every release: a record's content is at most 200,000 bytes of UTF-8 JSON; a
  request is at most 1 MiB, and clients split uploads to stay below it; a download page stops at
  about 800,000 bytes. Timestamps are written in UTC with milliseconds, so equal values have one
  spelling.
- When a contract can no longer be fulfilled truthfully, the server stops supporting that release and
  the client is told to update. We never invent placeholder values to keep an old release alive.
- Supported releases are listed in code (`SERVER_RELEASES` and `CLIENT_RELEASES`). Dropping one is
  an explicit, reviewed change with tests for the update-required answer.

### Negotiation

The client sends every release it speaks; the server answers with the highest release both share and
the features that release provides. Without a common release the server answers `update_required`,
naming which side is behind. Sync then pauses with a message; logging and local work continue.

### Omitting, clearing and unknown fields

- Content sent in a release contains exactly that release's fields. An unknown field is rejected,
  never stripped.
- A field that the sender's release does not define is **omitted**: the server keeps its stored
  value. This lets an older client edit a record without erasing newer data.
- Clearing a field means sending it as `null` in a release that defines it.
- When the server sends a record to an older release, fields that release lacks are left out. A record
  that the release cannot represent at all, for example because of a value it does not know, is sent
  as `unavailable` (id and revision only). The old client keeps it hidden and read-only, and can't
  overwrite it. Within one major release this can't happen; it is for servers that also speak an
  older major.

### Features in sync mode

Shared field and feature definitions drive wire types, runtime validation and feature availability.
In sync mode, a feature the negotiated release lacks is disabled for new entry. Values the device
already holds stay on the device. An upload that had to leave out such values is accepted on the
server but stays **partially synced** on the device, and is sent again in full once the server
supports it. It is never shown as fully synced.

A projected upload can also match another device's revision. On HTTP push replies,
the optional `Leve-Written-Revisions` header has one digit per result, in response
order. A `1` means this submission wrote the accepted revision. The server
records that fact in the same transaction and can repeat it when replaying the
receipt. A `0`, or an absent or malformed header, supplies no such evidence.
Older peers continue to use the same JSON request and reply. When a receipt
cannot establish a baseline for a field it omitted, a later download preserves
differing values for the lifter to choose between. An explicit clear is a value.

## Uploading

The device stores, for each record, the last copy it received from the server and, if the user changed
it, the pending local version with the revision it started from (its **base revision**). Downloads
update the server copy but never the base revision.

- **One submission per record is in flight.** It has a random submission id, the base revision and
  the content at the time it was made, and is retried unchanged until the server answers. Later
  edits stay pending; the in-flight submission is never altered. It is abandoned only by a server
  reset (see [Server restores](#server-restores)) or a server that dropped the submission's release,
  both keeping the record pending as a new submission, and when a download shows the record's
  parent deleted.
- **Acknowledging never erases newer work.** When a submission is accepted, its content becomes the
  device's server copy, unless the device already downloaded a newer one. If the user edited the
  record meanwhile, that edit stays pending with the new revision as its base.
- The server decides each submission on its own, so one rejected record does not block others. The
  device sends parents before children and deletions after them.

The server answers each submission:

| Answer        | When                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`    | Create of an unknown id; base revision equals the current revision; or the content, after applying the omission rule, already equals the current copy                              |
| `conflict`    | The record changed since the base (`stale`), was deleted (`deleted`), already exists (`exists`) or its parent was deleted (`parent_deleted`); the answer includes the current copy |
| `retry_later` | The parent is not on the server yet; the device resends after the parent arrives                                                                                                   |
| `invalid`     | The content breaks the release's rules, or a submission id was reused for different content                                                                                        |

- An abandoned create may already have committed. Preserve a later local deletion until a
  compatible server accepts its marker or returns the live version for explicit review. An
  explicit retry-later reply confirms that the attempted create did not commit.

- **Retries are recognised.** The server stores a receipt for each accepted submission (id, record,
  revision, content digest) in the same transaction as the write, for 90 days. A repeated submission
  id with the same content gets the original answer; with different content it is `invalid`. After
  the receipts expire, a repeat is decided like any submission: `accepted` if its content still
  equals the current copy, otherwise a conflict the user reviews. The same equal-content rule makes
  importing one file on two devices, or offering records again after a restore, work without
  conflicts.
- Deleting an already deleted record, or one the server never had, is `accepted` and leaves a
  marker.
- An update of a record the server doesn't have is `stale` without a current copy.
- Every request carries the account lineage from connecting; a different one is answered
  `cursor_reset`.

### Conflicts

A rejected local version is kept, and the app asks about it straight away. A popup goes through
the conflicts one at a time, each as the person thinks of it: a whole workout with its exercises,
sets, notes and rest; a routine; a folder; a bodyweight entry; a note with its comments; a custom
exercise; the settings. It shows only what differs on each side (or, where one side is gone, all
of the other), chooses nothing in advance, and can't be put off, except that it waits while a
workout is in progress. One choice settles every record of that conflict, and is checked for
every record before any is applied. A workout or exercise deleted on one side while the other
changed it or what's in it is reviewed where the app already does so, in History or on the
workout: the popup says what happened, leads there, and asks again until it is settled. It leads
there only when that screen can settle it; otherwise the popup settles it itself. A conflict that
can't be settled yet (a sync still running, a server restore, fields this server or app doesn't
know, a workout deleted here that is still to upload, or work below something deleted in the
account that is still on its way there and back) waits until it can. Letting go of something the
account deleted first shows everything this phone holds below it. Keeping a deletion made here is
offered only when the account holds nothing below it, after showing the account's version. Work
recorded entirely offline is flagged on the start screen. A conflicted record is not resubmitted
automatically. An `invalid` answer is handled the same way, unless the user already edited the
record again, in which case the newer version is sent. The kept version is the newest local one. The user can:

- **Keep mine:** resubmit the local version based on the server's current revision. It can be
  rejected again if the record changed once more.
- **Keep theirs:** discard the local version. For a record deleted on the server this also discards
  what was kept below it; for a record that never reached the server it discards it with its
  children.
- **Save as new:** for a record deleted on the server or never accepted by it, save it and every
  descendant it still shows under new ids. Deleted records are never restored under their old id. A
  child whose parent was deleted is saved by saving its parent as new.
- Keep mine is not offered for a record deleted in the account or one this build can't show. For a
  record deleted here but changed in the account, the popup offers keeping the deletion only when
  the account holds nothing below it: it shows the account's version, then sends the deletion
  again against it. Otherwise only the account's version can be kept, to be looked at first.
- A refused (`invalid`) change is decided on its own, so undoing it never undoes valid changes made
  beside it. The popup offers only undoing it (keep theirs), since the server won't take it as it
  is. One with no account copy (never reached the account, or deleted there since) isn't asked
  about in the popup, since undoing it would also drop what waits below it unseen; it is edited
  again where it is shown.

## Downloading

Changes and deletion markers arrive in revision order, in pages, after the device's saved cursor. The
cursor moves only from downloaded pages, never from upload answers, and is saved together with the
page. A downloaded record at or below the revision the device already has is ignored. While the app
is active, a download can wait for new changes (long polling), aiming at a few seconds between a
change elsewhere and the phone showing it.

### Server restores

Each account has a lineage id, sent on connect and with every upload and download. Restoring an
account from a backup with the server's restore command gives it a new lineage; the command checks
the backup before replacing anything and keeps a copy of the database it replaces. A device whose
cursor is ahead of the server's counter (a restore made by copying files) makes the server pick a new
lineage, so every device notices, not only that one; the device itself resets only once it sees the
new lineage. A device that sees a different lineage resets before uploading anything.

**After a restore, nothing is decided quietly.** Restores are rare, and every rule that let a device
take the server's version on its own turned out to lose data in some sequence of restores. So:

- The device abandons its submissions in flight, forgets its cursor and server revisions, and
  downloads everything again. A page requested before the reset is discarded.
- Pending, rejected and local-only work stays. Records it held without local changes are offered
  again as new: the server confirms those it still has with identical content and recreates those
  it lost. Every other difference (an older copy, a change the server lost, a record the restored
  server has deleted) becomes a conflict for the user to review.
- Deletions it remembers wait for the download: one of a record the restored server doesn't have is
  sent without a base revision, so the server keeps a marker; one of a record the restored server
  has goes to review (keep mine deletes it again, keep theirs keeps it).
- Conflicts were about the server's old state, so they are rechecked against the restored server.
  A conflict whose version is exactly what the restored server has is settled, since nothing is
  left to decide. A local version carried through the restore keeps the record's last server copy until the
  restored server shows its own. If the restored server lacks the record, keeping theirs offers that
  copy again. Saving as new keeps it as well: the user's tree moves to new ids and the old ids go
  back to their last server copies. Nothing recorded under it, such as another device's entries,
  is lost. Deleting a record that went through the restore is always sent, so the server keeps a
  marker and no device offers it again.
- Resolving waits until the download after the reset has finished, because the restored server's
  copy isn't known before. Then one action keeps the restored server's version of every record that
  was only offered again (copies the user never changed and remembered deletions), through any
  number of restores. It leaves out the user's own edits and versions they chose to keep, which are
  reviewed one by one, and any record whose server version would discard such an edit below it.
- Connecting reports which lineage a restored backup belonged to and its revision, for display and
  diagnostics; devices make no decisions from it.

Limits: a change made after the backup that no device still holds, such as an MCP edit, is lost; a
deletion made after the backup comes back if no device remembers it; a restore made by copying files
is noticed only once some device's cursor is ahead of the restored counter.

## MCP writes

MCP tools read records with their revision and write through the same server write service as
phones: the same validation, revision check, receipts and atomic persistence. A rejected MCP write
returns the current copy so the client can read again. MCP has no saved rejected versions.

## Running workouts

A workout syncs from the moment it starts, so other devices and MCP can see and edit it. It counts
towards history, statistics, records and exports only once finished, and is never discarded
automatically. A device runs at most one workout at a time.

## Storage upgrades

Before an upgrade, the database is snapshotted with SQLite's backup mechanism (`VACUUM INTO` or the
backup API), never by copying files. The upgrade runs in one transaction and is then verified:
integrity check, foreign-key check where foreign keys exist, record counts, and every record must
decode. If verification fails, the snapshot is restored. The snapshot is kept until the next
successful upgrade. Every release that holds real data must upgrade directly to the newest release,
including across skipped releases. Released migrations are never edited; later changes add new ones.
Migrations count as released from the maintainer's real-data declaration, when their files also
join the frozen paths; until then the version 1 layouts may still change.

- Every build can read a small metadata record whose shape never changes: storage version, the app
  version that wrote it, and whether unsynced work exists: pending, in-flight, rejected and partially
  synced data, and anything that never reached the server, such as a running workout logged
  without a connection.
- For an existing database, the fixed metadata is inspected read-only before any Leve write. Storage
  written by a newer version is refused: no migration, lookup rebuild, metadata update or reset is
  allowed. The app names the version it needs and asks the user to update. It offers to set the data
  aside and download again only when nothing is unsynced; otherwise it offers export only.
- If SQLite reports that an interrupted transaction's hot rollback journal prevents reading, its own
  rollback may complete before the version check. This restores the last committed state; it is not a
  Leve migration or a downgrade. Database bytes and journal files may change, but all last committed
  application data, including pending work and storage metadata, must survive. If recovery fails,
  opening stops without resetting or replacing the database. This exception does not permit
  checkpointing a readable WAL before checking the version. When no recovery is required, refusal
  leaves the database and durable journal files byte-identical; disposable shared-memory lock
  bookkeeping is excluded.
- Pending, in-flight, rejected and partially synced data survive upgrades unchanged in meaning. An
  upgrade never changes an already dispatched submission's id, base revision or content.
- When an upgrade keeps failing, the app shows a recovery screen: data is safe, diagnostics can be
  sent, the raw database can be exported, and a fixed release resolves it. Resetting is offered only
  when nothing is unsynced. On the server, only the affected account is paused.
- Each account's server database is upgraded before it is first opened. A server rollback means
  restoring the pre-upgrade snapshots with the restore command every release includes (see
  [Server restores](#server-restores)); the older server refuses databases that a newer one has
  upgraded.

## Accounts, local mode, backups and import

- The app works fully without a server. MCP needs a server.
- Connecting a device whose local data was recorded independently to a non-empty account asks once
  whether to add that data to the account or replace it with the account's data. Replacing deletes
  the local data after confirmation and an offer to export it first. Nothing is uploaded or deleted
  until the person answers. Connecting an empty device, or connecting to an empty account, doesn't
  ask. Connecting uploads local records through ordinary submissions.
- A device's data belongs to the account and server it first synced with. When a different account
  signs in, or the app is pointed at another server, a device whose data has all synced drops its
  copy (the old account still has it) and starts from the new account, but never while a workout
  is in progress. A device with unsynced work (pending edits or kept conflicts) says how many
  changes would be lost, offers an export, and deletes them only once the person confirms. The
  person can instead sign the new account out and keep them for the old one, or decide later;
  nothing syncs meanwhile. Signing out never deletes local data; with unsynced work it first says
  the changes wait for the same account. Servers never coordinate with each other.
- Sync state (cursor, receipts, pending submissions) belongs to one account on one server and is never
  reused for another.
- Local mode offers a manual export and import of a complete backup file. The file is a copy of the
  device database made with SQLite's backup, so it carries the fixed storage metadata. Importing it
  replaces local data after confirmation and an offer to export the current state first. A backup
  from an older storage version is upgraded like any database; one from a newer version, or a
  damaged one, is refused before anything is replaced. Platform device backups are a bonus whose coverage
  must be verified per platform.
- CSV import only adds data. Imported workouts get ids derived from the import (local start time to
  the minute, plus how often that start time occurred before in the file); nested items get ids from
  their position, and custom exercises created by import from a hash of their normalised name, which
  keeps the id within the id format whatever the name's length or script. Importing the
  same file twice or on two devices therefore never creates duplicates, and an import never
  overwrites or revives a record that already exists or was deleted.

## Data-preservation promise

Until the maintainer declares that Leve holds real data, storage formats may change and development
data may be reset; development previews given to others must say so. Protocol releases are final
from the moment they ship (see [Protocol releases](#protocol-releases)). After the declaration,
every release must upgrade
existing data (including backup files) automatically from every release made since the
declaration; "real-data" and "data-bearing" in this repository mean exactly those releases.

## Required guardrails

These are merge requirements for the matching code, not aspirations. They run in CI as part of
`pnpm check`. Add them with the code they protect; never add placeholder tests that pass before that
code exists.

- **Frozen history:** an append-only registry of frozen protocol releases and released migrations
  with content digests. CI compares every frozen file of a shipped release with the target branch
  and with the version it had when the release shipped, so editing a fixture and its digest together
  still fails;
  changes to releases that haven't shipped are reported as warnings. A release can't be taken off
  the shipped list. CI never regenerates and accepts snapshots automatically. The shared definitions must reproduce each frozen schema exactly.
- **Boundaries:** transport handlers cannot import storage tables or write on their own; network input
  passes runtime validation; every server write goes through the account-scoped write service;
  client uploads go through the persistent outbox; production code does not import test history.
- **Compatibility matrix:** derived from the supported-release registry; an advertised combination
  without tests fails CI. Historical peers are archived, self-contained encoders and decoders (never
  aliases of today's code) that send create, update, delete and retry requests to the current server
  on real SQLite storage and decode its answers. The current client is tested against each supported
  older server, including disabled features and partially synced records. Cover missing versus
  `null`, zero and false, units and precision, enums, malformed input and error shapes.
- **Scenarios:** deterministic tests with injected transport, clock and ids on real SQLite: offline
  recording across a restart; competing writers; explicit resolution while other records sync; lost,
  duplicated and reordered replies with restarts on both ends; edits while a submission is in flight;
  deletion against a stale writer; multi-page catch-up with crashes before the cursor is saved; upgrades
  with pending, in-flight, rejected and partially synced data; account isolation. Seeded generated
  sequences print their seed and trace on failure. Expected outcomes come from an independent model,
  not the implementation's helpers.
- **Storage upgrades:** realistic fixtures from every shipped data-bearing storage version; crash
  injection (real process termination) while snapshotting, during the upgrade, between commit and
  verification, and during restore; refusing newer storage, including the WAL and hot-journal cases
  above; restoring the snapshot when verification fails; a rehearsed restore on a throwaway database.
- **Broken variants:** a small set of deliberately broken implementations that the same tests must
  catch, such as a skipped revision check, an old answer in a new format, an omitted field clearing a
  stored value, a lossy upload marked synced, a write without its receipt, and an acknowledgement
  erasing a newer local edit.
- **Native storage:** the phone's SQLite adapter passes the shared driver tests and a restart check on
  a development-preview device before the phone's durability is claimed.
