# Review and merge

Start from current `main`. Decide what the change should do and write down the case that will
show it works. Keep unrelated fixes in separate pull requests so each change can be reviewed
and reverted on its own.

Open a draft pull request while the change is in progress. Run `pnpm check` before asking for
review. Changes to behavior need a regression test that exercises a realistic case and verifies
the expected outcome. For changes to app or site build inputs, run `pnpm check:builds` locally
to catch bundling problems before CI.

Review the final commit and its relevant callers and tests. Resolve blocking findings before
merging. The PR records validation, review scope and findings, risk, and how the change can be
reverted or recovered. Pure copy changes can use an author check where the configured branch
rules permit it.

Before a squash merge, verify that CI reports a successful `check` for the head being merged and
that outstanding feedback has been resolved. Run `git fetch origin main` immediately before the
checks below. Merge only when that head includes the current base
(`git merge-base --is-ancestor origin/main <head>`), or when all of these hold:

- The base's new commits change none of the pull request's files. With
  `mb=$(git merge-base origin/main <head>)`, the lists from
  `git diff --no-renames --name-only "$mb" <head>` and
  `git diff --no-renames --name-only "$mb" origin/main` share no path.
- The pull request merges into the current base without conflicts (`gh pr view --json mergeable`
  reports `MERGEABLE`; `UNKNOWN` means wait).
- If the pull request changes an input of the iOS simulator check (the paths in
  `.github/scripts/requires-ios-check.sh` on either the head or `origin/main`), the base's new
  commits change none of those inputs. The run on `main` doesn't repeat the iOS check.
- Neither side changes `frozen-paths.json` or any file under the paths it lists.

Otherwise, bring the head up to date and wait for `check` again.

Each push to `main` runs the Release workflow's `check` (shown as `check / check`) on the merged
commit, and deploys wait for it. Before merging, find the newest commit on `main` whose `check`
has finished; it must have succeeded, and a cancelled run counts as unfinished. If it failed,
merge only the fix or revert for that failure. The author of the change that broke it owns that
fix. Tag App Store releases, dispatch updates and deploy the sync Worker only from a `main`
commit whose `check` passed.

Re-review substantive changes made after approval. Changes to the review gates and merge
automation require explicit maintainer approval of the final change. Keep protected branches
free of direct pushes and bypasses.

## Changes that need additional review

- **Authentication and authorization** need a focused review of the trust boundary, denied-access
  tests, including cross-account access where applicable, and a way to disable or roll back the
  new behavior.
- **Personal data** changes need a focused review of ownership, unintended exposure, deletion,
  retries, and error recovery.
- **Storage, sync, imports, and MCP writes** follow the
  [data compatibility standard](data-compatibility.md). Storage upgrades need realistic prior
  data, preserved meaning, recovery evidence, and passing compatibility tests.
- **Deploy and credential changes** need evidence that fork PRs run without release credentials
  and that the protected release job only publishes the reviewed revision.
