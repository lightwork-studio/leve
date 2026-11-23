<img src="assets/icon.svg" width="64" height="64" alt="">

# Leve

A workout tracker for iPhone with routines, workout history, and progress charts.

## Try the developer preview

Run Leve in a browser with sample workouts using the versions of Node.js and pnpm specified in
[`.node-version`](.node-version) and [`package.json`](package.json).

```sh
pnpm install --frozen-lockfile
pnpm preview:web
```

Open `http://127.0.0.1:41788`. For development on an iPhone or simulator, use `pnpm dev:app`
and follow the [mobile app guide](apps/mobile/README.md).

## Project status

The iPhone app stores workouts on the device. The [Node sync server](apps/sync-node/README.md)
and [Cloudflare sync server](apps/sync-cloudflare/README.md) are prototypes for development and
benchmarks. Use disposable data in an environment you control. Production hosting needs
account-level authentication and separate authorization for administrative operations.
Hevy CSV import and MCP access are planned.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Licenses](LICENSE.md) · [Branding](TRADEMARKS.md)
