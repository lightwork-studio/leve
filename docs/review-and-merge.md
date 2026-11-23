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

Before a squash merge, verify that the reviewed head includes the current base, CI reports a
successful `check` for that revision, and outstanding feedback has been resolved. Re-review
substantive changes made after approval. Changes to the review gates and merge
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
