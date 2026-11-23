# Contributing to Leve

Fork the repository and open a focused pull request against `main`. Describe what changes for
users, what you tested, and how to recover if the change fails. Use synthetic workouts in tests and
screenshots.

If you change a PR's target branch, reopen it or push an update so CI checks the new base.

Contribute only material you have permission to submit. Contributions use the license that
applies to the affected files under the [license map](LICENSE.md). Preserve existing notices
and identify any third-party material and its license in the PR.

## Local setup

Use the Node.js version in `.node-version` and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Use `pnpm preview:web` to open the app locally with sample data. Use `pnpm dev:app` for
development with Metro. The [mobile app guide](apps/mobile/README.md) covers device setup.

Run `pnpm check:builds` to check the landing page and both app bundles, as CI does. You can
run a focused test file with `pnpm exec vitest run <path-to-test>` while developing.

## Continuous integration

Every pull request gets a `check` result covering lint, types, tests, contract compatibility,
and the app and site builds. Changes to native inputs also require the iOS simulator check.
Fork workflows run with read-only access and require maintainer approval for outside contributors.
TestFlight and site deployments run separately from contributor CI.

## Where changes belong

- `apps/mobile/app/` contains the screens and navigation. UI and platform integrations live
  under `apps/mobile/src/`. Keep reusable calculations and data rules out of screen components.
- `packages/core` contains domain rules, `packages/contract` defines the network contract,
  `packages/storage` owns persistence, and `packages/sync` coordinates synchronization.
- `apps/site` builds the landing page. The sync apps provide development and benchmarking hosts.

Read the [review workflow](docs/review-and-merge.md) before submitting changes and the
[data compatibility standard](docs/data-compatibility.md) before changing storage, sync, imports,
or MCP writes. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
