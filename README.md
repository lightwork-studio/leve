<img src="assets/icon.svg" width="64" height="64" alt="">

# Leve

A workout tracker for iPhone. Build routines, log sets, keep workout notes, and follow your progress.
In Settings, **Import from Hevy** adds workouts from a Hevy CSV export.

## Get Leve

[Download Leve on the App Store][app-store].

Leve saves workouts on your iPhone and works offline without an account. With Leve sync
configured, sign in with Apple to sync across iPhones. The managed sync server supports
[MCP access](apps/sync-cloudflare/README.md#sign-in) to synced workouts, routines, notes, progress,
and measurements. MCP writes require separate permission and must be enabled on the server.

You can also [host the Node sync server](apps/sync-node/README.md) to keep synced data on your
own infrastructure. Leve Dev and TestFlight builds support pairing to it in Settings.

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
