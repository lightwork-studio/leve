#!/usr/bin/env bash
set -euo pipefail

# Print whether a release job has its credentials: true when every named variable is set, false
# when none is (a fork or a repository without release secrets). Fail when only some are set,
# since that is a broken setup that should not pass as a skipped deploy.
if [ "$#" -eq 0 ]; then
  echo "Name the credential variables to check." >&2
  exit 2
fi

missing=()
for name in "$@"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -eq 0 ]; then
  printf 'true\n'
elif [ "${#missing[@]}" -eq "$#" ]; then
  printf 'false\n'
else
  echo "Missing release credentials: ${missing[*]}" >&2
  exit 1
fi
