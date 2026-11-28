# Apple Watch workout and rest design

Status: accepted in part (see [Decisions](#decisions)). Architecture baseline: Leve `main` at
`296e556`. Screens and flows: [apple-watch-workout-screens.html](apple-watch-workout-screens.html)
(sample workouts only).

## Decisions

- **Build now:** the frame publisher split (implementation step 5) and the rest-end alert (1b).
  Both can be verified on an iPhone alone, and the alert helps people without a Watch too.
- **Rest-end alert is opt-in.** It stays off until it is turned on in Settings or the person
  accepts the one-time prompt at their first rest.
- **On hold: the wrist-tuned `bannerSmall` (1a).** It only renders on a Watch or in CarPlay.
  It ships once someone has seen it on one of them, or in the paired Watch simulator. Until
  then the current `bannerSmall` stays.
- **Blocked: Smart Stack buttons (1c) and the Watch app (Phase 2)** need the device checks
  F1–F6, and so access to an Apple Watch.
- Open questions 2 to 6 remain open.

## What the wrist is for

During a workout the phone is on a bench or in a pocket. A lifter needs four things from the
wrist, in this order:

1. **Know when rest is over** without looking at the phone.
2. **See what is next**: exercise, set, and the values Leve will log.
3. **Log that set as shown** with one tap.
4. **Nudge rest**: −15 s, +15 s, skip.

The workout starts, is edited and finishes on the iPhone. Not in scope: routine selection,
arbitrary set edits, undo, notes, exercise browsing, history, Watch-only workouts, and HealthKit
(a separate decision, see [Later](#later-healthkit)).

## Where Leve is today

- **The Live Activity probably already reaches the Watch.** The patched `expo-widgets`
  declares `supplementalActivityFamilies([.small, .medium])`. `layout.ios.tsx` returns a
  `bannerSmall` layout with the exercise and the metric or countdown, and no controls. On iOS 18
  and watchOS 11 the Smart Stack should show it today, which still needs a check on paired
  hardware (F1). The layout environment also exposes `activityFamily` and `isStale`.
- **The rest timer only exists on the phone** (`src/data/rest-timer.ts`). It keeps an absolute
  end time and the source set and completion, survives minimising the workout, and ends on a
  restart. Undo, deletion, finishing or a changed source also end it. The activity's stale date
  is `restEnd`, so the countdown needs no updates and the layout leaves the rest view once
  `isStale` is set.
- **Nothing alerts when rest ends with the phone pocketed.** The only signal is
  `haptic.success()` in `active.tsx`, which fires only while the app is in the foreground.
  Before 1b Leve had no notifications. This was the largest gap, and the Watch is where it is felt.
- **Activity buttons carry tickets.** A button target is
  `leve1.<epoch>.<generation>.<restEnd>.<sha256(binding)>:<action>`. The binding covers sync
  owner, workout, entry, exercise, set, edit version, log values and measurements.
  `workoutSession.interact` accepts a ticket only if it is the frame the phone last published.
  Log is accepted only if the digest still matches and the same digest wasn't already applied.
  The native inbox waits about 2 s for JavaScript, then falls back to opening the app for
  review.
- **`WorkoutDisplay` is the privacy boundary.** No notes, history, account identifiers or record
  IDs cross into the extension, and the layout marks its content `privacySensitive()`.
  The rest-end alert (1b) carries the same fields for the next set, but as a notification it
  follows iOS's Show Previews setting instead of `privacySensitive()`, and a delivered alert stays
  in Notification Center until Leve next runs and removes it.
- **Logging has one path.** `player.log` checks the target and version, writes through the
  device store, and runs the post-log focus and rest behaviour, including superset progression.

Code: [player](../apps/mobile/src/ui/live/use-workout-player.ts),
[rest timer](../apps/mobile/src/data/rest-timer.ts),
[activity host](../apps/mobile/src/activity/workout-activity.ios.tsx),
[frame](../apps/mobile/src/activity/frame.ts), [layout](../apps/mobile/src/activity/layout.ios.tsx),
[session](../apps/mobile/src/activity/session.ts), [tap delivery](../apps/mobile/src/activity/delivery.ts),
[native patch](../patches/expo-widgets@58.0.29.patch).

## Principles

1. **The iPhone stays the only writer.** The Watch holds no records, no account and no sync
   state. Storage, the sync protocol and MCP are unchanged, so the
   [data compatibility standard](data-compatibility.md) isn't affected. The Watch transport has
   its own version, independent of the sync contract, and works the same in local mode, managed
   sync and self-hosted sync.
2. **The Watch sees one snapshot**: the same `WorkoutDisplay` the Live Activity gets, plus a
   ticket and ordering fields. It has the same privacy boundary and the same 4 KB budget.
3. **One validator.** Every Watch command carries the ticket the iPhone published and goes
   through the same checks as an activity button. A stale tap is rejected the same way on every
   surface.
4. **Log is never optimistic on the Watch.** The Watch shows a busy state, then the phone's
   answer. "Logged" appears only after the local store commit, and "Rest updated" only after the
   timer actually changed. A provisional result would be misleading (CONTRIBUTING, _Feedback for
   app writes_).
5. **Fail visibly, never ambiguously.** When the Watch can't apply something, it says so and
   says what to do. When the outcome is unknown, it checks before offering the action again.

Acceptance for the whole feature: one tap makes at most one confirmed write, to the intended
target. The Watch reflects the latest confirmed phone state. Logging on the phone keeps working
whatever the Watch does.

## Plan in three phases

### Phase 1: Smart Stack and rest alert (no Watch app)

This phase delivers most of the value for little risk, because it builds on code that already
exists.

**1a. A wrist-tuned `bannerSmall`.** The small family has room for about three lines.

| State          | Line 1                | Line 2 (large)          | Line 3                 |
| -------------- | --------------------- | ----------------------- | ---------------------- |
| Resting        | ring + `REST`         | `1:24` (timer interval) | `Next · Bench · set 3` |
| Ready          | `Bench press · set 3` | `80 kg × 8`             | `4/12 sets`            |
| Timed set next | `Plank · set 2`       | `1:00`                  | `Start on iPhone`      |
| All logged     | `All sets logged`     | `12/12`                 | `Finish on iPhone`     |

The countdown uses `Text(timerInterval:)` and `ProgressView(timerInterval:)`, as the banner
does. Once `isStale` is set, the layout shows the ready state, as it does today. A
`sinceUpdate` check in the layout, for example after 5 minutes without an update during a
workout, could add "Open Leve to refresh", but only if F1 shows that stale content is actually
confusing. The small family is shared with CarPlay on supported iOS versions, so the layout
should only assume a small surface, not a wrist. ActivityKit also limits how long an activity
lives, so workout time never depends on the activity.

**1b. A rest-end notification.** When a rest starts, the phone schedules one local notification
at `restEnd`. iOS forwards it to the Watch while the iPhone is locked, which taps the wrist.
This needs no Watch app.

- Identifier `leve.rest`, so there is at most one. `restTimer.start`, `adjust` and `retime`
  reschedule it. `skip`, `expire`, logging, finishing, discarding, sign-out and switching data
  source cancel it.
- On cold start, any pending `leve.rest` is cancelled. The rest did not survive the restart,
  so its alert must not either.
- Content: "Rest over · Bench press · set 3 · 80 kg × 8", using the same fields as the Live
  Activity and nothing more. It uses the default notification sound, which follows the silent
  switch, because a silent banner can't reach a phone in a pocket. The _time-sensitive_
  interruption level needs an entitlement and a provisioning profile change, so it waits until
  the alert proves useful.
- Opt-in. "Alert when rest ends" in Settings, or a one-time prompt at the person's first rest,
  where the system permission is requested.
- Uses a small local native module (`apps/mobile/modules/leve-rest-alert`), not
  `expo-notifications`. That package's config plugin adds a push entitlement, which Leve doesn't
  use.
- Delivery depends on the person's notification settings and the system's routing, so this is
  the best Leve can do without a Watch workout session. It is still far better than today's
  nothing.

**1c. Smart Stack buttons (gated on F2).** This step happens only if taps from the wrist
reliably reach the `LiveActivityIntent` on a locked iPhone. Then `bannerSmall` gets the
banner's controls: −15, +15 and Skip while resting, Log when ready.

- A successful Log is visible on the wrist because the activity flips to the rest countdown.
- A failure isn't visible. The review fallback opens the app on the phone, not on the Watch.
  So F2 also has to decide how the wrist learns about a rejection, for example a short
  "Couldn't log · open Leve" notification posted from the intent.
- If F2 fails, the small family stays read-only and Phase 2 supplies the controls.
- This depends on the separate Live Activity action fix, which stays its own change.

### Phase 2: Watch app

The Watch app is a native SwiftUI watchOS app embedded in the iOS app. React Native doesn't run
on watchOS. It opens from the Smart Stack activity, using the activity's launch configuration,
or from the app list. It is a remote control for the workout running on the iPhone, and it works
whether or not a Live Activity is shown.

#### Screens

| Screen             | When                                                 | Shows                                                                 | Actions                     |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| Checking iPhone    | Launch or foreground, until a fresh reply            | A cached snapshot if under 5 min old, actions disabled                | None                        |
| Rest               | `restEnd > now`                                      | Ring, countdown, "Next · exercise · values"                           | −15, +15, Skip              |
| Next set           | Ready and `canLog`                                   | Exercise, "Set 3 of 4", values, "Last 77.5 × 8", count                | **Log**                     |
| Logging            | After Log, until the reply                           | Same card, button busy, other commands disabled                       | None                        |
| Logged             | Reply `applied` or `alreadyApplied`                  | Tick for 0.8 s, then the snapshot from the reply                      | That of the next screen     |
| Checking if saved  | No reply within the timeout                          | Same card, "Checking whether it saved"                                | None until a fresh snapshot |
| Set changed        | Reply `staleTarget`                                  | "Changed on iPhone" with the new values                               | Log (a deliberate re-tap)   |
| Needs the iPhone   | `canLog` false: timed set, missing or loading values | Values, "Enter on iPhone"                                             | None                        |
| All logged         | `finish`                                             | "All sets logged", volume, duration                                   | None ("Finish on iPhone")   |
| iPhone unavailable | Not reachable, or cache older than 5 min             | Last snapshot dimmed with its age; a running countdown may reach zero | Try again                   |
| No workout         | A current reply confirms idle                        | "Start a workout on iPhone"                                           | None                        |
| Add exercises      | Active workout with no sets                          | "Add exercises on iPhone"                                             | None                        |
| Update needed      | Unknown major transport version                      | "Update Leve on iPhone"                                               | None                        |

The workout title and elapsed time sit in a top line on every workout screen. Long exercise
names wrap. The Digital Crown scrolls. Values use the phone's units and formatting and aren't
editable in the first release (see 2b).

When a visible countdown reaches zero, the Watch plays one `.stop` haptic. It then shows
"Rest over · checking iPhone" until a fresh snapshot shows the next set. Only the phone ends a
rest. Reopening the app on a rest that has already ended stays quiet.

**Typical flow.** Start Upper Body on iPhone → log set 2 → the wrist taps when rest ends (1b) →
raise the wrist to the Smart Stack countdown → tap into Leve → +15 → the new deadline is
confirmed → rest ends → Log the displayed values → see the next rest or "All sets logged".

#### Transport: WatchConnectivity

The phone side is a small local Expo module, `modules/leve-watch`. It registers the `WCSession`
delegate at app startup, so the session also covers a suspended or cold-launched phone
(subject to F4).

- **Phone → Watch, state.** On every frame publish, `updateApplicationContext(snapshot)`, so the
  latest state is there even if the Watch app was closed. On sign-out, a data-source change,
  unpairing or store replacement, it sends an idle snapshot and invalidates tickets.
- **Watch → Phone, refresh.** On launch, foreground, reconnect and countdown zero, a
  `sendMessage({ kind: "refresh" })` with a reply, when reachable.
- **Watch → Phone, commands.** `sendMessage(command, replyHandler)` only, and never
  `transferUserInfo`. A command queued and delivered minutes later is exactly the write the
  ticket rules exist to refuse.

#### Contract (transport v1)

| Payload  | Fields and rules                                                                                                                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot | `v`, `session` (opaque, new per phone process; reuse the ticket `epoch`), `seq` (monotonic within the session), `generatedAt`, then either `workout: null` (idle or unavailable) or the `WorkoutDisplay` fields plus `ticket`. The Watch ignores a snapshot with a lower `seq` in the same session, and replaces its state wholesale when the session changes. |
| Command  | `v`, `id` (UUID made on the Watch), `session`, `ticket`, `action`: `log`, `more`, `less` or `skip`. The phone works out the values from its own state. The command never carries values.                                                                                                                                                                       |
| Reply    | `id`, `result`, and the newest snapshot. `result` is one of `applied`, `alreadyApplied`, `staleTarget`, `needsPhone`, `unavailable`, `unsupportedVersion` or `failed`. The Watch replaces its state with the snapshot unless a newer `seq` has already arrived.                                                                                                |

**Validation on the phone**:

- The session must be the current one. A command from before a restart fails.
- The ticket must still be the published one. For Log, the restored-log rule already in
  `interact` also applies: a ticket from an earlier process whose digest still matches is
  accepted once the rest is over.
- The action must fit the state. Rest commands need a running rest. Log needs `canLog` and no
  running rest.
- Log is idempotent per digest. The `applied` record is shared with the Live Activity, so a Log
  from the activity and one from the Watch can't both apply.
- Commands are de-duplicated by `id` within the session. A retry of a finished command returns
  its stored result without running the post-log effects again. A reused `id` with a
  different payload is rejected.

The ticket already binds rest commands to the rest's identity, because `restEnd` and the
generation change whenever the rest is adjusted or replaced.

**Execution.** The native module puts the command into a file inbox like `LeveActivityTap` and
notifies JavaScript. It waits up to 4 s for a result so a background launch can mount the host,
and replies `unavailable` if none arrives. JavaScript validates as above and calls the same
`frame.act(...)`, so writes go `player.log` → `logSet` → the device write path, with supersets
and post-log rest handled as today. The Watch gives up after 6 s and moves to _Checking if
saved_.

**Refactor first: split the frame publisher from ActivityKit.** Ticket minting is tied to the
ActivityKit handle today. `interact` requires `source === handle.getId()`, and no ticket is
published when the person dismissed the activity or turned Live Activities off. Split
`workoutSession` into:

- a **frame publisher**, which mints tickets and keeps `published`, `currentDigest`,
  `expiredRestTicket` and `applied`, and
- **surfaces** that subscribe to it: the ActivityKit surface (unchanged behaviour) and the Watch
  surface.

#### Look and accessibility

- The Watch is always dark, on true black. Rest is a vermilion ring (`#FF5A32`), not the app's
  inverted bone ground, which would turn the whole wrist white. Log is a full-width vermilion
  button. Everything else is bone on black.
- Every control gets a VoiceOver label, for example "Log bench press set 3, 80 kilograms times
  8". The countdown is announced at 10 s and 0 s.
- Text scales with Dynamic Type, and hit targets are at least 44 × 44 pt.
- The countdown and connection status are readable as text, including on reduced luminance.
  Haptics are never the only signal.
- Check the smallest supported Watch screen on real hardware.

#### 2b (optional): adjusting values with the Crown

The Watch sends `{ action: "draft", ticket, values }`. The phone writes the values to the same
in-memory set drafts the active screen uses (`useWorkoutInputs`), which is not a stored write.
It then publishes a new frame with a new ticket, so Log logs exactly what the Watch now shows,
and writes stay on the phone.

### Later: HealthKit

An `HKWorkoutSession` on the Watch would add heart rate, credit toward the activity rings, and
background runtime: reliable haptics, and a wrist raise that returns to Leve. It also means a
Health permission, Health writes, recording UX and App Review's health requirements. It is a
_personal data_ change under
[review-and-merge](review-and-merge.md#changes-that-need-additional-review). Decide on it after
Phase 2 shows the Watch is used.

## Failure cases

| Situation                                            | What the Watch shows                                                    | Why it's safe                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| iPhone locked, Leve suspended                        | Normal: `sendMessage` wakes Leve in the background (F4)                 | Same validation as a foreground tap                             |
| Leve killed or restarted during rest                 | Last countdown, then "checking iPhone", then the new session's snapshot | New session rejects old commands. Rest is gone, as on the phone |
| Set edited on iPhone after the snapshot              | Log → "Changed on iPhone", new values                                   | The digest covers the set version, values and measurements      |
| Log tapped twice, or from the Watch and the activity | One set logged, both surfaces confirm                                   | Command `id` de-duplication and a shared `applied` digest       |
| Link drops after the phone committed                 | "Checking whether it saved", then the next set or rest                  | Log stays disabled until a fresh snapshot settles it            |
| iPhone out of range                                  | "iPhone unavailable" with the snapshot's age, actions off               | No queued commands. Cache expires after 5 min                   |
| Workout finished, discarded or switched elsewhere    | "No workout", or the new workout once confirmed                         | Frame becomes null and the session snapshot is replaced         |
| Timed set, or values Leve can't prefill              | "Enter on iPhone"                                                       | `canLog` is false, as for the activity                          |
| Phone clock changes                                  | Refresh                                                                 | The phone checks deadlines against its own clock                |
| Older or newer Watch app                             | Update needed, actions off                                              | Transport `v` checked on both sides                             |

## Integration with the iPhone app

- **Install**: the Watch app ships inside the iOS app and installs automatically. There's no
  setup in Leve.
- **Settings**: "Alert when rest ends" (Phase 1). Phase 2 adds no Watch-specific settings.
- **Live Activity dismissed or disabled**: the Watch app keeps working through the frame
  publisher.
- **Variants**: Watch bundle IDs follow the app, `app.leve.dev.watchkitapp`,
  `app.leve.preview.watchkitapp` and `app.leve.production.watchkitapp`. The spike verifies
  signing, install and activity launch for each.
- **Build**: a config plugin adds the watchOS target at `expo prebuild`, either
  `@bacons/apple-targets` or a local plugin, whichever embeds a Watch app more cleanly. The iOS
  simulator check would also build the Watch scheme. That is a CI change and needs the
  maintainer's approval. Every native change needs a new binary.
- **Minimum versions**: iOS 18 and watchOS 11 for Watch features, the first versions with
  Smart Stack Live Activities. Phones on older iOS keep today's behaviour.

## Feasibility checks before any code

Run these on a paired iPhone and Watch, on a throwaway branch that is never merged. Record the
timings, not just pass or fail.

- **F1, Smart Stack.** Does today's `bannerSmall` appear, run its countdown without updates and
  flip at the stale date? What does a tap do with and without a Watch app? Check privacy
  redaction on watchOS, and check the CarPlay fallback.
- **F2, Smart Stack buttons.** Do taps from the wrist run `LiveActivityIntent` on a locked
  iPhone? How many apply, how fast, and what does the wrist show on a review fallback? Run this
  after the separate action fix lands.
- **F3, rest alert.** Is the local notification at `restEnd` forwarded to the Watch
  on time while the phone is locked? Does rescheduling avoid duplicates?
- **F4, Watch round trip.** Does `sendMessage` from the Watch wake a suspended, a cold and a
  force-quit Leve? Can JavaScript validate, apply and reply within 4 s? Measure time to first
  usable render and to acknowledgement.
- **F5, haptics.** With the Watch app frontmost, do the forwarded notification and the app's own
  haptic both fire?
- **F6, packaging.** Does a generated, signed Watch target install and pair for every variant?

If F4 is unreliable, ship the Watch app read-only (Rest and Next set without actions) and keep
the controls behind that gate.

### Testing without a Watch

| Piece                     | What can be checked without a Watch                                                                                                                                                    | What can't                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Frame publisher split     | Unit tests. On an iPhone, the Live Activity buttons behave as before.                                                                                                                  | Nothing Watch-specific, since it changes no surface                                          |
| Rest-end alert            | Unit tests for scheduling. On an iPhone, the alert fires at the end of rest on the Lock Screen and while the phone is in a pocket. Adjust, skip, log and restart leave no stray alert. | That iOS forwards it to a Watch (F3). This is standard iOS behaviour for local notifications |
| Wrist-tuned `bannerSmall` | Possibly the Smart Stack in Xcode's paired iPhone and Watch simulators, which needs a Mac. The CarPlay simulator, if it shows Live Activities                                          | How it looks on a real Watch (F1)                                                            |
| Watch app                 | Paired simulators on a Mac. Connectivity between simulators is unreliable                                                                                                              | Waking a locked, suspended or terminated iPhone (F4), haptics (F5), signing and install (F6) |

A change is described as tested on a Watch only when it ran on one.

## Implementation order

Each step is its own PR under the usual review rules.

1. **Review this design** and decide the open questions below.
2. **Spike F1–F6** and record the results here.
3. **Wrist-tuned `bannerSmall`.** Layout only. Regression-test the iPhone Lock Screen, Dynamic
   Island and finish navigation.
4. **Rest-end notification.** Settings toggle, permission prompt, cancel on cold start, and
   tests for rescheduling on adjust, retime, skip and log.
5. **Split the frame publisher from the ActivityKit surface.** No behaviour change. Add a
   two-surface test: a Log from one surface makes the other surface's Log idempotent.
6. **Watch target scaffold.** Empty SwiftUI app and prebuild plugin. Building it in the iOS
   check needs approval.
7. **WatchConnectivity bridge and read-only Watch app.** Snapshot lifecycle, ordering, refresh,
   reconnect, and all read-only screens.
8. **Commands.** Rest commands first, then Log, each with the inbox, de-duplication, timeouts and
   the failure screens.
9. **Optional.** Crown value editing (2b), a complication, the HealthKit decision.

**Release validation** uses synthetic workouts in local mode and with sync on. It covers:

- supersets, warm-ups, the last set, no rest, and timer adjustments across zero
- missing values, iPhone edits and undo, and remote corrections
- finish, discard and switching workouts, a restart, and an account change
- lost, duplicate and out-of-order messages, mismatched app versions, and a dropped link after
  the phone commits
- stale and dismissed activities, privacy redaction, VoiceOver, large text and the smallest
  screen

## Open questions for review

1. _Decided: opt-in._ Should the rest-end notification be opt-in, or on by default after the
   permission prompt?
2. Should Log be in the first Watch app release, or ship rest controls first and Log in a
   follow-up?
3. If F2 passes, should Smart Stack buttons ship, or should the Smart Stack stay read-only and
   send people to the Watch app?
4. **Ticket lifetime.** Option one: a ticket is valid while it is still the published one
   (proposed). The digest already guarantees the exact values, and the 6 s reply timeout bounds
   in-flight commands. Option two adds a phone-side lifetime, for example 30 s. Then a Watch
   left idle has to refresh before Log is enabled, which costs a round trip on almost every
   set.
5. Should the Watch follow Leve's Appearance setting, or always be dark (proposed)?
6. Is iOS 18 / watchOS 11 an acceptable floor for Watch features?
