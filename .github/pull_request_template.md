## Change

Describe the problem, the expected outcome, and the scope of this PR. Link the issue if there is one.

## Validation

List the commands you ran and their results. Describe the regression case you checked. For data,
security, or deployment changes, include the applicable compatibility or trust-boundary evidence.

## Risk and recovery

Classify this as routine, elevated, or a change to the merge rules. Explain how to revert or
recover and what recovery was tested.

## Review

Record the reviewer, reviewed commit, findings and dispositions. Note any changes after review.
Before merging, verify a passing `check` on the final head, resolved feedback, and that the newest
finished `check` on `main` passed (unless this PR fixes or reverts that failure). The head must
include the current base or meet every condition in `docs/review-and-merge.md`; otherwise update it
and wait for `check` again.
