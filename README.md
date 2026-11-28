<img src="assets/icon.svg" width="64" height="64" alt="">

# Leve

A workout tracker for iPhone. Build routines, log sets, keep workout notes, and follow your progress.
In Settings, **Import from Hevy** adds workouts from a Hevy CSV export.

## Get Leve

[Download Leve on the App Store][app-store].

Leve saves workouts on your iPhone and works offline, without an account. Sign in with Apple in
Settings to sync your workouts across iPhones.

Synced workouts, routines, notes, progress and measurements are also available to AI assistants
over MCP. Reading needs your permission when you connect an assistant, and writing needs a separate
permission that the server operator must enable. The
[sync server guide](apps/sync-cloudflare/README.md#sign-in) covers how MCP sign-in works.

## Host your own sync server

The [Node sync server](apps/sync-node/README.md) keeps synced data on your own infrastructure, with
one SQLite file per account. Leve Dev and TestFlight builds can pair with it in Settings.

<!-- Replace the App Store placeholder with the Leve listing URL when it is available. -->
[app-store]: https://apps.apple.com/

## Development setup

Run Leve in a browser with sample workouts using the versions of Node.js and pnpm specified in
[`.node-version`](.node-version) and [`package.json`](package.json).

```sh
pnpm install --frozen-lockfile
pnpm preview:web
```

Open `http://127.0.0.1:41788`. For development on an iPhone or simulator, use `pnpm dev:app`
and follow the [mobile app guide](apps/mobile/README.md).

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Licenses](LICENSE.md) · [Branding](TRADEMARKS.md)
